// Unit tests for SEAM's decision logic (views/seam/logic.js).
// Run: node --test tests/     (Windows: node --test "tests/**/*.test.mjs")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    COLS, ROWS, EMPTY_BOARD,
    dropRow, cut, isFull, columnFull, findSeam, cave,
    CHARGES, newGame, applyMove, legalMoves,
    normalizeCode, isValidCode, cleanName, isValidName,
    createRoomModel, applyEvents, pollDelay,
    bestMove, DEPTHS,
    DEFAULT_LANG, fillTemplate, resolveString, createTranslator, tableLanguages, normalizeLang,
} from '../views/seam/logic.js';

/** A readable section literal: six rows of seven, surface first. */
const sec = (...rows) => rows.join('');

// ------------------------------------------------------------------
//  The section
// ------------------------------------------------------------------

test('a piece cut into an empty section falls to the basement of its shaft', () => {
    assert.equal(EMPTY_BOARD.length, COLS * ROWS);
    // Row 0 is the surface, row 5 the basement, so the deepest bed wins.
    assert.equal(dropRow(EMPTY_BOARD, 0), ROWS - 1);
    assert.equal(dropRow(EMPTY_BOARD, 3), ROWS - 1);
    assert.equal(dropRow(EMPTY_BOARD, COLS - 1), ROWS - 1);
});

test('pieces stack upward within a shaft, and the seventh cut finds it full', () => {
    let board = EMPTY_BOARD;
    for (let i = 0; i < ROWS; i++) {
        assert.equal(dropRow(board, 2), ROWS - 1 - i, `bed ${i}`);
        board = cut(board, 2, i % 2 === 0 ? '1' : '2');
    }
    assert.equal(dropRow(board, 2), -1);
    assert.equal(columnFull(board, 2), true);
    // The neighbouring shafts are untouched.
    assert.equal(dropRow(board, 1), ROWS - 1);
    assert.equal(columnFull(board, 1), false);
    assert.equal(isFull(board), false);
});

// ------------------------------------------------------------------
//  The seam
// ------------------------------------------------------------------

test('four across the beds is a seam, and it names the four cells it runs through', () => {
    const board = sec(
        '.......',
        '.......',
        '.......',
        '.......',
        '..222..',
        '.1111..',
    );
    assert.deepEqual(findSeam(board, '1'), [36, 37, 38, 39]);
    // Three in a row is not a seam.
    assert.equal(findSeam(board, '2'), null);
});

test('a seam runs down a shaft and along both diagonals too', () => {
    const down = sec('.......', '.......', '..1....', '..1....', '..1....', '..1....');
    assert.deepEqual(findSeam(down, '1'), [16, 23, 30, 37]);

    const downRight = sec('.......', '.2.....', '..2....', '...2...', '....2..', '.......');
    assert.deepEqual(findSeam(downRight, '2'), [8, 16, 24, 32]);

    const downLeft = sec('.......', '....1..', '...1...', '..1....', '.1.....', '.......');
    assert.deepEqual(findSeam(downLeft, '1'), [11, 17, 23, 29]);

    // A run that wraps the row edge is not a seam.
    const wrapped = sec('.......', '.......', '.......', '.......', '.....11', '11.....');
    assert.equal(findSeam(wrapped, '1'), null);
});

// ------------------------------------------------------------------
//  The cave
// ------------------------------------------------------------------

test('a cave cuts the basement bed away and settles the whole section one bed down', () => {
    const board = sec('.......', '.......', '.......', '..1....', '..2.1..', '1122211');
    assert.equal(
        cave(board),
        sec('.......', '.......', '.......', '.......', '..1....', '..2.1..'),
    );
    // The identity the entire mechanic rests on.
    assert.equal(cave(board), '.'.repeat(COLS) + board.slice(0, COLS * (ROWS - 1)));
    // An empty section has nothing to draw.
    assert.equal(cave(EMPTY_BOARD), EMPTY_BOARD);
});

test('a cave leaves an empty shaft empty and never floats a piece', () => {
    const board = sec('.......', '.......', '.......', '.......', '2......', '1....11');
    const after = cave(board);
    assert.equal(after, sec('.......', '.......', '.......', '.......', '.......', '2......'));
    // Every piece still rests on the basement or on another piece.
    for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS - 1; r++) {
            if (after[r * COLS + c] !== '.') {
                assert.notEqual(after[(r + 1) * COLS + c], '.', `floating piece at ${r},${c}`);
            }
        }
    }
});

