// Unit tests for the Spy game's decision logic (views/spy/logic.js).
// Run: node --test tests/     (Windows: node --test "tests/**/*.test.mjs")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    MIN_PLAYERS, MAX_PLAYERS, MIN_ROUND_SECONDS, MAX_ROUND_SECONDS, ROUND_STEP_SECONDS,
    clamp, spyMax, suggestedSpies,
    clampRoundSeconds, defaultRoundSeconds, formatClock,
    picksNeeded, dealRoles, pickUnusedLocation,
    normalizeCode, isValidCode, cleanName, isValidName,
    createRoomModel, applyEvents, pollDelay, endVoteThreshold, VOTE_GRACE_SECONDS,
    DEFAULT_LANG, fillTemplate, resolveString, createTranslator,
    tableLanguages, normalizeLang, pluralCategory, pluralString, hasString,
} from '../views/spy/logic.js';

// ------------------------------------------------------------------
//  Table limits
// ------------------------------------------------------------------

test('spyMax never lets the spies reach half the table', () => {
    assert.equal(spyMax(3), 1);
    assert.equal(spyMax(4), 2);
    assert.equal(spyMax(5), 2);
    assert.equal(spyMax(20), 10);
    // Degenerate tables still offer one spy rather than zero.
    assert.equal(spyMax(1), 1);
});

test('suggestedSpies stays inside the max it suggests against', () => {
    assert.equal(suggestedSpies(3), 1);
    assert.equal(suggestedSpies(5), 1);
    assert.equal(suggestedSpies(8), 2);
    assert.equal(suggestedSpies(20), 5);
    for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
        const s = suggestedSpies(n);
        assert.ok(s >= 1 && s <= spyMax(n), `suggestion ${s} out of range for ${n}`);
    }
});

test('picksNeeded gives the ballot one name per spy, capped at the table', () => {
    assert.equal(picksNeeded(1, 5), 1);
    assert.equal(picksNeeded(2, 5), 2);
    assert.equal(picksNeeded(3, 7), 3);
    // Nobody can accuse themselves, so a shrinking room caps the ballot at the
    // number of other people left. Without this a vote that loses players can
    // never be completed and the room hangs in the ballot phase.
    assert.equal(picksNeeded(3, 3), 2);
    assert.equal(picksNeeded(2, 2), 1);
    assert.equal(picksNeeded(2, 1), 1, 'never asks for zero names');
    assert.equal(picksNeeded(0, 5), 1);
});

test('clamp holds the ends', () => {
    assert.equal(clamp(5, 1, 3), 3);
    assert.equal(clamp(0, 1, 3), 1);
    assert.equal(clamp(2, 1, 3), 2);
});

// ------------------------------------------------------------------
//  The clock
// ------------------------------------------------------------------

test('clampRoundSeconds snaps to whole minutes inside the bounds', () => {
    assert.equal(clampRoundSeconds(300), 300);
    assert.equal(clampRoundSeconds(310), 300);  // rounds to the nearest minute
    assert.equal(clampRoundSeconds(331), 360);
    assert.equal(clampRoundSeconds(0), MIN_ROUND_SECONDS);
    assert.equal(clampRoundSeconds(99999), MAX_ROUND_SECONDS);
    assert.equal(clampRoundSeconds('nonsense'), MIN_ROUND_SECONDS);
    assert.equal(clampRoundSeconds(null), MIN_ROUND_SECONDS);
});

test('defaultRoundSeconds is a minute per player, still bounded', () => {
    assert.equal(defaultRoundSeconds(5), 300);
    assert.equal(defaultRoundSeconds(3), 180);
    assert.equal(defaultRoundSeconds(20), 1200);
});

test('formatClock always reads mm:ss and never goes negative', () => {
    assert.equal(formatClock(300), '05:00');
    assert.equal(formatClock(59), '00:59');
    assert.equal(formatClock(0), '00:00');
    assert.equal(formatClock(-7), '00:00');
    assert.equal(formatClock(1800), '30:00');
    assert.equal(formatClock(undefined), '00:00');
});

