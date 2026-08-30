// SPY // CLASSIFIED - DOM-free decision logic.
//
// Everything script.js needs to think without a browser: player/spy limits,
// the role deal, the clock format, room codes and names, the room event
// reducer and poll pacing. Both gamemodes import from here (the one-phone
// game deals through dealRoles too), and node --test tests/ exercises it
// directly.

// ------------------------------------------------------------------
//  Table limits
// ------------------------------------------------------------------

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 20;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Spies never outnumber the citizens, so at most half the table. */
export const spyMax = (players) => Math.max(1, Math.floor(players / 2));

export const suggestedSpies = (players) =>
    clamp(Math.round(players / 4), 1, spyMax(players));

/**
 * How many names one ballot carries. The table is hunting `spies` of them, so
 * it accuses that many, and the agents only win by putting every spy in the
 * top n. Capped at the number of people a voter can actually name (everyone
 * but themselves), because players walking out mid-vote must not leave a room
 * whose ballots can never be completed. Mirrors picksNeeded() in
 * spy-controller.php: change them in both.
 */
export function picksNeeded(spies, seated) {
    const n = Math.max(1, Math.floor(Number(spies) || 1));
    const others = Math.max(1, Math.floor(Number(seated) || 0) - 1);
    return Math.min(n, others);
}

// ------------------------------------------------------------------
//  The clock
// ------------------------------------------------------------------

// Mirrors MIN_ROUND_SECONDS / MAX_ROUND_SECONDS in spy-controller.php:
// change them in both.
export const MIN_ROUND_SECONDS = 60;
export const MAX_ROUND_SECONDS = 1800;
export const ROUND_STEP_SECONDS = 60;

export function clampRoundSeconds(seconds) {
    const raw = Number(seconds);
    if (!Number.isFinite(raw)) return MIN_ROUND_SECONDS;
    const n = Math.round(raw / ROUND_STEP_SECONDS) * ROUND_STEP_SECONDS;
    return clamp(n, MIN_ROUND_SECONDS, MAX_ROUND_SECONDS);
}

/** One minute per player, the rule the one-phone game has always used. */
export const defaultRoundSeconds = (players) => clampRoundSeconds(players * 60);