// ------------------------------------------------------------------
//  A turn
// ------------------------------------------------------------------

test('an ordinary cut lands a piece, spends no permit and passes the turn', () => {
    const before = newGame();
    const move = applyMove(before, 3);

    assert.equal(move.ok, true);
    assert.equal(move.caved, false);
    assert.equal(move.state.board[(ROWS - 1) * COLS + 3], '1');
    assert.deepEqual(move.state.charges, [CHARGES, CHARGES]);
    assert.equal(move.state.turn, 2);
    assert.equal(move.state.outcome, null);

    // State is never mutated in place: the poll snapshot has to stay trustworthy.
    assert.equal(before.board, EMPTY_BOARD);
    assert.equal(before.turn, 1);
});

test('a shaft outside the section is refused', () => {
    const game = newGame();
    for (const col of [-1, COLS, 1.5, null, undefined, '3']) {
        assert.equal(applyMove(game, col).ok, false, `shaft ${col}`);
    }
});

test('cutting into a full shaft draws the bottom, caves the section and lands at the surface', () => {
    const before = {
        ...newGame(),
        board: sec('2......', '1......', '2......', '1......', '2......', '1....22'),
    };
    const move = applyMove(before, 0);

    assert.equal(move.ok, true);
    assert.equal(move.caved, true);
    // The basement bed went, everything settled one down, and the new piece
    // took the surface. Seat 2's pieces in that bed went with it: a cave is
    // never a private weapon.
    assert.equal(
        move.state.board,
        sec('1......', '2......', '1......', '2......', '1......', '2......'),
    );
    assert.deepEqual(move.state.charges, [CHARGES - 1, CHARGES]);
    assert.deepEqual(move.state.cooling, [true, false]);
    assert.equal(move.state.turn, 2);
});

test('a seat with no permits left cannot draw, and a full shaft goes dead to them alone', () => {
    const board = sec('2......', '1......', '2......', '1......', '2......', '1......');
    const spent = { ...newGame(), board, charges: [0, CHARGES] };

    const move = applyMove(spent, 0);
    assert.equal(move.ok, false);
    assert.equal(move.reason, 'noPermit');

    // Permits are per seat: the opponent can still draw that same shaft.
    assert.equal(applyMove({ ...spent, turn: 2 }, 0).ok, true);
});

test('a seat cannot draw on two of its own turns running', () => {
    const board = sec('2......', '1......', '2......', '1......', '2......', '1......');
    const cooling = { ...newGame(), board, cooling: [true, false] };

    const blocked = applyMove(cooling, 0);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'cooling');
    // Cooling costs nothing: the permit is still there for next turn.
    assert.deepEqual(cooling.charges, [CHARGES, CHARGES]);

    // The seat still has ordinary shafts, and taking one clears the cooldown.
    const ordinary = applyMove(cooling, 1);
    assert.equal(ordinary.ok, true);
    assert.deepEqual(ordinary.state.cooling, [false, false]);
    assert.equal(applyMove({ ...ordinary.state, turn: 1 }, 0).ok, true);
});

// ------------------------------------------------------------------
//  Striking, and the risk of striking for someone else
// ------------------------------------------------------------------

test('a cut that completes four ends the game and names the seam it struck', () => {
    const before = {
        ...newGame(),
        board: sec('.......', '.......', '.......', '.......', '.......', '111....'),
    };
    const move = applyMove(before, 3);

    assert.equal(move.ok, true);
    assert.equal(move.state.outcome, 1);
    assert.deepEqual(move.state.seams, [{ seat: 1, cells: [35, 36, 37, 38] }]);
    // A struck section takes no more cuts.
    assert.equal(applyMove(move.state, 4).reason, 'over');
});

// ------------------------------------------------------------------
//  Where a seat may cut
// ------------------------------------------------------------------

/** Filled, 21 pieces each, and no seam anywhere. Found by search, pinned here. */
const FULL_NO_SEAM = sec('1112221', '2221122', '2211222', '1122111', '2211221', '1211211');

