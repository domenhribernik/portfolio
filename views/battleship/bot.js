// BATTLESHIP // the solo opponent, and the simulated players the balance
// suite pits against each other.
//
// The bot decides from the fog and nothing else: chooseAction is handed the
// two projections from logic.js, never the match. That is not politeness, it
// is what makes the solo game honest and the balance numbers mean anything.
//
// Targeting is the known-good probability density method. For every hull
// still afloat, count the legal berths it could still occupy, and shoot the
// cell the most berths pass through. A touched hull ("hunt" becoming
// "target") is folded into the same map by weighting berths that would
// explain the hits already on the plot, so there is no second code path.

import {
    SIZE, CELLS, FLEET, COST, DECOY_MAX,
    UNLOCK, shipCells, blockCells, barrageCells, placementError, other,
    newMatch, autoPlace, enemyView, ownView, applyAction, actionError,
} from './logic.js';

// ------------------------------------------------------------------
//  Determinism
// ------------------------------------------------------------------

/** mulberry32. Small, fast, and the same sequence on every machine. */
export function seededRng(seed) {
    let a = (seed + 0x6d2b79f5) | 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ------------------------------------------------------------------
//  Policies
// ------------------------------------------------------------------

// `abilities` is what this player is allowed to buy, in the order it prefers
// them. The single-ability policies exist so tests/battleship-balance.test.mjs
// can put each tool in the ring on its own; `full` is the real opponent.
const policy = (abilities, noise = 0) => ({ abilities, noise });

export const POLICIES = {
    none: policy([]),
    sonar: policy(['sonar']),
    barrage: policy(['barrage']),
    depthCharge: policy(['depthCharge']),
    reposition: policy(['reposition']),
    decoy: policy(['decoy']),
    full: policy(['sonar', 'depthCharge', 'barrage', 'reposition', 'decoy']),
};

/** The two levels the solo screen offers. */
export const LEVELS = {
    ensign: policy([], 0.45),
    admiral: POLICIES.full,
};

// ------------------------------------------------------------------
//  Reading the plot
// ------------------------------------------------------------------

const SPENT = new Set(['o', 'x', 's', 'd']);

/**
 * How many surviving berths run through each cell, given what has been
 * plotted so far. Spent cells score zero: you cannot fire there again.
 *
 * `intel` is this side's own sonar record. A sweep that came back with n
 * hulls in its block is hard information, so a block reported empty is
 * struck off entirely and a crowded one is weighted up.
 */
export function densityMap(enemy, intel = []) {
    const grid = enemy.grid;
    const sunk = new Set(enemy.sunk ?? []);
    const map = new Array(CELLS).fill(0);

    for (const { key, len } of FLEET) {
        if (sunk.has(key)) continue;
        for (let dir of ['h', 'v']) {
            const step = dir === 'v' ? SIZE : 1;
            const rows = dir === 'v' ? SIZE - len + 1 : SIZE;
            const cols = dir === 'h' ? SIZE - len + 1 : SIZE;
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const at = r * SIZE + c;
                    let open = 0;
                    let hits = 0;
                    let dead = false;
                    for (let i = 0; i < len; i++) {
                        const mark = grid[at + i * step];
                        // 'o' is proven water and 's' belongs to a wreck that
                        // is already accounted for, so neither berth survives.
                        if (mark === 'o' || mark === 's' || mark === 'd') { dead = true; break; }
                        if (mark === 'x') hits++; else open++;
                    }
                    if (dead || open === 0) continue;
                    // A berth that would explain a live hit is worth far more
                    // than one lying on virgin water. This is what turns the
                    // hunt into a target run without a second code path.
                    const weight = hits > 0 ? 40 * hits : 1;
                    for (let i = 0; i < len; i++) {
                        const cell = at + i * step;
                        if (grid[cell] === '.') map[cell] += weight;
                    }
                }
            }
        }
    }

    for (const { at, count } of intel ?? []) {
        const block = blockCells(at);
        for (const cell of block) {
            if (count === 0) map[cell] = 0;
            else map[cell] *= 1 + count / block.length;
        }
    }

    for (let i = 0; i < CELLS; i++) if (SPENT.has(grid[i])) map[i] = 0;
    return map;
}

/** The unfired cell with the most berths through it; ties broken by rng. */
function bestCell(map, rng, noise = 0) {
    let best = -1;
    let top = [];
    for (let i = 0; i < CELLS; i++) {
        if (map[i] <= 0) continue;
        if (map[i] > best) { best = map[i]; top = [i]; }
        else if (map[i] === best) top.push(i);
    }
    if (top.length === 0) {
        // Every scored cell is spent. Fall back to any cell left on the plot
        // so the bot can never stall a match by having nothing to say.
        const left = [];
        for (let i = 0; i < CELLS; i++) if (map[i] === 0) left.push(i);
        return left.length ? left[Math.floor(rng() * left.length)] : -1;
    }
    if (noise > 0 && rng() < noise) {
        const any = [];
        for (let i = 0; i < CELLS; i++) if (map[i] > 0) any.push(i);
        return any[Math.floor(rng() * any.length)];
    }
    return top[Math.floor(rng() * top.length)];
}