// ------------------------------------------------------------------
//  The deal
// ------------------------------------------------------------------

test('dealRoles picks exactly the requested number of distinct seats', () => {
    for (let players = MIN_PLAYERS; players <= MAX_PLAYERS; players++) {
        const spies = spyMax(players);
        const picked = dealRoles(players, spies);
        assert.equal(picked.length, spies);
        assert.equal(new Set(picked).size, spies, 'no seat is dealt twice');
        assert.ok(picked.every((i) => i >= 0 && i < players), 'every seat exists');
    }
});

test('dealRoles returns the seats in ascending order, leaking no shuffle', () => {
    // A hand-rolled rng makes the shuffle deterministic.
    let n = 0;
    const rng = () => [0.9, 0.1, 0.7, 0.3, 0.5][n++ % 5];
    const picked = dealRoles(6, 3, rng);
    assert.deepEqual([...picked].sort((a, b) => a - b), picked);
});

test('dealRoles copes with degenerate asks', () => {
    assert.deepEqual(dealRoles(0, 1), []);
    assert.deepEqual(dealRoles(3, 0), []);
    assert.equal(dealRoles(3, 99).length, 3); // cannot deal more spies than seats
});

const DECK = [{ key: 'beach' }, { key: 'casino' }, { key: 'farm' }];

test('pickUnusedLocation stays inside the list and survives an empty one', () => {
    assert.deepEqual(pickUnusedLocation(DECK, [], () => 0), { key: 'beach', used: ['beach'] });
    assert.deepEqual(pickUnusedLocation(DECK, [], () => 0.99), { key: 'farm', used: ['farm'] });
    assert.deepEqual(pickUnusedLocation([], [], () => 0), { key: '', used: [] });
    assert.deepEqual(pickUnusedLocation(null, [], () => 0), { key: '', used: [] });
});

test('pickUnusedLocation never repeats a place the room has already played', () => {
    // The whole point: the draw is from what is LEFT, so a party works its way
    // through the deck instead of landing on the same place twice.
    let used = [];
    const seen = [];
    for (let i = 0; i < DECK.length; i++) {
        const drawn = pickUnusedLocation(DECK, used, () => 0); // always the first left
        seen.push(drawn.key);
        used = drawn.used;
    }
    assert.deepEqual(seen, ['beach', 'casino', 'farm']);
    assert.deepEqual(new Set(seen).size, DECK.length, 'no repeats inside one pass');
});

test('an exhausted deck reshuffles without landing back on the last place', () => {
    const spent = ['beach', 'casino', 'farm'];
    // Every rng value, so this asserts the property rather than one draw.
    for (const r of [0, 0.34, 0.5, 0.67, 0.99]) {
        const drawn = pickUnusedLocation(DECK, spent, () => r);
        assert.notEqual(drawn.key, 'farm', 'never straight back onto the place just played');
        assert.deepEqual(drawn.used, [drawn.key], 'the deck starts over');
    }
    // A one-place deck has no choice and must still answer rather than hang.
    const only = pickUnusedLocation([{ key: 'beach' }], ['beach'], () => 0);
    assert.equal(only.key, 'beach');
});

// ------------------------------------------------------------------
//  Codes and names (these mirror the PHP validators)
// ------------------------------------------------------------------

test('normalizeCode forgives anything a player might type', () => {
    assert.equal(normalizeCode(' bxkz '), 'BXKZ');
    assert.equal(normalizeCode('b-x k.z'), 'BXKZ');
    assert.equal(normalizeCode('BXKZT'), 'BXKZ'); // overtyped: keep the first four
    assert.equal(normalizeCode('12'), '');
    assert.equal(normalizeCode(null), '');
});