test('legalMoves drops the full shafts this seat cannot draw into', () => {
    const board = sec('1......', '2......', '1......', '2......', '1......', '2......');
    const rich = { ...newGame(), board };
    assert.deepEqual(legalMoves(rich), [0, 1, 2, 3, 4, 5, 6]);

    // The permit is what buys the full shaft, and the cooldown is what times it.
    assert.deepEqual(legalMoves({ ...rich, charges: [0, CHARGES] }), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(legalMoves({ ...rich, cooling: [true, false] }), [1, 2, 3, 4, 5, 6]);

    // Both of those are the moving seat's own business.
    assert.deepEqual(legalMoves({ ...rich, turn: 2, charges: [0, CHARGES] }), [0, 1, 2, 3, 4, 5, 6]);
});

test('a struck or settled section offers no moves at all', () => {
    assert.deepEqual(legalMoves({ ...newGame(), outcome: 1 }), []);
    assert.deepEqual(legalMoves({ ...newGame(), board: FULL_NO_SEAM, charges: [0, 0] }), []);
});

test('a seat with nowhere left to cut settles the section as a stalemate', () => {
    // One bed short of full, and neither seat has a permit left to draw with.
    const oneLeft = FULL_NO_SEAM.slice(0, 3) + '.' + FULL_NO_SEAM.slice(4);
    const before = { ...newGame({ starter: 2 }), board: oneLeft, charges: [0, 0] };

    const move = applyMove(before, 3);
    assert.equal(move.ok, true);
    assert.equal(move.state.board, FULL_NO_SEAM);
    assert.deepEqual(move.state.seams, []);
    assert.equal(move.state.outcome, 'draw');
});

// ------------------------------------------------------------------
//  What the whole rule set guarantees
// ------------------------------------------------------------------

test('random play always settles, never caves more than six times, and only the mover strikes', () => {
    let seed = 7;
    const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    for (let game = 0; game < 400; game++) {
        let state = newGame({ starter: (game % 2) + 1 });
        let caves = 0;
        let moves = 0;

        while (state.outcome === null) {
            const options = legalMoves(state);
            assert.notEqual(options.length, 0, 'a live section always offers a shaft');

            const mover = state.turn;
            const move = applyMove(state, options[Math.floor(rng() * options.length)]);
            assert.equal(move.ok, true);
            if (move.caved) caves++;
            state = move.state;
            moves++;

            // 42 beds, plus at most 2 x CHARGES caves clearing 7 beds each.
            assert.ok(moves <= COLS * ROWS + 2 * CHARGES * COLS, `${moves} cuts`);

            // The invariant a cave cannot break: it translates every survivor
            // by the same vector, so the only seat that can strike is the one
            // whose piece just landed.
            assert.ok(state.seams.length <= 1, 'two seams at once is unreachable');
            if (state.outcome !== null && state.outcome !== 'draw') {
                assert.equal(state.outcome, mover, 'a seat struck on someone else\'s turn');
            }
        }
        assert.ok(caves <= 2 * CHARGES, `${caves} caves`);
    }
});

// ------------------------------------------------------------------
//  Room codes and names
// ------------------------------------------------------------------

test('a pasted code is normalised to four uppercase letters', () => {
    assert.equal(normalizeCode(' bxkz '), 'BXKZ');
    assert.equal(normalizeCode('b-x-k-z-q'), 'BXKZ');
    assert.equal(normalizeCode('12b3x4k5z'), 'BXKZ');
    assert.equal(normalizeCode(null), '');
    assert.equal(isValidCode('BXKZ'), true);
    assert.equal(isValidCode('BXK'), false);
    assert.equal(isValidCode('bxkz'), false);
    assert.equal(isValidCode(null), false);
});

test('a name loses its control characters and collapses its runs of space', () => {
    assert.equal(cleanName('  Domen   H  '), 'Domen H');
    assert.equal(cleanName('Do\u0000men'), 'Domen');
    assert.equal(isValidName('D'), true);
    assert.equal(isValidName('   '), false);
    assert.equal(isValidName('x'.repeat(20)), true);
    assert.equal(isValidName('x'.repeat(21)), false);
    // Counted in code points, so an emoji name is one character, not two.
    assert.equal(isValidName('\u{1F5FB}'.repeat(20)), true);
    assert.equal(isValidName('\u{1F5FB}'.repeat(21)), false);
});

// ------------------------------------------------------------------
//  The room reducer: poll events in, UI edges out
// ------------------------------------------------------------------

test('the reducer turns poll events into UI edges and never stalls on an unknown one', () => {
    const model = createRoomModel();
    assert.equal(model.status, 'lobby');

    const ops = applyEvents(model, [
        { seq: 4, type: 'deal' },
        { seq: 5, type: 'move', data: { seat: 1, col: 3, caved: false } },
        { seq: 6, type: 'move', data: { seat: 2, col: 3, caved: true } },
    ], 7);
    assert.equal(model.status, 'play');
    assert.equal(model.lastSeq, 6);
    assert.deepEqual(ops, [
        { op: 'deal' },
        { op: 'move', seat: 1, col: 3, caved: false },
        { op: 'move', seat: 2, col: 3, caved: true },
    ]);

    // A newer server may speak types this client has never heard of: ignore
    // them, but never stop advancing past them or the client spins forever.
    assert.deepEqual(applyEvents(model, [{ seq: 9, type: 'sonar' }], 7), []);
    assert.equal(model.lastSeq, 9);

    assert.deepEqual(
        applyEvents(model, [{ seq: 10, type: 'verdict' }, { seq: 11, type: 'again' }], 7),
        [{ op: 'verdict' }, { op: 'again' }],
    );
    assert.equal(model.status, 'lobby');

    assert.deepEqual(
        applyEvents(model, [{ seq: 12, type: 'host', data: { id: 7 } }], 7),
        [{ op: 'host', id: 7, mine: true }],
    );

    // A match needs two surveyors, so losing one voids the section and puts
    // the room back in the lobby. The plate has to say so.
    assert.deepEqual(applyEvents(model, [{ seq: 13, type: 'abandon' }], 7), [{ op: 'abandon' }]);
    assert.equal(model.status, 'lobby');
    // A missing page of events is not an error.
    assert.deepEqual(applyEvents(model, undefined, 7), []);
});

// ------------------------------------------------------------------
//  Poll pacing
// ------------------------------------------------------------------

test('pollDelay backs off on failure before anything else, then watches the opponent', () => {
    const at = (over) => pollDelay({ status: 'play', hidden: false, failures: 0, waiting: false, ...over });

    // Waiting on the other seat is the only moment the section can change
    // without you; on your own turn nothing moves until you move it.
    assert.equal(at({ waiting: true }), 900);
    assert.equal(at({ waiting: false }), 3000);
    assert.equal(at({ status: 'lobby' }), 1000);
    assert.equal(at({ status: 'over' }), 2500);

    // A hidden tab has nothing to render, even mid-turn.
    assert.equal(at({ hidden: true, waiting: true }), 4000);

    // Back-off wins over every other consideration, and it is capped.
    assert.equal(at({ failures: 1, waiting: true }), 1600);
    assert.equal(at({ failures: 2, waiting: true }), 3200);
    assert.equal(at({ failures: 9, hidden: true, waiting: true }), 10000);
});

// ------------------------------------------------------------------
//  The bot
// ------------------------------------------------------------------

/** Deterministic under test, the way dealRoles is in spy. */
const stubRng = () => 0;

test('the bot takes a seam that is one cut away', () => {
    const board = sec('.......', '.......', '.......', '1......', '1......', '12.....');
    // Three down shaft 0 with the surface bed still open above them.
    assert.equal(bestMove({ ...newGame(), board }, { depth: 1, rng: stubRng }), 0);
});

test('the bot blocks a seam the other seat is one cut away from', () => {
    const board = sec('.......', '.......', '.......', '.2.....', '.2.....', '12.....');
    assert.equal(bestMove({ ...newGame(), board }, { depth: DEPTHS.surveyor, rng: stubRng }), 1);
});

test('the bot spends a permit when the only seam runs through a full shaft', () => {
    const board = sec('...1...', '...1...', '...1...', '...2...', '...2...', '...2...');
    const state = { ...newGame(), board };

    const col = bestMove(state, { depth: DEPTHS.surveyor, rng: stubRng });
    assert.equal(col, 3);

    const move = applyMove(state, col);
    assert.equal(move.caved, true);
    assert.equal(move.state.outcome, 1);
});

test('the bot never names a shaft it is not allowed to cut', () => {
    let seed = 99;
    const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    for (let game = 0; game < 12; game++) {
        let state = newGame({ starter: (game % 2) + 1 });
        while (state.outcome === null) {
            const col = bestMove(state, { depth: DEPTHS.hand, rng });
            assert.ok(legalMoves(state).includes(col), `illegal shaft ${col}`);
            state = applyMove(state, col).state;
        }
    }
});

// ------------------------------------------------------------------
//  The constants that live in two places
// ------------------------------------------------------------------

test('the constants duplicated into seam-controller.php still agree with it', () => {
    // views/seam/CLAUDE.md says these live in two files and must be changed
    // in both. A comment cannot enforce that, so read the PHP and compare.
    const php = readFileSync(new URL('../app/controllers/seam-controller.php', import.meta.url), 'utf8');
    const constant = (name) => {
        const m = php.match(new RegExp(`^const\\s+${name}\\s*=\\s*(\\d+)\\s*;`, 'm'));
        assert.ok(m, `seam-controller.php no longer declares ${name}`);
        return Number(m[1]);
    };

    assert.equal(constant('COLS'), COLS);
    assert.equal(constant('ROWS'), ROWS);
    assert.equal(constant('CHARGES'), CHARGES);
});

test('the rules in seam-controller.php are still the rules in logic.js', () => {
    const php = readFileSync(new URL('../app/controllers/seam-controller.php', import.meta.url), 'utf8');

    // The cave is the whole twist, and it is the one line most likely to be
    // "tidied" into something subtly different on one side only.
    assert.match(
        php,
        /str_repeat\('\.', COLS\) \. substr\(\$board, 0, COLS \* \(ROWS - 1\)\)/,
        'caveBoard() no longer cuts exactly one basement bed',
    );
    // Both halves of the anti-spam rule must still be refusals, not warnings.
    assert.match(php, /return 'noPermit';/);
    assert.match(php, /return 'cooling';/);
    // And the reason codes the client resolves against ui.json must exist on
    // both sides.
    for (const reason of ['badShaft', 'noPermit', 'cooling']) {
        assert.ok(php.includes(`'${reason}'`), `the controller no longer speaks ${reason}`);
    }
});

// ------------------------------------------------------------------
//  Translation
// ------------------------------------------------------------------

const TABLE = {
    languages: ['en', 'sl'],
    strings: {
        'a': { en: 'ALPHA', sl: 'ALFA' },
        'b': { en: 'BRAVO', sl: '' },
        'c': { en: 'SERIES {a} - {b}', sl: 'SERIJA {a} - {b}' },
    },
};

test('a string resolves in the room language, and an empty column falls back to English', () => {
    assert.equal(resolveString(TABLE, 'sl', 'a'), 'ALFA');
    assert.equal(resolveString(TABLE, 'en', 'a'), 'ALPHA');
    // A half-filled language must render something a person can act on
    // rather than a blank control.
    assert.equal(resolveString(TABLE, 'sl', 'b'), 'BRAVO');
    // A row nobody has written yet renders its own key, which is loud.
    assert.equal(resolveString(TABLE, 'sl', 'nope'), 'nope');
    assert.equal(createTranslator(TABLE, 'sl')('a'), 'ALFA');
});

test('substitutions are filled in, and an unknown one is left visible', () => {
    assert.equal(fillTemplate('SERIES {a} - {b}', { a: 2, b: 1 }), 'SERIES 2 - 1');
    assert.equal(fillTemplate('{name} IS CUTTING', {}), '{name} IS CUTTING');
    assert.equal(fillTemplate('nothing here', null), 'nothing here');
    assert.equal(resolveString(TABLE, 'sl', 'c', { a: 3, b: 0 }), 'SERIJA 3 - 0');
});

test('an unrecognised language becomes English, matching validateLang in PHP', () => {
    assert.equal(DEFAULT_LANG, 'en');
    assert.equal(normalizeLang('SL', TABLE), 'sl');
    assert.equal(normalizeLang('  sl  ', TABLE), 'sl');
    assert.equal(normalizeLang('de', TABLE), 'en');
    assert.equal(normalizeLang(null, TABLE), 'en');
    assert.deepEqual(tableLanguages(TABLE), ['en', 'sl']);
    // A table that declares nothing still speaks English.
    assert.deepEqual(tableLanguages({}), ['en']);
});
