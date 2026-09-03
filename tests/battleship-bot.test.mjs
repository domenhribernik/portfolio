// Unit tests for the Battleship bot (views/battleship/bot.js): the solo
// opponent, and the simulated players the balance suite pits against
// each other.
// Run: node --test tests/     (Windows: node --test "tests/**/*.test.mjs")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SIZE, CELLS, COST, FLEET, cellIndex, coordName, shipCells,
    newMatch, actionError, applyAction, enemyView, ownView, autoPlace,
} from '../views/battleship/logic.js';
import {
    POLICIES, seededRng, densityMap, chooseAction, playOut,
} from '../views/battleship/bot.js';

const fleetAt = () => [
    { key: 'carrier', at: cellIndex('A1'), dir: 'h' },
    { key: 'battleship', at: cellIndex('A3'), dir: 'h' },
    { key: 'cruiser', at: cellIndex('A5'), dir: 'h' },
    { key: 'submarine', at: cellIndex('A7'), dir: 'h' },
    { key: 'destroyer', at: cellIndex('A9'), dir: 'h' },
];
const openMatch = () => newMatch({ fleets: [fleetAt(), fleetAt()], starter: 1 });
const views = (match, seat) => ({ enemy: enemyView(match, seat), own: ownView(match, seat) });

test('a cell that has already been fired at carries no density', () => {
    let m = openMatch();
    ({ match: m } = applyAction(m, 1, { kind: 'fire', at: cellIndex('E6') }));
    const map = densityMap(enemyView(m, 1));
    assert.equal(map[cellIndex('E6')], 0);
    assert.equal(map.length, CELLS);
});

test('density is highest where the most surviving hulls could still lie', () => {
    // With nothing known, the centre of an empty plot fits more placements
    // than a corner does, which is the classic parity insight.
    const map = densityMap(enemyView(openMatch(), 1));
    assert.equal(map[cellIndex('E5')] > map[cellIndex('A1')], true);
});

test('an unresolved hit pulls the next shot alongside it', () => {
    // Hunt becomes target: once a hull is touched, its neighbours are the
    // only cells worth anything.
    let m = openMatch();
    ({ match: m } = applyAction(m, 1, { kind: 'fire', at: cellIndex('C1') }));
    const action = chooseAction({ ...views({ ...m, turn: 1 }, 1), policy: POLICIES.none, rng: seededRng(1) });
    const neighbours = [cellIndex('B1'), cellIndex('D1'), cellIndex('C2')];
    assert.equal(action.kind, 'fire');
    assert.equal(neighbours.includes(action.at), true, `shot ${coordName(action.at)} wandered off the contact`);
});

test('a sonar sweep that comes back empty stops the bot searching there', () => {
    let m = { ...openMatch(), sides: { 1: { ...openMatch().sides[1], salvage: COST.sonar }, 2: openMatch().sides[2] } };
    ({ match: m } = applyAction(m, 1, { kind: 'sonar', at: cellIndex('E6') }));
    const map = densityMap(enemyView({ ...m, turn: 1 }, 1), ownView(m, 1).intel);
    for (const c of [cellIndex('E6'), cellIndex('D5'), cellIndex('F7')]) {
        assert.equal(map[c], 0, `${coordName(c)} survived a clean sweep`);
    }
});

test('the bot never proposes an action the rules would refuse', () => {
    // Run whole games under every policy. A bot that can hand the controller
    // an illegal action is a bot that can wedge a real match.
    for (const [name, policy] of Object.entries(POLICIES)) {
        for (let seed = 0; seed < 6; seed++) {
            const rng = seededRng(seed);
            let m = newMatch({ fleets: [autoPlace(rng), autoPlace(rng)], starter: 1 });
            for (let turn = 0; turn < 600 && !m.outcome; turn++) {
                const seat = m.turn;
                const action = chooseAction({ ...views(m, seat), policy, rng });
                assert.equal(actionError(m, seat, action), null,
                    `${name} seed ${seed}: ${JSON.stringify(action)} was refused`);
                ({ match: m } = applyAction(m, seat, action));
            }
            assert.notEqual(m.outcome, null, `${name} seed ${seed} never finished`);
        }
    }
});

test('the bot decides from the fog alone and is never handed the enemy fleet', () => {
    // If chooseAction could see through the plot the solo game would be
    // unwinnable and the balance numbers would be fiction.
    const m = openMatch();
    const { enemy, own } = views(m, 1);
    assert.equal('fleet' in enemy, false);
    Object.freeze(enemy); Object.freeze(own);
    const action = chooseAction({ enemy, own, policy: POLICIES.full, rng: seededRng(3) });
    assert.equal(actionError(m, 1, action), null);
});

test('playOut runs a whole game and reports who won and how it went', () => {
    const result = playOut({ seed: 7, policies: [POLICIES.full, POLICIES.none] });
    assert.equal(['p1', 'p2'].includes(result.outcome), true);
    assert.equal(result.turns > FLEET.reduce((n, s) => n + s.len, 0), true);
    assert.equal([1, 2].includes(result.firstBlood), true, 'nobody lost the first ship');
});

test('the same seed plays the same game twice', () => {
    const a = playOut({ seed: 42, policies: [POLICIES.full, POLICIES.sonar] });
    const b = playOut({ seed: 42, policies: [POLICIES.full, POLICIES.sonar] });
    assert.deepEqual(a, b);
});