test('isValidCode wants exactly four letters', () => {
    assert.equal(isValidCode('BXKZ'), true);
    assert.equal(isValidCode('BXK'), false);
    assert.equal(isValidCode('BXKZZ'), false);
    assert.equal(isValidCode(null), false);
});

test('cleanName mirrors the server rules', () => {
    const BELL = String.fromCharCode(7);
    const TAB = String.fromCharCode(9);
    assert.equal(cleanName('  Ana   Novak  '), 'Ana Novak');
    assert.equal(cleanName(`Ana${BELL}Novak`), 'AnaNovak', 'control chars are stripped');
    // A tab is a control character, so it is stripped before the whitespace
    // collapse ever sees it. The PHP validator does exactly the same.
    assert.equal(cleanName(`Ana${TAB}Novak`), 'AnaNovak');
    assert.equal(cleanName('Ana  Novak'), 'Ana Novak', 'runs of spaces collapse');
    assert.equal(cleanName(null), '');
});

test('isValidName enforces 1..20 visible characters', () => {
    assert.equal(isValidName('Ana'), true);
    assert.equal(isValidName('   '), false);
    assert.equal(isValidName('a'.repeat(20)), true);
    assert.equal(isValidName('a'.repeat(21)), false);
});

// ------------------------------------------------------------------
//  The room reducer
// ------------------------------------------------------------------

test('applyEvents turns the log into phase edges', () => {
    const model = createRoomModel();
    assert.equal(model.status, 'lobby');

    const ops = applyEvents(model, [
        { seq: 1, player: 7, type: 'deal', data: { players: 4, spies: 1 } },
        { seq: 2, player: 8, type: 'ready', data: null },
        { seq: 3, player: 7, type: 'start', data: null },
    ], 8);

    assert.deepEqual(ops, [{ op: 'deal' }, { op: 'start' }]);
    assert.equal(model.status, 'round');
    assert.equal(model.lastSeq, 3, 'the ready event still moved the cursor');
});

test('applyEvents walks a whole game back to the lobby', () => {
    const model = createRoomModel();
    const ops = applyEvents(model, [
        { seq: 10, player: 1, type: 'deal', data: null },
        { seq: 11, player: 1, type: 'start', data: null },
        { seq: 12, player: 1, type: 'pause', data: null },
        { seq: 13, player: 1, type: 'resume', data: null },
        { seq: 14, player: 2, type: 'callvote', data: null },
        { seq: 15, player: null, type: 'end', data: null },
        { seq: 16, player: 2, type: 'castvote', data: null },
        { seq: 17, player: null, type: 'verdict', data: null },
        { seq: 18, player: 1, type: 'again', data: null },
    ], 1);

    // callvote and castvote move tallies the snapshot already carries, so
    // they produce no edge of their own.
    assert.deepEqual(ops.map((o) => o.op),
        ['deal', 'start', 'pause', 'resume', 'end', 'verdict', 'again']);
    assert.equal(model.status, 'lobby');
    assert.equal(model.lastSeq, 18);
});

test('questioning ends into the ballot, not straight into the debrief', () => {
    const model = createRoomModel();
    applyEvents(model, [{ seq: 1, player: null, type: 'end', data: null }], 1);
    assert.equal(model.status, 'vote', 'the room sits in the vote until ballots are in');
    applyEvents(model, [{ seq: 2, player: null, type: 'verdict', data: null }], 1);
    assert.equal(model.status, 'debrief');
});

test('applyEvents flags a handover only for the player who inherited it', () => {
    const mine = createRoomModel();
    const [op] = applyEvents(mine, [{ seq: 4, player: null, type: 'host', data: { id: 42 } }], 42);
    assert.deepEqual(op, { op: 'host', id: 42, mine: true });

    const theirs = createRoomModel();
    const [other] = applyEvents(theirs, [{ seq: 4, player: null, type: 'host', data: { id: 42 } }], 9);
    assert.equal(other.mine, false);
});

