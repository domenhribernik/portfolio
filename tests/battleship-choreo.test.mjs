// The choreography planner (views/battleship/choreo.js): how far the plot is
// allowed to lag the poll while a shot plays out, and in what order it lands.
// Run: node --test tests/     (Windows: node --test "tests/**/*.test.mjs")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_GRID, cellIndex } from '../views/battleship/logic.js';
import {
    TEMPO, tempo, landingPlan, newWrecks, heldCells, projectGrid, landingCells,
    buoyReveals, readingAt, restingSide, isStaleRoom,
} from '../views/battleship/choreo.js';

const at = cellIndex;
const grid = (marks) => {
    let g = EMPTY_GRID;
    for (const [name, mark] of Object.entries(marks)) {
        const i = at(name);
        g = g.slice(0, i) + mark + g.slice(i + 1);
    }
    return g;
};
const shot = (kind, cells, sunk = []) => ({
    op: 'shot', seat: 1, kind, sunk,
    cells: cells.map(([name, result]) => ({ cell: at(name), result })),
});

test('reduced motion plays the whole sequence at once', () => {
    for (const v of Object.values(tempo(true))) assert.equal(v, 0);
    assert.deepEqual(tempo(false), TEMPO);
    const plan = landingPlan(shot('depthCharge', [['B2', 'hit']]), true);
    assert.equal(plan.aimMs, 0);
    assert.equal(plan.shake, false, 'nothing shakes under reduced motion');
});

test('a barrage lands one shell at a time, a charge lands all at once', () => {
    const barrage = landingPlan(shot('barrage', [['A1', 'miss'], ['B1', 'hit'], ['C1', 'miss']]));
    assert.deepEqual(barrage.groups, [[at('A1')], [at('B1')], [at('C1')]]);
    assert.equal(barrage.gapMs, TEMPO.gap);
    assert.equal(barrage.shake, false);

    const charge = landingPlan(shot('depthCharge', [['A1', 'blast'], ['B1', 'hit'], ['B2', 'blast']]));
    assert.equal(charge.groups.length, 1);
    assert.equal(charge.groups[0].length, 3, 'churned water lands too: the splash is its only sign');
    assert.equal(charge.gapMs, 0);
    assert.equal(charge.shake, true);
});

test('a report with nothing to land has no groups', () => {
    assert.deepEqual(landingPlan({ op: 'shot', kind: 'fire', cells: [] }).groups, []);
    assert.deepEqual(landingPlan({ op: 'shot', kind: 'depthCharge' }).groups, []);
});

test('queued reports hold their cells at what the plot already shows', () => {
    const shown = grid({ C3: 'x' });
    const next = grid({ C3: 'x', D3: 'o', E5: 'x' });
    const queue = [shot('fire', [['D3', 'miss']]), shot('fire', [['E5', 'hit']])];
    const held = heldCells(queue, shown, next);
    assert.deepEqual([...held].sort((a, b) => a - b), [at('D3'), at('E5')]);
    assert.equal(projectGrid(shown, next, held), shown, 'nothing lands until it is played');
});

test('a queued sinking also holds the rest of the wreck', () => {
    // The cruiser at C3 D3 E3 goes down on E3; C3 and D3 flip from x to s in
    // the same poll, and they must not flip before the shell lands.
    const shown = grid({ C3: 'x', D3: 'x' });
    const next = grid({ C3: 's', D3: 's', E3: 's' });
    const held = heldCells([shot('fire', [['E3', 'sunk']], ['cruiser'])], shown, next);
    assert.deepEqual([...held].sort((a, b) => a - b), [at('C3'), at('D3'), at('E3')]);
    assert.deepEqual(newWrecks(shown, next), [at('C3'), at('D3'), at('E3')]);

    // Landing E3 sets the whole wreck down together.
    assert.deepEqual(landingCells([at('E3')], shown, next).sort((a, b) => a - b),
        [at('C3'), at('D3'), at('E3')]);
    // A miss in the same water sets only itself down.
    assert.deepEqual(landingCells([at('A1')], shown, grid({ A1: 'o' })), [at('A1')]);
});

test('cells the playing report has set down are released from the hold', () => {
    const shown = EMPTY_GRID;
    const next = grid({ A1: 'o', B1: 'x', C1: 'o' });
    const op = shot('barrage', [['A1', 'miss'], ['B1', 'hit'], ['C1', 'miss']]);
    const held = heldCells([op], shown, next, new Set([at('A1'), at('B1')]));
    assert.deepEqual([...held], [at('C1')]);
    assert.equal(projectGrid(shown, next, held), grid({ A1: 'o', B1: 'x' }));
});

test('only shots hold the plot; a sweep or a move holds nothing', () => {
    const held = heldCells([{ op: 'swept', at: 5 }, { op: 'moved' }], EMPTY_GRID, grid({ A1: 'o' }));
    assert.equal(held.size, 0);
    assert.equal(projectGrid(EMPTY_GRID, grid({ A1: 'o' }), held), grid({ A1: 'o' }));
});

test('a buoy owning up is read off the plot as a hit turning into a decoy', () => {
    assert.deepEqual(buoyReveals(grid({ E5: 'x', F5: 'x' }), grid({ E5: 'd', F5: 'x' })), [at('E5')]);
    assert.deepEqual(buoyReveals(grid({ E5: 'd' }), grid({ E5: 'd' })), [], 'a revealed buoy is not news twice');
});

test('the newest reading on a cell wins', () => {
    const intel = [{ at: 12, count: 1 }, { at: 30, count: 0 }, { at: 12, count: 2 }];
    assert.equal(readingAt(intel, 12), 2);
    assert.equal(readingAt(intel, 30), 0);
    assert.equal(readingAt(intel, 7), null);
    assert.equal(readingAt(undefined, 7), null);
});

test('the lamp rests on the plot being shot at', () => {
    assert.equal(restingSide({ mine: false, aimsAtSelf: false }), 'own');
    assert.equal(restingSide({ mine: true, aimsAtSelf: false }), 'enemy');
    assert.equal(restingSide({ mine: true, aimsAtSelf: true }), 'own');
});

test('a room older than the move already made is stale', () => {
    assert.equal(isStaleRoom({ turns: 4 }, 5), true);
    assert.equal(isStaleRoom({ turns: 5 }, 5), false);
    assert.equal(isStaleRoom({ turns: 9 }, 5), false);
    assert.equal(isStaleRoom({ turns: 4 }, null), false, 'no move pending, nothing is stale');
    assert.equal(isStaleRoom(null, 5), false);
});
