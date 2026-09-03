// Unit tests for Battleship's rules core (views/battleship/logic.js).
// Run: node --test tests/     (Windows: node --test "tests/**/*.test.mjs")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    SIZE, coordName, cellIndex,
    FLEET, shipCells, placementError, autoPlace,
    newMatch, actionError, applyAction, EMPTY_GRID,
    COST, UNLOCK, DECOY_MAX, blockCells, barrageCells,
    enemyView, ownView,
    normalizeCode, isValidCode, cleanName, isValidName,
    createRoomModel, applyEvents, pollDelay,
    SALVAGE_CAP, SALVAGE_HIT_DEALT, SALVAGE_HIT_TAKEN, SALVAGE_WRECK_PER_CELL, SALVAGE_SECOND_MOVER,
} from '../views/battleship/logic.js';

// ------------------------------------------------------------------
//  Coordinates
// ------------------------------------------------------------------

test('every cell round-trips through its plotted name', () => {
    // The grid is row-major and named the way a plotter reads it aloud:
    // column letter first, then the one-based row.
    assert.equal(coordName(0), 'A1');
    assert.equal(coordName(SIZE * SIZE - 1), 'J10');
    for (let i = 0; i < SIZE * SIZE; i++) {
        assert.equal(cellIndex(coordName(i)), i, `cell ${i} did not survive the trip`);
    }
});

// ------------------------------------------------------------------
//  The fleet on the plot
// ------------------------------------------------------------------

/** A ship literal, so a test reads like a plot: ship('carrier', 'C4', 'h'). */
const ship = (key, at, dir) => ({ key, at: cellIndex(at), dir });

/** A legal five-ship fleet laid out along the top rows, for tests that need one. */
const legalFleet = () => [
    ship('carrier', 'A1', 'h'),
    ship('battleship', 'A3', 'h'),
    ship('cruiser', 'A5', 'h'),
    ship('submarine', 'A7', 'h'),
    ship('destroyer', 'A9', 'h'),
];

test('the fleet is five ships and seventeen cells', () => {
    assert.equal(FLEET.length, 5);
    assert.equal(FLEET.reduce((n, s) => n + s.len, 0), 17);
});

test('a ship occupies len cells running right or down from its head', () => {
    assert.deepEqual(shipCells(ship('cruiser', 'C4', 'h')).map(coordName), ['C4', 'D4', 'E4']);
    assert.deepEqual(shipCells(ship('cruiser', 'C4', 'v')).map(coordName), ['C4', 'C5', 'C6']);
});

test('a legal fleet placement is accepted', () => {
    assert.equal(placementError(legalFleet()), null);
});

test('a fleet missing a ship, or carrying a stranger, is refused', () => {
    assert.equal(placementError(legalFleet().slice(0, 4)), 'badFleet');
    assert.equal(placementError([...legalFleet(), ship('destroyer', 'E9', 'h')]), 'badFleet');
    const impostor = legalFleet();
    impostor[0] = ship('dreadnought', 'A1', 'h');
    assert.equal(placementError(impostor), 'badFleet');
});

test('a ship that would run off the plot is refused, never wrapped', () => {
    // G1 horizontal would need G,H,I,J,K. There is no K, and it must not
    // silently continue on row 2, which is what a bare index+1 loop would do.
    const off = legalFleet();
    off[0] = ship('carrier', 'G1', 'h');
    assert.equal(placementError(off), 'offPlot');

    const down = legalFleet();
    down[0] = ship('carrier', 'A7', 'v');
    assert.equal(placementError(down), 'offPlot');
});

test('two ships may touch but may not overlap', () => {
    const touching = legalFleet();
    touching[1] = ship('battleship', 'A2', 'h');   // directly under the carrier
    assert.equal(placementError(touching), null);

    const overlapping = legalFleet();
    overlapping[1] = ship('battleship', 'B1', 'h');
    assert.equal(placementError(overlapping), 'overlap');
});