test('an unknown event type is ignored but still advances the cursor', () => {
    // Forward compatibility: an older client must not desync or spin when a
    // newer server speaks an event it has never heard of.
    const model = createRoomModel();
    const ops = applyEvents(model, [
        { seq: 30, player: 1, type: 'accusation', data: { who: 3 } },
        { seq: 31, player: 1, type: 'start', data: null },
    ], 1);

    assert.deepEqual(ops, [{ op: 'start' }]);
    assert.equal(model.lastSeq, 31);
});

test('applyEvents survives an empty or missing page', () => {
    const model = createRoomModel();
    assert.deepEqual(applyEvents(model, [], 1), []);
    assert.deepEqual(applyEvents(model, undefined, 1), []);
    assert.equal(model.lastSeq, 0);
});

// ------------------------------------------------------------------
//  Poll pacing
// ------------------------------------------------------------------

test('pollDelay backs off on failure before anything else', () => {
    assert.equal(pollDelay({ status: 'lobby', hidden: false, failures: 1 }), 1600);
    assert.equal(pollDelay({ status: 'round', hidden: true, failures: 3 }), 6400);
    assert.equal(pollDelay({ status: 'lobby', hidden: false, failures: 9 }), 10000, 'capped');
});

test('pollDelay keeps up with the vote countdown, but never over a back-off', () => {
    // The grace countdown is the one deadline a phone cannot see coming: a
    // ballot changed on somebody else's phone restarts it.
    assert.equal(pollDelay({ status: 'vote', hidden: false, failures: 0, grace: true }), 700);
    // Even a hidden tab wants the verdict; the countdown is only seconds long.
    assert.equal(pollDelay({ status: 'vote', hidden: true, failures: 0, grace: true }), 700);
    // A server we cannot reach is not helped by asking it faster.
    assert.equal(pollDelay({ status: 'vote', hidden: false, failures: 2, grace: true }), 3200);
    // No countdown armed yet: the ballot polls at the ordinary live rate.
    assert.equal(pollDelay({ status: 'vote', hidden: false, failures: 0 }), 1200);
});

test('pollDelay eases off for hidden tabs and running rounds', () => {
    assert.equal(pollDelay({ status: 'round', hidden: true, failures: 0 }), 4000);
    // The clock ticks locally during a round, so only a pause or an early
    // end has to arrive quickly.
    assert.equal(pollDelay({ status: 'round', hidden: false, failures: 0 }), 3000);
    assert.equal(pollDelay({ status: 'debrief', hidden: false, failures: 0, revealed: true }), 2500);
    // A debrief the host has not called yet is a waiting room: every phone is
    // watching for a verdict that lands on all of them at once.
    assert.equal(pollDelay({ status: 'debrief', hidden: false, failures: 0 }), 1200);
    // The lobby and the briefing show live joiner and ready counts.
    assert.equal(pollDelay({ status: 'lobby', hidden: false, failures: 0 }), 1200);
    assert.equal(pollDelay({ status: 'brief', hidden: false, failures: 0 }), 1200);
});

// ------------------------------------------------------------------
//  The call to vote
// ------------------------------------------------------------------

test('the vote leaves a grace period long enough to change your mind in', () => {
    // Whoever votes last would otherwise be the one player who could never
    // switch, since their own ballot closed the room.
    assert.ok(VOTE_GRACE_SECONDS >= 5, 'too short to actually reach for the phone');
    assert.ok(VOTE_GRACE_SECONDS <= 30, 'long enough to stall the table');
});

test('hasString tells a caller with no markup fallback that the table is short', () => {
    // resolveString answers a missing row with the key itself, which is right
    // for the page's [data-i18n] elements (they keep the English in the
    // markup) and wrong for text JS writes from nothing. A phone that loaded
    // the page before a row was added holds that older table in memory for as
    // long as the tab is open, so this is not hypothetical.
    const stale = { languages: ['en'], strings: { 'vote.waiting': { en: '// WAITING' } } };
    assert.equal(hasString(stale, 'vote.waiting'), true);
    assert.equal(hasString(stale, 'vote.grace'), false, 'the row this tab has never heard of');
    assert.equal(resolveString(stale, 'en', 'vote.grace', { n: 4 }), 'vote.grace',
        'and resolving it anyway is what printed a key at players');
    // A table that failed to load at all is the same answer, not a crash.
    assert.equal(hasString(null, 'vote.grace'), false);
    assert.equal(hasString(undefined, 'vote.grace'), false);
    assert.equal(hasString({}, 'vote.grace'), false);
});

