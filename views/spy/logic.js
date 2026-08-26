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

export function pickLocation(locations, rng = Math.random) {
    if (!Array.isArray(locations) || locations.length === 0) return '';
    return locations[Math.floor(rng() * locations.length)];
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
export function pollDelay({ status, hidden, failures }) {
    if (failures > 0) return Math.min(10000, 800 * 2 ** failures);
    if (hidden) return 4000;
    if (status === 'round') return 3000;
    if (status === 'debrief') return 2500;
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
 * The right word for "spy" in a sentence that counts them. Slovene needs the
 * accusative here ("razkrinkaj vohuna"), so the choice lives in the table as
 * two rows rather than as an -s the page appends.
 */
export function spyWord(t, count) {
    return count > 1 ? t('word.spies') : t('word.spy');
}