/** The block whose unfired cells carry the most density, and that total. */
function bestBlock(map) {
    let at = -1;
    let score = -1;
    for (let i = 0; i < CELLS; i++) {
        const sum = blockCells(i).reduce((n, c) => n + map[c], 0);
        if (sum > score) { score = sum; at = i; }
    }
    return { at, score };
}

/** The best three-in-line, and its total. */
function bestLine(map) {
    let best = null;
    let score = -1;
    for (let i = 0; i < CELLS; i++) {
        for (const dir of ['h', 'v']) {
            const cells = barrageCells(i, dir);
            if (!cells) continue;
            const sum = cells.reduce((n, c) => n + map[c], 0);
            if (sum > score) { score = sum; best = { at: i, dir }; }
        }
    }
    return { ...best, score };
}

// ------------------------------------------------------------------
//  Deciding
// ------------------------------------------------------------------

// A depth charge costs the whole bank and a turn. It is only worth it when
// the block it would flatten is worth more than several plain shots, which
// in practice means a sweep or a contact has already narrowed the plot.
const CHARGE_THRESHOLD = 6;
const BARRAGE_THRESHOLD = 3;

/**
 * What this player does with its turn, given only what it can see.
 * `enemy` is enemyView(match, seat), `own` is ownView(match, seat).
 */
export function chooseAction({ enemy, own, policy = POLICIES.full, rng = Math.random }) {
    const map = densityMap(enemy, own.intel);
    const allowed = new Set(policy.abilities ?? []);
    const bank = own.salvage;
    const wrecks = own.sunk.length;
    const afford = (kind) => allowed.has(kind) && bank >= COST[kind] && wrecks >= UNLOCK[kind];
    const flat = map.reduce((n, v) => n + v, 0) / CELLS || 1;

    // 1. The finisher. Only over a block the plot already says is crowded.
    if (afford('depthCharge')) {
        const block = bestBlock(map);
        if (block.score > CHARGE_THRESHOLD * flat) return { kind: 'depthCharge', at: block.at };
    }

    // 2. Three shells down a contact, when one is running in a line.
    if (afford('barrage')) {
        const line = bestLine(map);
        if (line.at >= 0 && line.score > BARRAGE_THRESHOLD * flat) {
            return { kind: 'barrage', at: line.at, dir: line.dir };
        }
    }

    // 3. Run before the guns: a hull nobody has touched yet, moved off a
    //    stretch of plot the enemy is clearly working through.
    if (afford('reposition')) {
        const move = escapeMove(own, rng);
        if (move) return move;
    }

    // 4. Buy information when there is none worth acting on.
    if (afford('sonar') && !enemy.grid.includes('x')) {
        const block = bestBlock(map);
        const swept = new Set((own.intel ?? []).map((i) => i.at));
        if (block.at >= 0 && !swept.has(block.at)) return { kind: 'sonar', at: block.at };
    }

    // 5. Bait, but only against a bank big enough to be worth wasting.
    if (afford('decoy') && own.decoys.length < DECOY_MAX && enemy.salvage >= COST.barrage) {
        const at = openWater(own, rng);
        if (at >= 0) return { kind: 'decoy', at };
    }

    return { kind: 'fire', at: bestCell(map, rng, policy.noise ?? 0) };
}

/**
 * How much attention each of my hulls is under: cells the enemy has already
 * fired at nearby, plus a heavy weight on any block they have swept, which is
 * the one thing they tell me for free.
 */
function escapeMove(own, rng) {
    const lit = new Set((own.swept ?? []).flatMap((at) => blockCells(at)));
    const pressure = (cells) => cells.reduce(
        (n, c) => n + blockCells(c).filter((b) => own.grid[b] !== '.').length + (lit.has(c) ? 6 : 0), 0);

    // Move the biggest hull under the most attention: it is the one worth the
    // most to lose, and the one a search is most likely to blunder into.
    const candidates = own.fleet
        .filter((s) => shipCells(s).every((c) => own.grid[c] === '.'))
        .map((s) => ({ s, heat: pressure(shipCells(s)) }))
        .filter((x) => x.heat >= 8)
        .sort((a, b) => (b.heat - a.heat) || (shipCells(b.s).length - shipCells(a.s).length));
    if (candidates.length === 0) return null;

    const hull = candidates[0].s;
    const rest = own.fleet.filter((s) => s.key !== hull.key);
    const berths = [];
    for (let at = 0; at < CELLS; at++) {
        for (const dir of ['h', 'v']) {
            const moved = { key: hull.key, at, dir };
            if (placementError([moved, ...rest]) !== null) continue;
            const cells = shipCells(moved);
            if (cells.some((c) => own.grid[c] !== '.')) continue;
            if (cells.some((c) => own.decoys.includes(c))) continue;
            berths.push({ moved, heat: pressure(cells) });
        }
    }
    if (berths.length === 0) return null;
    berths.sort((a, b) => a.heat - b.heat);
    // Pick among the coolest berths rather than the single coolest, so two
    // bots do not both run to the same corner every game.
    const cool = berths.filter((b) => b.heat === berths[0].heat);
    const pick = cool[Math.floor(rng() * cool.length)].moved;
    return { kind: 'reposition', ship: pick.key, at: pick.at, dir: pick.dir };
}