export function formatClock(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------------
//  The deal
// ------------------------------------------------------------------

/**
 * Picks which of `count` seats are spies. Fisher-Yates over the indexes,
 * take the first `spies`, then sort so the returned list leaks nothing about
 * the shuffle order. `rng` is injectable so tests can pin the outcome.
 */
export function dealRoles(count, spies, rng = Math.random) {
    const n = Math.max(0, Math.floor(count));
    const wanted = clamp(Math.floor(spies), 0, n);
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return idx.slice(0, wanted).sort((a, b) => a - b);
}

/**
 * A location this table has not played yet, plus the deck to remember for
 * next time. Repeats are the one thing that makes a second round feel like a
 * rerun, so the draw is from what is LEFT rather than from the whole list.
 * When the deck runs out it reshuffles minus the place just played, so a
 * party longer than the table can neither repeat nor dead-end. Mirrors
 * dealLocation() in spy-controller.php: change them in both.
 */
export function pickUnusedLocation(locations, used = [], rng = Math.random) {
    const keys = (Array.isArray(locations) ? locations : [])
        .map((row) => row?.key)
        .filter((key) => typeof key === 'string' && key !== '');
    if (keys.length === 0) return { key: '', used: [] };

    // Drop places since retired from the table, so a deck holding a key that no
    // longer exists cannot make `last` point at nothing and re-allow the place
    // actually just played. dealLocation() in the controller does the same.
    const known = new Set(keys);
    const played = used.filter((key) => known.has(key));

    const seen = new Set(played);
    let pool = keys.filter((key) => !seen.has(key));
    let history = [...played];
    if (pool.length === 0) {
        // Deck exhausted. Reshuffle, but never straight back onto the place
        // this table has just walked out of.
        const last = played[played.length - 1];
        pool = keys.filter((key) => key !== last);
        if (pool.length === 0) pool = [...keys]; // a one-place deck has no choice
        history = [];
    }

    const key = pool[Math.floor(rng() * pool.length)];
    history.push(key);
    return { key, used: history };
}

// ------------------------------------------------------------------
//  Room codes and names (mirror the validators in spy-controller.php)
// ------------------------------------------------------------------

export function normalizeCode(raw) {
    return String(raw ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}

export function isValidCode(code) {
    return /^[A-Z]{4}$/.test(code ?? '');
}

export function cleanName(raw) {
    return String(raw ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function isValidName(raw) {
    const n = Array.from(cleanName(raw)).length;
    return n >= 1 && n <= 20;
}

// ------------------------------------------------------------------
//  The room reducer: poll events in, UI edges out
// ------------------------------------------------------------------

export function createRoomModel() {
    return { status: 'lobby', lastSeq: 0 };
}

/**
 * Folds one page of poll events into the model and returns the edges the UI
 * has to act on: {op:'deal'|'start'|'end'|'again'|'pause'|'resume'} and
 * {op:'host', id, mine}. Phase-carrying ops also move model.status, but the
 * poll snapshot overrides it afterwards, which is what makes a resume that
 * missed these events land on the right screen anyway.
 *
 * Events of unknown type are ignored (a newer server may speak more of them)
 * while the cursor still advances past everything, so an old client never
 * desyncs or spins.
 */
export function applyEvents(model, events, selfId) {
    const ops = [];
    for (const ev of events ?? []) {
        model.lastSeq = Math.max(model.lastSeq, ev.seq);
        switch (ev.type) {
            case 'deal':
                model.status = 'brief';
                ops.push({ op: 'deal' });
                break;
            case 'start':
                model.status = 'round';
                ops.push({ op: 'start' });
                break;
            case 'end':
                // Questioning is over; the ballot opens. The verdict is a
                // separate event, because the room sits in 'vote' until the
                // last ballot is in.
                model.status = 'vote';
                ops.push({ op: 'end' });
                break;
            case 'verdict':
                model.status = 'debrief';
                ops.push({ op: 'verdict' });
                break;
            case 'reveal':
                // The host has called the round, which is what declassifies
                // the dossier. No phase moves: the room was already in the
                // debrief, watching the accused defend themselves.
                ops.push({ op: 'reveal', outcome: ev.data?.outcome ?? null });
                break;
            case 'again':
                model.status = 'lobby';
                ops.push({ op: 'again' });
                break;
            case 'pause':
                ops.push({ op: 'pause' });
                break;
            case 'resume':
                ops.push({ op: 'resume' });
                break;
            case 'host':
                ops.push({ op: 'host', id: ev.data?.id ?? null, mine: ev.data?.id === selfId });
                break;
            // 'ready', 'settings', 'callvote' and 'castvote' need no edge:
            // the poll snapshot already carries every tally they move.
        }
    }
    return ops;
}

// ------------------------------------------------------------------
//  Poll pacing
// ------------------------------------------------------------------

/**
 * How long to wait before the next poll. Spy has no ink flying and up to
 * twenty phones on one room, so this is deliberately lazier than the
 * parlour's: during a round the clock ticks locally between polls and only a
 * pause or an early end has to arrive quickly, while the lobby and the
 * briefing need live joiner and ready counts.
 */
export function pollDelay({ status, hidden, failures, grace, revealed }) {
    if (failures > 0) return Math.min(10000, 800 * 2 ** failures);
    // The vote's grace countdown is the one moment a phone has to keep up
    // with a deadline it cannot see coming: a ballot changed on somebody
    // else's phone restarts it, so the number on screen can go UP. A hidden
    // tab still wants the verdict, so this deliberately beats that check.
    // Note this is NOT bounded by VOTE_GRACE_SECONDS: a table that keeps
    // switching keeps re-arming, and the host's CLOSE THE VOTE is what ends
    // that rather than the clock.
    if (grace) return 700;
    if (hidden) return 4000;
    if (status === 'round') return 3000;
    // A debrief nobody has called yet is a waiting room: every phone is
    // watching for the host's verdict, and it must land like a light coming
    // on rather than a couple of seconds after the room reacts out loud.
    // Once it has, the screen is finished and can go back to idling.
    if (status === 'debrief') return revealed ? 2500 : 1200;
    // The lobby, the briefing and the ballot all show a live count of who
    // has acted, so they are the phases worth watching closely.
    return 1200;
}

// ------------------------------------------------------------------
//  The call to vote
// ------------------------------------------------------------------

/**
 * How many players must ask to stop questioning before the ballot opens.
 * A simple majority. Mirrors endVoteThreshold() in spy-controller.php:
 * change them in both.
 */
export function endVoteThreshold(seated) {
    return Math.max(1, Math.floor(seated / 2) + 1);
}

/**
 * How long the ballot stays open after the last seated player has voted. The
 * vote does not shut the instant somebody's tap lands, because the person who
 * happens to vote last would be the one player who could never change their
 * mind. Any ballot cast while it runs restarts it. Mirrors
 * VOTE_GRACE_SECONDS in spy-controller.php: change them in both.
 */
export const VOTE_GRACE_SECONDS = 5;

// ------------------------------------------------------------------
//  Translation
// ------------------------------------------------------------------
//
// Both i18n tables are shaped the same way: one row per concept, one column
// per language. That is the whole system. Adding Croatian means adding a
// "hr" column to every row and listing it in `languages`; adding a word
// means adding a row. Nothing here knows which languages exist.

export const DEFAULT_LANG = 'en';

/** Fills {name} placeholders from a plain object. Unknown ones are left be. */
export function fillTemplate(text, vars) {
    if (!vars) return text;
    return String(text).replace(/\{(\w+)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole);
}

/**
 * One string from a table, in the requested language. Falls back to English
 * and then to the key itself, so a language that is only half filled in
 * still renders something a person can act on rather than a blank control.
 */
export function resolveString(table, lang, key, vars) {
    const row = table?.strings?.[key];
    if (!row) return key;
    // An empty column counts as "not translated yet", so it falls through to
    // English rather than showing a blank control.
    const pick = (code) => (typeof row[code] === 'string' && row[code] !== '' ? row[code] : null);
    const text = pick(lang) ?? pick(DEFAULT_LANG);
    return text === null ? key : fillTemplate(text, vars);
}

/**
 * Whether a table can actually say this key at all. `resolveString` answers a
 * row it does not have with the key itself, which is the right answer for a
 * caller that has English in its markup to fall back on and the wrong one for
 * a caller writing text from nothing: that one prints "vote.grace" at a
 * player. Ask this first and substitute something language-neutral instead.
 */
export function hasString(table, key) {
    return Boolean(table?.strings?.[key]);
}

/** Binds a table and a language into the `t(key, vars)` the page calls. */
export function createTranslator(table, lang) {
    return (key, vars) => resolveString(table, lang, key, vars);
}

/** The languages a table declares, always with English first and present. */
export function tableLanguages(table) {
    const list = Array.isArray(table?.languages) ? table.languages.filter((l) => typeof l === 'string') : [];
    return list.length > 0 ? list : [DEFAULT_LANG];
}

/** Anything unrecognised becomes English, matching validateLang() in PHP. */
export function normalizeLang(raw, table) {
    const lang = String(raw ?? '').trim().toLowerCase();
    return tableLanguages(table).includes(lang) ? lang : DEFAULT_LANG;
}

/**
 * Which plural form a count takes, by the CLDR rules for Slovene, which are
 * the widest the tables have to serve: singular, dual, a 3-4 form, and a
 * genitive-plural everything-else. English needs only two of the four, so it
 * fills `one` with the singular and the other three with the plural and the
 * same row set answers both languages.
 *
 * Counting past a hundred goes by the last two digits (101 agents is one
 * agent's worth of grammar), which is why this is a % 100. That same rule is
 * applied to English, where it is wrong: 101 would pick the `one` row and
 * render "101 spy". Nothing here can reach it (MAX_PLAYERS is 20 and every
 * count is derived from that), so do not wire this to an uncapped number
 * without giving English its own two-way rule first.
 */
export function pluralCategory(n) {
    const i = Math.abs(Math.trunc(Number(n) || 0)) % 100;
    if (i === 1) return 'one';
    if (i === 2) return 'two';
    if (i === 3 || i === 4) return 'few';
    return 'other';
}

/**
 * One row of a counted set, e.g. pluralString(t, ui, 'count.spy', 2) -> the
 * `count.spy.two` row. Whole sentences are looked up the same way when the
 * grammar reaches past the noun: Slovene has to agree the verb of a trailing
 * clause with the count too, so "smoke out the spy who cannot" is four rows
 * rather than a noun dropped into one.
 *
 * These are written into elements that start EMPTY, so a table too old to
 * carry the row would print "count.spy.two" at a player. Falling through the
 * other forms first is wrong grammar at worst, which is a great deal better
 * than a key, and only ever happens to a tab left open across a deploy.
 */
export function pluralString(t, table, base, n, vars) {
    for (const key of [`${base}.${pluralCategory(n)}`, `${base}.other`, `${base}.one`]) {
        if (hasString(table, key)) return t(key, vars);
    }
    return '';
}