test('the constants duplicated into spy-controller.php still agree with it', () => {
    // views/spy/CLAUDE.md says these live in two places and must be changed in
    // both. A comment cannot enforce that, so read the PHP and compare: a
    // client clamping a round to different bounds than the server, or drawing
    // a countdown of a different length, is a silent desync nothing else
    // catches.
    const php = readFileSync(new URL('../app/controllers/spy-controller.php', import.meta.url), 'utf8');
    const constant = (name) => {
        const m = php.match(new RegExp(`^const\\s+${name}\\s*=\\s*(\\d+)\\s*;`, 'm'));
        assert.ok(m, `spy-controller.php no longer declares ${name}`);
        return Number(m[1]);
    };
    assert.equal(constant('MIN_ROUND_SECONDS'), MIN_ROUND_SECONDS);
    assert.equal(constant('MAX_ROUND_SECONDS'), MAX_ROUND_SECONDS);
    assert.equal(constant('ROUND_STEP_SECONDS'), ROUND_STEP_SECONDS);
    assert.equal(constant('VOTE_GRACE_SECONDS'), VOTE_GRACE_SECONDS);
    assert.equal(constant('MIN_PLAYERS'), MIN_PLAYERS);
    assert.equal(constant('ROOM_CAP'), MAX_PLAYERS);
});

test('endVoteThreshold is a simple majority of the seated players', () => {
    assert.equal(endVoteThreshold(3), 2);
    assert.equal(endVoteThreshold(4), 3);
    assert.equal(endVoteThreshold(5), 3);
    assert.equal(endVoteThreshold(6), 4);
    assert.equal(endVoteThreshold(20), 11);
    // A lone player can still end their own round rather than being stuck.
    assert.equal(endVoteThreshold(1), 1);
    assert.equal(endVoteThreshold(0), 1);
});

// ------------------------------------------------------------------
//  Translation
// ------------------------------------------------------------------

const TABLE = {
    languages: ['en', 'sl'],
    strings: {
        'greet':    { en: 'HELLO {name}', sl: 'ZDRAVO {name}' },
        'plain':    { en: 'PLAIN', sl: 'PREPROSTO' },
        'englishOnly': { en: 'NOT TRANSLATED YET' },
        'blank':    { en: 'FINE', sl: '' },
    },
};

test('fillTemplate substitutes only what it is given', () => {
    assert.equal(fillTemplate('a {x} b {y}', { x: 1, y: 2 }), 'a 1 b 2');
    assert.equal(fillTemplate('{x} and {missing}', { x: 'one' }), 'one and {missing}');
    assert.equal(fillTemplate('nothing', null), 'nothing');
    assert.equal(fillTemplate('{n} left', { n: 0 }), '0 left', 'zero is a value, not absent');
});

test('resolveString reads the requested language', () => {
    assert.equal(resolveString(TABLE, 'sl', 'plain'), 'PREPROSTO');
    assert.equal(resolveString(TABLE, 'en', 'plain'), 'PLAIN');
    assert.equal(resolveString(TABLE, 'sl', 'greet', { name: 'ANA' }), 'ZDRAVO ANA');
});