test('autoPlace lays a legal fleet from any run of the generator', () => {
    // Injected rng, so a placement bug cannot hide behind a lucky seed.
    for (let seed = 0; seed < 200; seed++) {
        const rng = mulberry32(seed);
        assert.equal(placementError(autoPlace(rng)), null, `seed ${seed} placed an illegal fleet`);
    }
});

/** A tiny seeded PRNG, so every random-dependent test is reproducible. */
function mulberry32(seed) {
    let a = seed + 0x6d2b79f5;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ------------------------------------------------------------------
//  Firing
// ------------------------------------------------------------------

/** A match with both fleets laid along known rows, seat 1 to move. */
const openMatch = () => newMatch({ fleets: [legalFleet(), legalFleet()], starter: 1 });

/** Fire a single shot and hand back the new match plus what happened. */
const fire = (match, seat, at) => applyAction(match, seat, { kind: 'fire', at: cellIndex(at) });

test('a shot into open water is a miss and is plotted as one', () => {
    const { match, report } = fire(openMatch(), 1, 'A2');
    assert.deepEqual(report.cells, [{ cell: cellIndex('A2'), result: 'miss' }]);
    assert.equal(match.sides[2].grid[cellIndex('A2')], 'o');
});

test('a shot onto a hull is a hit, and the hull remembers it', () => {
    const { match, report } = fire(openMatch(), 1, 'B1');
    assert.deepEqual(report.cells, [{ cell: cellIndex('B1'), result: 'hit' }]);
    assert.equal(match.sides[2].grid[cellIndex('B1')], 'x');
    assert.deepEqual(report.sunk, []);
});

test('the last cell of a ship sinks it, and every cell of it is restruck as sunk', () => {
    // The destroyer sits on A9-B9.
    let m = openMatch();
    ({ match: m } = fire(m, 1, 'A9'));
    m = { ...m, turn: 1 };                       // hand the turn straight back
    const { match, report } = fire(m, 1, 'B9');
    assert.deepEqual(report.sunk, ['destroyer']);
    assert.equal(match.sides[2].grid[cellIndex('A9')], 's');
    assert.equal(match.sides[2].grid[cellIndex('B9')], 's');
});

test('the turn passes after every action, hit or miss', () => {
    // No "hit means shoot again". That rule is the snowball this variant removes.
    const { match: afterMiss } = fire(openMatch(), 1, 'A2');
    assert.equal(afterMiss.turn, 2);
    const { match: afterHit } = fire(openMatch(), 1, 'B1');
    assert.equal(afterHit.turn, 2);
});

test('firing out of turn, off the plot, or onto a spent cell is refused', () => {
    const m = openMatch();
    assert.equal(actionError(m, 2, { kind: 'fire', at: cellIndex('A2') }), 'notYourTurn');
    assert.equal(actionError(m, 1, { kind: 'fire', at: -1 }), 'offPlot');
    assert.equal(actionError(m, 1, { kind: 'fire', at: 100 }), 'offPlot');
    const { match } = fire(m, 1, 'A2');
    assert.equal(actionError({ ...match, turn: 1 }, 1, { kind: 'fire', at: cellIndex('A2') }), 'spent');
});

// ------------------------------------------------------------------
//  The verdict
// ------------------------------------------------------------------

test('sinking the last hull ends the match for the side that did it', () => {
    let m = openMatch();
    for (const s of legalFleet()) {
        for (const c of shipCells(s)) {
            assert.equal(m.outcome, null, 'the match ended before the fleet was down');
            ({ match: m } = applyAction({ ...m, turn: 1 }, 1, { kind: 'fire', at: c }));
        }
    }
    assert.equal(m.outcome, 'p1');
    assert.equal(m.status, 'over');
    assert.equal(actionError({ ...m, turn: 1 }, 1, { kind: 'fire', at: cellIndex('A2') }), 'over');
});

// ------------------------------------------------------------------
//  Salvage
// ------------------------------------------------------------------

test('the player who moves second opens with a salvage in hand', () => {
    // Compensation for the first shot, and the only salvage nobody earned.
    const m = newMatch({ fleets: [legalFleet(), legalFleet()], starter: 1 });
    assert.equal(m.sides[2].salvage, SALVAGE_SECOND_MOVER);
    assert.equal(m.sides[1].salvage, 0);
});

test('a hit pays the firer and the struck alike, so an exchange is even', () => {
    const before = openMatch();
    const { match } = fire(before, 1, 'B1');
    assert.equal(match.sides[1].salvage - before.sides[1].salvage, SALVAGE_HIT_DEALT);
    assert.equal(match.sides[2].salvage - before.sides[2].salvage, SALVAGE_HIT_TAKEN);
});

test('a miss pays nobody', () => {
    const before = openMatch();
    const { match } = fire(before, 1, 'A2');
    assert.equal(match.sides[1].salvage, before.sides[1].salvage);
    assert.equal(match.sides[2].salvage, before.sides[2].salvage);
});

test('a wreck pays its owner in proportion to what went down', () => {
    // This is the comeback engine: the fleet that is dying funds the fight.
    let m = openMatch();
    ({ match: m } = fire(m, 1, 'A9'));
    const before = m.sides[2].salvage;
    ({ match: m } = fire({ ...m, turn: 1 }, 1, 'B9'));
    assert.equal(m.sides[2].salvage - before, SALVAGE_HIT_TAKEN + SALVAGE_WRECK_PER_CELL * 2);
});

test('salvage stops at the cap, so hoarding forever buys nothing', () => {
    let m = openMatch();
    m = { ...m, sides: { 1: { ...m.sides[1], salvage: SALVAGE_CAP }, 2: m.sides[2] } };
    ({ match: m } = fire(m, 1, 'B1'));
    assert.equal(m.sides[1].salvage, SALVAGE_CAP);
});

// ------------------------------------------------------------------
//  The five abilities
// ------------------------------------------------------------------

const names = (cells) => cells.map(coordName).sort();

test('a block is the three by three around a cell, clipped at the edge', () => {
    assert.deepEqual(names(blockCells(cellIndex('E5'))),
        names(['D4', 'E4', 'F4', 'D5', 'E5', 'F5', 'D6', 'E6', 'F6'].map(cellIndex)));
    // A corner catches four cells, never nine, and never wraps to the far side.
    assert.deepEqual(names(blockCells(cellIndex('A1'))), ['A1', 'A2', 'B1', 'B2']);
    assert.deepEqual(names(blockCells(cellIndex('J10'))), ['I10', 'I9', 'J10', 'J9']);
});

test('sonar and the depth charge share one footprint on purpose', () => {
    // A sweep tells you exactly what a charge dropped on the same cell would
    // catch. That is the whole reason both are worth buying.
    assert.deepEqual(blockCells(cellIndex('C7')), blockCells(cellIndex('C7')));
    assert.equal(COST.sonar < COST.depthCharge, true);
});

test('a barrage is three adjacent cells that stay on their own row or column', () => {
    assert.deepEqual(names(barrageCells(cellIndex('C4'), 'h')), ['C4', 'D4', 'E4']);
    assert.deepEqual(names(barrageCells(cellIndex('C4'), 'v')), ['C4', 'C5', 'C6']);
    assert.equal(barrageCells(cellIndex('I4'), 'h'), null, 'a barrage may not wrap onto the next row');
    assert.equal(barrageCells(cellIndex('C9'), 'v'), null);
});

test('an ability you cannot afford is refused', () => {
    const m = withWrecks(openMatch(), 1, 2);                 // unlocked, but broke
    assert.equal(actionError(m, 1, { kind: 'depthCharge', at: cellIndex('E5') }), 'broke');
    assert.equal(actionError(withSalvage(m, 1, COST.depthCharge), 1,
        { kind: 'depthCharge', at: cellIndex('E5') }), null);
});

test('a sonar sweep counts hulls in its block and tells only the caller', () => {
    // The carrier runs A1-E1, so a sweep on B1 catches three of its cells and
    // two of the battleship's on row 3. Nothing on row 2.
    const m = withSalvage(openMatch(), 1, COST.sonar);
    const { match, report } = applyAction(m, 1, { kind: 'sonar', at: cellIndex('B1') });
    assert.equal(report.intel.count, 3);
    assert.deepEqual(match.sides[1].intel, [{ at: cellIndex('B1'), count: 3 }]);
    assert.deepEqual(match.sides[2].intel, [], 'the swept player learned they were swept');
    assert.equal(match.sides[2].grid, EMPTY_GRID, 'a sweep is not a shot');
});

test('a barrage fires all three cells in one turn', () => {
    const m = withWrecks(withSalvage(openMatch(), 1, COST.barrage), 1, 1);
    const { match, report } = applyAction(m, 1, { kind: 'barrage', at: cellIndex('D1'), dir: 'h' });
    assert.deepEqual(report.cells.map((c) => c.result), ['hit', 'hit', 'blast']);  // D1,E1 carrier; F1 water
    assert.equal(match.turn, 2, 'three shells are still one turn');
});

test('a depth charge fires its whole block, and a wasted one costs the bank', () => {
    const m = armed(openMatch(), 1);
    const { match, report } = applyAction(m, 1, { kind: 'depthCharge', at: cellIndex('B6') });
    assert.equal(report.cells.length, 9);
    // Row 6 is empty water and rows 5 and 7 carry the cruiser and submarine.
    assert.equal(match.sides[1].salvage < SALVAGE_CAP, true, 'the charge was not paid for');
});

// ------------------------------------------------------------------
//  Decoys
// ------------------------------------------------------------------

const withSalvage = (m, seat, n) => ({ ...m, sides: { ...m.sides, [seat]: { ...m.sides[seat], salvage: n } } });

/** Put `n` of a seat's own ships on the bottom, to open the unlock ladder. */
const withWrecks = (m, seat, n) => {
    const side = m.sides[seat];
    let grid = side.grid;
    for (const ship of side.fleet.slice(0, n)) {
        for (const c of shipCells(ship)) grid = grid.slice(0, c) + 's' + grid.slice(c + 1);
    }
    return { ...m, sides: { ...m.sides, [seat]: { ...side, grid } } };
};

/** Salvage in hand and enough wreckage behind you to buy anything. */
const armed = (m, seat) => withWrecks(withSalvage(m, seat, SALVAGE_CAP), seat, 2);

test('a decoy may only go on your own open water', () => {
    const m = withSalvage(openMatch(), 1, SALVAGE_CAP);
    assert.equal(actionError(m, 1, { kind: 'decoy', at: cellIndex('A1') }), 'occupied');
    assert.equal(actionError(m, 1, { kind: 'decoy', at: cellIndex('A2') }), null);
});

test('two decoys may be live at once, never three', () => {
    let m = withSalvage(openMatch(), 1, SALVAGE_CAP);
    for (const at of ['A2', 'B2']) {
        ({ match: m } = applyAction(m, 1, { kind: 'decoy', at: cellIndex(at) }));
        m = withSalvage({ ...m, turn: 1 }, 1, SALVAGE_CAP);
    }
    assert.equal(m.sides[1].decoys.length, DECOY_MAX);
    assert.equal(actionError(m, 1, { kind: 'decoy', at: cellIndex('C2') }), 'tooManyDecoys');
});

test('a decoy reads as a hit, pays out as a hit, and only confesses a turn later', () => {
    // The tote board is public, so a decoy that paid nothing would give itself
    // away the moment the enemy glanced at it.
    let m = withSalvage(openMatch(), 2, SALVAGE_CAP);
    m = { ...m, turn: 2 };
    ({ match: m } = applyAction(m, 2, { kind: 'decoy', at: cellIndex('A2') }));

    const before = { one: m.sides[1].salvage, two: m.sides[2].salvage };
    const { match, report } = applyAction(m, 1, { kind: 'fire', at: cellIndex('A2') });
    assert.equal(report.cells[0].result, 'decoy');
    assert.equal(match.sides[2].grid[cellIndex('A2')], 'D', 'not yet confessed');
    assert.equal(match.sides[1].salvage - before.one, SALVAGE_HIT_DEALT);
    assert.equal(match.sides[2].salvage - before.two, SALVAGE_HIT_TAKEN);
    assert.deepEqual(report.sunk, [], 'a decoy is not a hull and can never sink');

    const { match: later } = applyAction(match, 2, { kind: 'fire', at: cellIndex('J10') });
    assert.equal(later.sides[2].grid[cellIndex('A2')], 'd', 'the decoy confessed on its owner turn');
});

// ------------------------------------------------------------------
//  Reposition
// ------------------------------------------------------------------

test('only an undamaged ship may move, and only onto untouched water', () => {
    let m = withWrecks(withSalvage(openMatch(), 2, SALVAGE_CAP), 2, 1);
    const move = (ship, at, dir) => ({ kind: 'reposition', ship, at: cellIndex(at), dir });

    assert.equal(actionError({ ...m, turn: 2 }, 2, move('nimitz', 'A2', 'h')), 'badShip');
    assert.equal(actionError({ ...m, turn: 2 }, 2, move('cruiser', 'A3', 'h')), 'overlap');
    assert.equal(actionError({ ...m, turn: 2 }, 2, move('destroyer', 'E6', 'h')), null);

    // Seat 1 nicks the destroyer, which may then never run again.
    ({ match: m } = applyAction({ ...m, turn: 1 }, 1, { kind: 'fire', at: cellIndex('A9') }));
    assert.equal(actionError(m, 2, move('destroyer', 'E6', 'h')), 'damaged');
});

test('a ship may not slip onto a cell the enemy has already searched', () => {
    // Otherwise a plotted miss would quietly stop being true, and every
    // deduction the enemy made from it would be poisoned.
    let m = withWrecks(withSalvage(openMatch(), 2, SALVAGE_CAP), 2, 1);
    ({ match: m } = applyAction(m, 1, { kind: 'fire', at: cellIndex('E6') }));
    assert.equal(actionError(m, 2, { kind: 'reposition', ship: 'destroyer', at: cellIndex('E6'), dir: 'h' }), 'searched');
});

test('a reposition moves the hull and reports nothing but that it happened', () => {
    let m = { ...withWrecks(withSalvage(openMatch(), 2, SALVAGE_CAP), 2, 1), turn: 2 };
    const { match, report } = applyAction(m, 2, { kind: 'reposition', ship: 'destroyer', at: cellIndex('E6'), dir: 'h' });
    assert.equal(report.moved, true);
    assert.deepEqual(report.cells, []);
    assert.deepEqual(shipCells(match.sides[2].fleet.find((s) => s.key === 'destroyer')).map(coordName), ['E6', 'F6']);
    const { match: after } = applyAction({ ...match, turn: 1 }, 1, { kind: 'fire', at: cellIndex('A9') });
    assert.equal(after.sides[2].grid[cellIndex('A9')], 'o', 'the old berth is open water now');
});

// ------------------------------------------------------------------
//  The fog
// ------------------------------------------------------------------

test('the enemy plot shows only what has actually been fired at', () => {
    // The invariant the whole game rests on. Derived from the shot record,
    // never filtered out of the fleet, so a new secret cannot leak by being
    // forgotten in a filter.
    let m = openMatch();
    ({ match: m } = fire(m, 1, 'B1'));
    const view = enemyView(m, 1);

    assert.equal(view.grid[cellIndex('B1')], 'x');
    for (const s of m.sides[2].fleet) {
        for (const c of shipCells(s)) {
            if (c === cellIndex('B1')) continue;
            assert.equal(view.grid[c], '.', `${coordName(c)} gave a hull away`);
        }
    }
    assert.equal(JSON.stringify(view).includes('carrier'), false, 'a ship key reached the enemy');
});

test('an unrevealed decoy is indistinguishable from a hit in the enemy plot', () => {
    let m = { ...withSalvage(openMatch(), 2, SALVAGE_CAP), turn: 2 };
    ({ match: m } = applyAction(m, 2, { kind: 'decoy', at: cellIndex('A2') }));
    ({ match: m } = fire(m, 1, 'A2'));
    assert.equal(enemyView(m, 1).grid[cellIndex('A2')], 'x', 'the buoy confessed a turn early');
    assert.equal(enemyView(m, 1).decoys, undefined);
});

test('your own view carries your fleet, your buoys and your sweeps, and the enemy view carries none of it', () => {
    let m = { ...withSalvage(openMatch(), 1, SALVAGE_CAP), turn: 1 };
    ({ match: m } = applyAction(m, 1, { kind: 'sonar', at: cellIndex('B1') }));
    const mine = ownView(m, 1);
    assert.equal(mine.fleet.length, FLEET.length);
    assert.equal(mine.intel.length, 1);
    assert.equal(JSON.stringify(enemyView(m, 2)).includes('count'), false, 'a sweep result crossed the table');
});

test('the enemy tote and hull count are public, because reading them is the game', () => {
    const view = enemyView(openMatch(), 1);
    assert.equal(view.salvage, SALVAGE_SECOND_MOVER);
    assert.equal(view.afloat, FLEET.length);
    assert.deepEqual(view.sunk, []);
});

// ------------------------------------------------------------------
//  Codes, names, the reducer and poll pacing
// ------------------------------------------------------------------

test('a room code is four letters, however it was typed', () => {
    assert.equal(normalizeCode(' bk-tz '), 'BKTZ');
    assert.equal(normalizeCode('bktzzz'), 'BKTZ');
    assert.equal(isValidCode('BKTZ'), true);
    assert.equal(isValidCode('BKT'), false);
    assert.equal(isValidCode('BK7Z'), false);
});

test('a name is trimmed, collapsed and capped at twenty code points', () => {
    assert.equal(cleanName('  Ada   Lovelace  '), 'Ada Lovelace');
    assert.equal(isValidName(''), false);
    assert.equal(isValidName('a'.repeat(20)), true);
    assert.equal(isValidName('a'.repeat(21)), false);
    assert.equal(isValidName('🚢'.repeat(20)), true, 'an emoji is one character, not two');
});

test('the reducer folds a page of events and moves the cursor past all of it', () => {
    const model = createRoomModel();
    const ops = applyEvents(model, [
        { seq: 4, type: 'start', data: {} },
        { seq: 7, type: 'shot', data: { seat: 1, kind: 'fire', cells: [{ cell: 3, result: 'hit' }], sunk: [] } },
        { seq: 9, type: 'sunk', data: { seat: 2, ship: 'destroyer' } },
    ], 11);
    assert.deepEqual(ops.map((o) => o.op), ['start', 'shot', 'sunk']);
    assert.equal(model.status, 'battle');
    assert.equal(model.lastSeq, 9);
});

test('an unknown event is ignored but still advances the cursor', () => {
    // Forward compatibility: an old tab must not desync or spin when a newer
    // server speaks an event it has never heard of.
    const model = createRoomModel();
    assert.deepEqual(applyEvents(model, [{ seq: 12, type: 'tugboat', data: {} }], 1), []);
    assert.equal(model.lastSeq, 12);
    assert.deepEqual(applyEvents(model, undefined, 1), []);
});

test('a reposition event reaches the reducer carrying nothing but the fact of it', () => {
    const model = createRoomModel();
    const [op] = applyEvents(model, [{ seq: 3, type: 'moved', data: { seat: 2 } }], 1);
    assert.deepEqual(op, { op: 'moved', seat: 2 });
});

test('polling is quick while the other side is thinking and slow while it is your move', () => {
    // Nothing moves until you move it, so your own turn is the cheapest phase.
    assert.equal(pollDelay({ status: 'battle', waiting: true }), 900);
    assert.equal(pollDelay({ status: 'battle', waiting: false }), 3000);
    assert.equal(pollDelay({ status: 'place' }), 1200);
    assert.equal(pollDelay({ status: 'lobby' }), 1000);
    assert.equal(pollDelay({ status: 'battle', waiting: true, hidden: true }), 4000);
    assert.equal(pollDelay({ status: 'battle', failures: 3 }), 6400);
    assert.equal(pollDelay({ status: 'battle', failures: 9 }), 10000, 'backoff is capped');
});

test('area fire pays the gunner nothing, so the heavy weapons cannot refuel themselves', () => {
    // Without this a nine cell blast is just a rate multiplier, and the
    // balance suite shows a depth charge policy taking 86% of the ring.
    const base = armed(openMatch(), 1);
    const { match } = applyAction(base, 1, { kind: 'barrage', at: cellIndex('D1'), dir: 'h' });
    assert.equal(match.sides[1].salvage, SALVAGE_CAP - COST.barrage, 'the barrage refunded its own hits');
    // The fleet it landed on is still paid, so being shelled still funds a reply.
    assert.equal(match.sides[2].salvage - base.sides[2].salvage, 2 * SALVAGE_HIT_TAKEN);
});

test('a blast churns the water without surveying it', () => {
    // The search is the bottleneck in battleship, not the damage. A weapon
    // that also cleared nine cells of the search would be a rate multiplier
    // and nothing else, so a blast that finds nothing leaves no mark and the
    // cell still has to be searched properly.
    const m = armed(openMatch(), 1);
    const { match, report } = applyAction(m, 1, { kind: 'depthCharge', at: cellIndex('E6') });
    assert.deepEqual([...new Set(report.cells.map((c) => c.result))], ['blast']);
    assert.equal(match.sides[2].grid, EMPTY_GRID, 'the charge did the enemy search for them');
    assert.equal(actionError({ ...match, turn: 1 }, 1, { kind: 'fire', at: cellIndex('E6') }), null);
});

test('a sweep tells the swept fleet where the enemy looked, never what they found', () => {
    // Information costs information. It is what stops a sweep being free, and
    // what gives a reposition something to react to.
    const m = withSalvage(openMatch(), 1, SALVAGE_CAP);
    const { match, report } = applyAction(m, 1, { kind: 'sonar', at: cellIndex('B1') });
    assert.equal(report.swept, cellIndex('B1'));
    assert.deepEqual(ownView(match, 2).swept, [cellIndex('B1')]);
    assert.equal(JSON.stringify(ownView(match, 2)).includes('"count"'), false, 'the reading crossed the table');
});

// ------------------------------------------------------------------
//  The unlock ladder
// ------------------------------------------------------------------

test('the heavy tools stay locked until your own fleet starts going down', () => {
    // The comeback engine. A fleet that is winning fights with a sweep and a
    // buoy; the barrage and the charge are salvaged out of your own wrecks.
    const rich = withSalvage(openMatch(), 1, SALVAGE_CAP);
    assert.equal(actionError(rich, 1, { kind: 'sonar', at: cellIndex('E5') }), null);
    assert.equal(actionError(rich, 1, { kind: 'decoy', at: cellIndex('E5') }), null);
    assert.equal(actionError(rich, 1, { kind: 'barrage', at: cellIndex('E5'), dir: 'h' }), 'locked');
    assert.equal(actionError(rich, 1, { kind: 'depthCharge', at: cellIndex('E5') }), 'locked');
});

test('each wreck of your own opens the next tool up', () => {
    // Seat 2 sinks seat 1's destroyer, then its submarine.
    let m = withSalvage(openMatch(), 1, SALVAGE_CAP);
    const hit = (at) => { ({ match: m } = applyAction({ ...m, turn: 2 }, 2, { kind: 'fire', at: cellIndex(at) })); };

    hit('A9'); hit('B9');                                    // destroyer down
    m = withSalvage({ ...m, turn: 1 }, 1, SALVAGE_CAP);
    assert.equal(actionError(m, 1, { kind: 'barrage', at: cellIndex('E5'), dir: 'h' }), null);
    assert.equal(actionError(m, 1, { kind: 'depthCharge', at: cellIndex('E5') }), 'locked');

    hit('A7'); hit('B7'); hit('C7');                         // submarine down
    m = withSalvage({ ...m, turn: 1 }, 1, SALVAGE_CAP);
    assert.equal(actionError(m, 1, { kind: 'depthCharge', at: cellIndex('E5') }), null);
});

test('the ladder counts your own wrecks, never the enemy fleet you have sunk', () => {
    // Otherwise it would reward the side already ahead, which is the exact
    // snowball the whole variant exists to break.
    let m = withSalvage(openMatch(), 1, SALVAGE_CAP);
    for (const at of ['A9', 'B9', 'A7', 'B7', 'C7']) {
        ({ match: m } = applyAction({ ...m, turn: 1 }, 1, { kind: 'fire', at: cellIndex(at) }));
    }
    m = withSalvage(m, 1, SALVAGE_CAP);
    assert.equal(actionError({ ...m, turn: 1 }, 1, { kind: 'depthCharge', at: cellIndex('E5') }), 'locked');
});

// ------------------------------------------------------------------
//  The two halves of the rules
// ------------------------------------------------------------------

test('the constants mirrored into battleship-controller.php still agree with it', () => {
    // In a room game the controller is the authority and this module is only
    // the preview, the greying-out and the solo opponent. A comment saying
    // "change them in both" cannot enforce that, so read the PHP and compare:
    // a page that draws a price the server does not charge, or a ladder that
    // opens a rung early, is a desync nothing else catches.
    const php = readFileSync(new URL('../app/controllers/battleship-controller.php', import.meta.url), 'utf8');
    const constant = (name) => {
        const m = php.match(new RegExp(`^const\\s+${name}\\s*=\\s*(\\d+)\\s*;`, 'm'));
        assert.ok(m, `battleship-controller.php no longer declares ${name}`);
        return Number(m[1]);
    };

    assert.equal(constant('SIZE'), SIZE);
    assert.equal(constant('CELLS'), SIZE * SIZE);
    assert.equal(constant('SALVAGE_CAP'), SALVAGE_CAP);
    assert.equal(constant('SALVAGE_HIT_DEALT'), SALVAGE_HIT_DEALT);
    assert.equal(constant('SALVAGE_HIT_TAKEN'), SALVAGE_HIT_TAKEN);
    assert.equal(constant('SALVAGE_WRECK_PER_CELL'), SALVAGE_WRECK_PER_CELL);
    assert.equal(constant('SALVAGE_SECOND_MOVER'), SALVAGE_SECOND_MOVER);
    assert.equal(constant('DECOY_MAX'), DECOY_MAX);

    const snake = { sonar: 'SONAR', decoy: 'DECOY', barrage: 'BARRAGE', reposition: 'REPOSITION', depthCharge: 'DEPTH_CHARGE' };
    for (const [kind, name] of Object.entries(snake)) {
        assert.equal(constant(`COST_${name}`), COST[kind], `${kind} costs a different price server side`);
        assert.equal(constant(`UNLOCK_${name}`), UNLOCK[kind], `${kind} opens on a different rung server side`);
    }

    const spec = php.match(/^const\s+FLEET_SPEC\s*=\s*'([^']+)'\s*;/m);
    assert.ok(spec, 'battleship-controller.php no longer declares FLEET_SPEC');
    assert.equal(spec[1], FLEET.map((s) => `${s.key}:${s.len}`).join(','));

    const grid = php.match(/^const\s+EMPTY_GRID\s*=\s*'(\.+)'\s*;/m);
    assert.ok(grid, 'battleship-controller.php no longer declares EMPTY_GRID');
    assert.equal(grid[1], EMPTY_GRID);
});

test('every refusal the controller can send is a code this module also knows', () => {
    // The client translates a refusal by its code, so a code only one half
    // speaks renders as a blank toast the player cannot act on.
    const php = readFileSync(new URL('../app/controllers/battleship-controller.php', import.meta.url), 'utf8');
    const fromPhp = new Set([...php.matchAll(/'reason'\s*=>\s*'?\$?(\w+)'?/g)]
        .map((m) => m[1]).filter((r) => r !== 'err' && r !== 'reason'));
    const known = new Set(['over', 'notYourTurn', 'offPlot', 'spent', 'badAction', 'locked', 'broke',
        'tooManyDecoys', 'occupied', 'badShip', 'damaged', 'searched', 'overlap', 'badFleet',
        'noOpponent', 'notPlacing', 'notOver', 'nameTaken', 'seatBusy']);
    for (const code of fromPhp) {
        assert.ok(known.has(code), `the controller sends refuse.${code}, which nothing else knows about`);
    }
});