/** A cell of my own plot that is open water, unsearched and unoccupied. */
function openWater(own, rng) {
    const hull = new Set(own.fleet.flatMap((s) => shipCells(s)));
    const free = [];
    for (let i = 0; i < CELLS; i++) {
        if (own.grid[i] !== '.' || hull.has(i) || own.decoys.includes(i)) continue;
        free.push(i);
    }
    return free.length ? free[Math.floor(rng() * free.length)] : -1;
}

// ------------------------------------------------------------------
//  Simulation
// ------------------------------------------------------------------

/**
 * Play one whole game between two policies and report how it went. Used by
 * tests/battleship-balance.test.mjs, which is where the design claim that no
 * single ability wins on its own is actually held to account.
 *
 * `firstBlood` is the seat that lost a ship first. `fellBehind` is the seat
 * that first went DEFICIT hull cells down, which is a real material deficit
 * rather than an early scratch, and is the one the comeback measurement uses.
 * Counting ships instead of cells made two lost destroyers look like a lost
 * carrier and washed the measurement out.
 */
export const DEFICIT = 6;

export function playOut({
    seed = 1, policies, starter = 1, maxTurns = 800,
    extraTurnOnHit = false, handicap = [0, 0],
} = {}) {
    const rng = seededRng(seed);
    let match = newMatch({ fleets: [autoPlace(rng), autoPlace(rng)], starter });
    // Start a side genuinely behind, by putting its smallest hulls on the
    // bottom before the first shot. The balance suite uses this to ask
    // whether the unlock ladder lets a losing fleet fight, which two evenly
    // matched bots can never show on their own.
    for (const seat of [1, 2]) match = scuttle(match, seat, handicap[seat - 1]);
    let firstBlood = 0;
    let fellBehind = 0;
    let turns = 0;
    let lastReport = { cells: [] };

    while (!match.outcome && turns < maxTurns) {
        const seat = match.turn;
        const action = chooseAction({
            enemy: enemyView(match, seat),
            own: ownView(match, seat),
            policy: policies[seat - 1],
            rng,
        });
        if (actionError(match, seat, action) !== null) {
            // A policy with nothing legal left to say passes the turn by
            // firing the first open cell; never wedge the simulation.
            const open = match.sides[other(seat)].grid.indexOf('.');
            if (open < 0) break;
            ({ match, report: lastReport } = applyAction(match, seat, { kind: 'fire', at: open }));
        } else {
            ({ match, report: lastReport } = applyAction(match, seat, action));
        }
        // Simulation only, and never a rule of this game: the classic "a hit
        // buys another shot" variant. tests/battleship-balance.test.mjs plays
        // it as the control, because it is the snowball this design removes
        // and the only honest way to show the removal did something.
        if (extraTurnOnHit && !match.outcome
            && lastReport.cells.some((c) => c.result === 'hit' || c.result === 'sunk')) {
            match = { ...match, turn: seat };
        }
        turns++;
        if (!firstBlood) {
            if (sunkCount(match, 1) > 0) firstBlood = 1;
            else if (sunkCount(match, 2) > 0) firstBlood = 2;
        }
        if (!fellBehind && !match.outcome) {
            const hurt = [damageTaken(match, 1), damageTaken(match, 2)];
            if (hurt[0] - hurt[1] >= DEFICIT) fellBehind = 1;
            else if (hurt[1] - hurt[0] >= DEFICIT) fellBehind = 2;
        }
    }

    return {
        outcome: match.outcome,
        turns,
        firstBlood,
        fellBehind,
        shots: [match.sides[1].shots, match.sides[2].shots],
        spent: [match.sides[1].spent, match.sides[2].spent],
    };
}

/** Put a seat's `n` smallest hulls on the bottom before play begins. */
function scuttle(match, seat, n) {
    if (!n) return match;
    const side = match.sides[seat];
    const doomed = [...side.fleet].sort((a, b) => shipCells(a).length - shipCells(b).length).slice(0, n);
    let grid = side.grid;
    for (const ship of doomed) {
        for (const c of shipCells(ship)) grid = grid.slice(0, c) + 's' + grid.slice(c + 1);
    }
    return { ...match, sides: { ...match.sides, [seat]: { ...side, grid } } };
}

const damageTaken = (match, seat) => {
    const g = match.sides[seat].grid;
    let n = 0;
    for (let i = 0; i < g.length; i++) if (g[i] === 'x' || g[i] === 's') n++;
    return n;
};

const sunkCount = (match, seat) => {
    const side = match.sides[seat];
    return side.fleet.filter((s) => shipCells(s).every((c) => side.grid[c] === 's')).length;
};