test('a language that is only half filled in falls back rather than blanking', () => {
    // The whole point: adding a language should never be able to produce an
    // empty button, only an untranslated one.
    assert.equal(resolveString(TABLE, 'sl', 'englishOnly'), 'NOT TRANSLATED YET');
    assert.equal(resolveString(TABLE, 'sl', 'blank'), 'FINE', 'an empty column is not a translation');
    assert.equal(resolveString(TABLE, 'sl', 'noSuchKey'), 'noSuchKey', 'a missing row shows its key');
    assert.equal(resolveString(null, 'sl', 'plain'), 'plain', 'a missing table never throws');
});

test('createTranslator binds a table and a language', () => {
    const t = createTranslator(TABLE, 'sl');
    assert.equal(t('plain'), 'PREPROSTO');
    assert.equal(t('greet', { name: 'BOR' }), 'ZDRAVO BOR');
});

test('tableLanguages and normalizeLang mirror the PHP validator', () => {
    assert.deepEqual(tableLanguages(TABLE), ['en', 'sl']);
    assert.deepEqual(tableLanguages(null), [DEFAULT_LANG]);
    assert.equal(normalizeLang('SL', TABLE), 'sl');
    assert.equal(normalizeLang('  sl  ', TABLE), 'sl');
    assert.equal(normalizeLang('de', TABLE), 'en', 'an unknown language is English');
    assert.equal(normalizeLang(null, TABLE), 'en');
});

test('pluralCategory follows the Slovene rules, which are the widest we serve', () => {
    assert.equal(pluralCategory(1), 'one');
    assert.equal(pluralCategory(2), 'two');
    assert.equal(pluralCategory(3), 'few');
    assert.equal(pluralCategory(4), 'few');
    assert.equal(pluralCategory(5), 'other');
    assert.equal(pluralCategory(0), 'other');
    // Past a hundred the grammar goes by the last two digits.
    assert.equal(pluralCategory(101), 'one');
    assert.equal(pluralCategory(102), 'two');
    assert.equal(pluralCategory(100), 'other');
    assert.equal(pluralCategory(null), 'other');
});

test('pluralString picks the counted form from the table, not an appended s', () => {
    // Slovene needs four forms of "spy" where English needs two, so the table
    // carries them and nothing in the page appends anything.
    const table = {
        languages: ['en', 'sl'],
        strings: {
            'word.spy.one':   { en: 'spy', sl: 'vohun' },
            'word.spy.two':   { en: 'spies', sl: 'vohuna' },
            'word.spy.few':   { en: 'spies', sl: 'vohuni' },
            'word.spy.other': { en: 'spies', sl: 'vohunov' },
        },
    };
    const sl = createTranslator(table, 'sl');
    assert.equal(pluralString(sl, table, 'word.spy', 1), 'vohun');
    assert.equal(pluralString(sl, table, 'word.spy', 2), 'vohuna');
    assert.equal(pluralString(sl, table, 'word.spy', 3), 'vohuni');
    assert.equal(pluralString(sl, table, 'word.spy', 7), 'vohunov');
    const en = createTranslator(table, 'en');
    assert.equal(pluralString(en, table, 'word.spy', 1), 'spy');
    assert.equal(pluralString(en, table, 'word.spy', 4), 'spies');
});

test('pluralString falls through rather than printing a key at a player', () => {
    // A tab left open across a deploy holds the table it fetched at load, so
    // it can be asked for a form its copy has never heard of. Wrong grammar
    // beats "word.spy.two" on screen; a table with nothing at all stays quiet.
    const partial = { languages: ['en'], strings: { 'word.spy.other': { en: 'spies' } } };
    const t = createTranslator(partial, 'en');
    assert.equal(pluralString(t, partial, 'word.spy', 2), 'spies');
    assert.equal(pluralString(t, partial, 'word.nothing', 2), '');
});

test('pluralString fills its template like any other string', () => {
    const table = {
        languages: ['en'],
        strings: { 'lobby.needMore.two': { en: '> NEED {n} MORE' } },
    };
    const t = createTranslator(table, 'en');
    assert.equal(pluralString(t, table, 'lobby.needMore', 2, { n: 2 }), '> NEED 2 MORE');
});
