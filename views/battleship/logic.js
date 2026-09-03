// BATTLESHIP // DOM-free rules core.
//
// Everything script.js and bot.js need to think without a browser: the plot,
// the fleet, placement legality, shot resolution, salvage, the five abilities,
// the fog projection, room codes and names, the event reducer and poll pacing.
// node --test tests/ exercises it directly.
//
// Two rules govern this file:
//   1. It is a pure library. No DOM, no fetch, no Date.now() outside pollDelay.
//   2. Every constant below is MIRRORED in app/controllers/battleship-controller.php,
//      which is the authority in a room game. Change them in both; the constants
//      guard in tests/battleship-logic.test.mjs fails if they drift.

// ------------------------------------------------------------------
//  The plot
// ------------------------------------------------------------------

export const SIZE = 10;
export const CELLS = SIZE * SIZE;

const LETTERS = 'ABCDEFGHIJ';

/** The name a plotter reads aloud: column letter, then the one-based row. */
export const coordName = (i) => LETTERS[i % SIZE] + (Math.floor(i / SIZE) + 1);

/** Whether an index names a cell on this plot at all. */
export const onPlot = (cell) => Number.isInteger(cell) && cell >= 0 && cell < CELLS;

/** The cell a plotted name points at, or -1 if it is not on this plot. */
export function cellIndex(name) {
    const m = /^([A-J])([1-9]|10)$/i.exec(String(name ?? '').trim());
    if (!m) return -1;
    return (Number(m[2]) - 1) * SIZE + LETTERS.indexOf(m[1].toUpperCase());
}

// ------------------------------------------------------------------
//  The fleet
// ------------------------------------------------------------------

// Order matters: it is the order the placement screen offers them in, and
// the order the status board lists them in.
export const FLEET = [
    { key: 'carrier', len: 5 },
    { key: 'battleship', len: 4 },
    { key: 'cruiser', len: 3 },
    { key: 'submarine', len: 3 },
    { key: 'destroyer', len: 2 },
];

export const FLEET_CELLS = FLEET.reduce((n, s) => n + s.len, 0);

const lengthOf = (key) => FLEET.find((s) => s.key === key)?.len ?? 0;

/**
 * The cells a ship covers, running right ('h') or down ('v') from its head.
 * Returns them even when they run off the plot; placementError is what judges.
 */
export function shipCells({ key, at, dir }) {
    const step = dir === 'v' ? SIZE : 1;
    const len = lengthOf(key);
    return Array.from({ length: len }, (_, i) => at + i * step);
}

/**
 * Why this fleet may not be laid, or null. Reason codes are refuse.* keys.
 * Ships may touch: adjacency is a placement strategy, not an illegal move.
 */
export function placementError(fleet) {
    if (!Array.isArray(fleet) || fleet.length !== FLEET.length) return 'badFleet';
    const wanted = FLEET.map((s) => s.key).sort();
    const given = fleet.map((s) => s?.key).sort();
    if (wanted.some((k, i) => k !== given[i])) return 'badFleet';

    const taken = new Set();
    for (const s of fleet) {
        if (!Number.isInteger(s.at) || s.at < 0 || s.at >= CELLS) return 'offPlot';
        if (s.dir !== 'h' && s.dir !== 'v') return 'offPlot';
        const len = lengthOf(s.key);
        // A horizontal ship must stay on its own row; the row-major index
        // would otherwise wrap onto the next one and look legal.
        if (s.dir === 'h' && (s.at % SIZE) + len > SIZE) return 'offPlot';
        if (s.dir === 'v' && Math.floor(s.at / SIZE) + len > SIZE) return 'offPlot';
        for (const c of shipCells(s)) {
            if (taken.has(c)) return 'overlap';
            taken.add(c);
        }
    }
    return null;
}

/** A random legal fleet. rng is injectable so tests and the bot are seedable. */
export function autoPlace(rng = Math.random) {
    for (let attempt = 0; attempt < 200; attempt++) {
        const laid = [];
        const taken = new Set();
        let stuck = false;
        for (const { key, len } of FLEET) {
            let placed = null;
            for (let tries = 0; tries < 200 && !placed; tries++) {
                const dir = rng() < 0.5 ? 'h' : 'v';
                const row = Math.floor(rng() * (dir === 'v' ? SIZE - len + 1 : SIZE));
                const col = Math.floor(rng() * (dir === 'h' ? SIZE - len + 1 : SIZE));
                const candidate = { key, at: row * SIZE + col, dir };
                const cells = shipCells(candidate);
                if (cells.some((c) => taken.has(c))) continue;
                placed = candidate;
                for (const c of cells) taken.add(c);
            }
            if (!placed) { stuck = true; break; }
            laid.push(placed);
        }
        if (!stuck) return laid;
    }
    // Unreachable with a sane rng, but a caller must never receive a half fleet.
    throw new Error('autoPlace could not lay a fleet');
}

// ------------------------------------------------------------------
//  Salvage
// ------------------------------------------------------------------

// The economy, and the whole point of this variant. Accuracy pays, and so
// does being shot: the fleet that is losing funds its own comeback, but has
// to aim it. MIRRORED in battleship-controller.php.
export const SALVAGE_CAP = 10;
export const SALVAGE_HIT_DEALT = 1;
// Area fire is deliberately crippled in two ways, and both are load bearing.
//
//   It recovers no salvage. A barrage or a depth charge pays the fleet it
//   lands on and pays the gunner nothing, so heavy weapons cannot refuel
//   themselves and every one funds the other side a little.
//
//   It does not survey. A blast damages what it touches, but the water it
//   churns is NOT plotted as missed, and those cells can be fired at again.
//   This is the important one. The bottleneck in battleship is the search,
//   not the damage, so a weapon that cleared nine cells of the search for one
//   turn was simply a rate multiplier. The balance suite had a depth charge
//   policy taking 83% of its games against a plain gunner before this.
export const AREA_KINDS = ['barrage', 'depthCharge'];
export const SALVAGE_HIT_TAKEN = 1;
// A wreck salvages in proportion to what was lost, so a carrier going down
// funds a real reply and a destroyer funds a sweep. This is the rubber band:
// it is the one income the side that is winning cannot earn.
export const SALVAGE_WRECK_PER_CELL = 2;
export const SALVAGE_SECOND_MOVER = 1;

const cap = (n) => Math.min(SALVAGE_CAP, Math.max(0, n));

// ------------------------------------------------------------------
//  The five abilities
// ------------------------------------------------------------------

// Costs, in salvage. Spending any of these USES THE TURN: that trade, shot
// versus tool, is where the skill in this variant lives. MIRRORED in
// battleship-controller.php.
export const COST = {
    sonar: 2,
    decoy: 3,
    barrage: 4,
    reposition: 3,
    depthCharge: 8,
};

export const ABILITIES = Object.keys(COST);

// How many of YOUR OWN ships have to be on the bottom before a tool is
// available. This, not the salvage economy, is the comeback engine.
//
// Salvage alone did not work and the balance suite proved it: paying the
// losing side more currency is worthless when both sides own the same tools
// and the winning side has the better plot to aim them at. Over 400 simulated
// games the toolbox made comebacks LESS likely, 26.8% against 30.1% without.
// So the heavy tools are gated on wreckage instead. A fleet that is winning
// fights with a sweep and a buoy; a fleet that is burning gets the barrage
// and then the charge. Access is the rubber band, salvage is only the pacing.
//
// Losing hulls on purpose to unlock faster is a real line, and a losing one:
// the unlock buys access, not salvage and not turns, and you still lose when
// the last hull goes down. MIRRORED in battleship-controller.php.
export const UNLOCK = {
    sonar: 0,
    decoy: 0,
    barrage: 1,
    reposition: 1,
    depthCharge: 2,
};

/** Live decoys one side may hold at once. */
export const DECOY_MAX = 2;

/**
 * The three by three around a cell, clipped at the edges rather than wrapped.
 * Sonar and the depth charge share this footprint deliberately: a sweep tells
 * you exactly what a charge on the same cell would catch, which is what makes
 * the pair worth buying and a charge dropped without one a gamble.
 */
export function blockCells(at) {
    if (!onPlot(at)) return [];
    const row = Math.floor(at / SIZE);
    const col = at % SIZE;
    const cells = [];
    for (let r = row - 1; r <= row + 1; r++) {
        for (let c = col - 1; c <= col + 1; c++) {
            if (r >= 0 && r < SIZE && c >= 0 && c < SIZE) cells.push(r * SIZE + c);
        }
    }
    return cells;
}

/** Three adjacent cells from `at`, or null if they would leave the row or column. */
export function barrageCells(at, dir) {
    if (!onPlot(at) || (dir !== 'h' && dir !== 'v')) return null;
    if (dir === 'h' && (at % SIZE) + 3 > SIZE) return null;
    if (dir === 'v' && Math.floor(at / SIZE) + 3 > SIZE) return null;
    const step = dir === 'v' ? SIZE : 1;
    return [at, at + step, at + 2 * step];
}

/** Why `seat` may not spend on this ability, or null. */
export function abilityError(match, seat, action) {
    const kind = action?.kind;
    if (!ABILITIES.includes(kind)) return 'badAction';
    const mine = match.sides[seat];
    if (sunkShips(mine).length < UNLOCK[kind]) return 'locked';
    if (mine.salvage < COST[kind]) return 'broke';

    switch (kind) {
        case 'sonar':
        case 'depthCharge':
            return onPlot(action.at) ? null : 'offPlot';

        case 'barrage':
            return barrageCells(action.at, action.dir) ? null : 'offPlot';

        case 'decoy': {
            if (!onPlot(action.at)) return 'offPlot';
            if (mine.decoys.length >= DECOY_MAX) return 'tooManyDecoys';
            if (isSpent(mine.grid[action.at])) return 'spent';
            // A buoy sits on open water. On a hull it would be a second life
            // for a cell that already has one.
            if (mine.fleet.some((s) => shipCells(s).includes(action.at))) return 'occupied';
            if (mine.decoys.includes(action.at)) return 'occupied';
            return null;
        }

        case 'reposition': {
            const hull = mine.fleet.find((s) => s.key === action.ship);
            if (!hull) return 'badShip';
            // A ship the enemy has already touched is pinned. Escaping a hunt
            // you are losing would make every deduction worthless.
            if (shipCells(hull).some((c) => mine.grid[c] !== '.')) return 'damaged';

            const moved = { key: action.ship, at: action.at, dir: action.dir };
            const rest = mine.fleet.filter((s) => s.key !== action.ship);
            if (placementError([moved, ...rest]) !== null) {
                return placementError([moved, ...rest]) === 'overlap' ? 'overlap' : 'offPlot';
            }
            // The berth must be virgin water: a plotted miss must never quietly
            // stop being true under the enemy who plotted it.
            if (shipCells(moved).some((c) => mine.grid[c] !== '.')) return 'searched';
            if (shipCells(moved).some((c) => mine.decoys.includes(c))) return 'occupied';
            return null;
        }

        default:
            return 'badAction';
    }
}

// ------------------------------------------------------------------
//  The match
// ------------------------------------------------------------------

export const EMPTY_GRID = '.'.repeat(CELLS);

// A grid cell, from the point of view of the fleet being shot at:
//   .  unfired      o  miss             x  hit, ship still afloat
//   s  sunk hull    D  decoy popped, not yet revealed
//   d  decoy, revealed
const isSpent = (mark) => mark !== '.';

export const other = (seat) => (seat === 1 ? 2 : 1);

function newSide(fleet, salvage) {
    return {
        fleet,                // THE SECRET. Never leaves this side's own payload.
        grid: EMPTY_GRID,     // what has been fired AT this side
        decoys: [],           // THE SECRET. Live decoy cells.
        salvage,
        spent: 0,
        shots: 0,
        hits: 0,
        intel: [],            // sonar counts this side has bought (private)
        swept: [],            // blocks the ENEMY has swept against me (public)
        moved: 0,             // repositions this side has made
    };
}

/** A fresh battle. `starter` moves first; the other opens with a salvage. */
export function newMatch({ fleets, starter = 1 }) {
    const second = other(starter);
    return {
        status: 'battle',
        turn: starter,
        starter,
        turns: 0,
        outcome: null,        // 'p1' | 'p2'; digit strings, never bare ints
        sides: {
            [starter]: newSide(fleets[starter - 1], 0),
            [second]: newSide(fleets[second - 1], SALVAGE_SECOND_MOVER),
        },
    };
}

const setMark = (grid, cell, mark) => grid.slice(0, cell) + mark + grid.slice(cell + 1);

/** The ships of `side` that have taken a hit on every one of their cells. */
export function sunkShips(side) {
    return side.fleet
        .filter((s) => shipCells(s).every((c) => side.grid[c] === 'x' || side.grid[c] === 's'))
        .map((s) => s.key);
}

/** The ship covering `cell`, or undefined. */
const shipAt = (side, cell) => side.fleet.find((s) => shipCells(s).includes(cell));

// ------------------------------------------------------------------
//  Resolving fire
// ------------------------------------------------------------------

/**
 * Resolve one shell against `side`, mutating a working copy. Returns the
 * result: miss | hit | sunk | decoy. A decoy resolves as `hit` to everyone
 * watching, and only stops looking like one on the owner's next turn.
 */
function strike(side, cell, survey) {
    if (isSpent(side.grid[cell])) return null;   // already plotted; nothing happens

    const decoyAt = side.decoys.indexOf(cell);
    if (decoyAt >= 0) {
        side.decoys = side.decoys.filter((_, i) => i !== decoyAt);
        side.grid = setMark(side.grid, cell, 'D');
        return 'decoy';
    }

    const hull = shipAt(side, cell);
    if (!hull) {
        // A blast that finds nothing tells the gunner nothing: the cell stays
        // open and has to be searched properly later. See AREA_KINDS.
        if (!survey) return 'blast';
        side.grid = setMark(side.grid, cell, 'o');
        return 'miss';
    }

    side.grid = setMark(side.grid, cell, 'x');
    const cells = shipCells(hull);
    if (cells.every((c) => side.grid[c] === 'x' || side.grid[c] === 's')) {
        // Restrike the whole hull as sunk, so the plot shows the wreck, not
        // five unrelated hits the reader still has to join up.
        for (const c of cells) side.grid = setMark(side.grid, c, 's');
        return 'sunk';
    }
    return 'hit';
}

/**
 * Why `seat` may not take this action, or null. Reason codes are refuse.* keys,
 * and the controller sends the same ones, so the client can translate either.
 */
export function actionError(match, seat, action) {
    if (match.status !== 'battle' || match.outcome) return 'over';
    if (match.turn !== seat) return 'notYourTurn';
    const kind = action?.kind;
    if (kind === 'fire') {
        const cell = action.at;
        if (!onPlot(cell)) return 'offPlot';
        if (isSpent(match.sides[other(seat)].grid[cell])) return 'spent';
        return null;
    }
    return abilityError(match, seat, action);
}

/**
 * Apply an action and hand back a NEW match plus a report of what happened.
 * Refuses nothing: call actionError first. In a room game the controller runs
 * this same reasoning over the stored row, and its answer is the only one that
 * counts; this copy drives solo play, the bot, and the client's preview.
 */
export function applyAction(match, seat, action) {
    const foe = other(seat);
    const mine = { ...match.sides[seat] };
    const theirs = { ...match.sides[foe] };

    // A decoy of mine that popped last turn stops pretending now. Doing it
    // here means the reveal always lands exactly one turn after the shot.
    mine.grid = mine.grid.replace(/D/g, 'd');

    const report = { cells: [], sunk: [], intel: null, swept: null, moved: false, kind: action.kind };
    let gainMine = 0;
    let gainTheirs = 0;

    // Only aimed fire refuels the gunner. See AREA_KINDS.
    const paysFirer = !AREA_KINDS.includes(action.kind);

    const resolve = (cells) => {
        for (const cell of cells) {
            const result = strike(theirs, cell, paysFirer);
            if (!result) continue;
            report.cells.push({ cell, result });
            mine.shots++;
            if (result === 'miss' || result === 'blast') continue;
            mine.hits++;
            // A decoy pays out exactly like a hull. If it did not, the public
            // tote board would give the bluff away on the very next glance.
            if (paysFirer) gainMine += SALVAGE_HIT_DEALT;
            gainTheirs += SALVAGE_HIT_TAKEN;
            if (result === 'sunk') {
                const hull = shipAt(theirs, cell);
                gainTheirs += SALVAGE_WRECK_PER_CELL * shipCells(hull).length;
                report.sunk.push(hull.key);
            }
        }
    };

    switch (action.kind) {
        case 'fire':
            resolve([action.at]);
            break;
        case 'sonar': {
            const cells = blockCells(action.at);
            const count = cells.filter((c) => shipAt(theirs, c)).length;
            // The count is yours alone. WHERE you swept is not: a sweep lights
            // the water, and the fleet under it can see that much. Information
            // costing information is what gives reposition something to react
            // to, and stops a sweep from being free.
            report.intel = { at: action.at, count };
            report.swept = action.at;
            mine.intel = [...mine.intel, report.intel];
            theirs.swept = [...theirs.swept, action.at];
            break;
        }
        case 'decoy':
            mine.decoys = [...mine.decoys, action.at];
            break;
        case 'barrage':
            resolve(barrageCells(action.at, action.dir));
            break;
        case 'reposition': {
            mine.fleet = mine.fleet.map((s) => (s.key === action.ship
                ? { key: s.key, at: action.at, dir: action.dir }
                : s));
            mine.moved++;
            report.moved = true;
            break;
        }
        case 'depthCharge':
            resolve(blockCells(action.at));
            break;
        default:
            break;
    }

    if (action.kind !== 'fire') mine.spent += COST[action.kind] ?? 0;
    mine.salvage = cap(mine.salvage - (COST[action.kind] ?? 0) + gainMine);
    theirs.salvage = cap(theirs.salvage + gainTheirs);

    const down = sunkShips(theirs).length === FLEET.length;
    return {
        match: {
            ...match,
            sides: { [seat]: mine, [foe]: theirs },
            turn: down ? match.turn : foe,
            turns: match.turns + 1,
            status: down ? 'over' : match.status,
            outcome: down ? (seat === 1 ? 'p1' : 'p2') : match.outcome,
        },
        report,
    };
}

// ------------------------------------------------------------------
//  The fog
// ------------------------------------------------------------------

// Battleship's one load-bearing rule: a fleet is a secret, exactly the way a
// spy's role is. These two projections are the ONLY way a side becomes a
// payload. They are built up from what is known rather than filtered down
// from what is stored, so a secret added later cannot leak by being
// forgotten in a blacklist.

/** Everything `seat` is allowed to know about the other side. */
export function enemyView(match, seat) {
    const foe = match.sides[other(seat)];
    return {
        // A buoy that popped last turn still reads as a hit. It confesses on
        // its owner's next action, not on the shooter's next poll.
        grid: foe.grid.replace(/D/g, 'x'),
        sunk: sunkShips(foe),
        afloat: FLEET.length - sunkShips(foe).length,
        // The tote board is public on purpose: reading what the other side can
        // afford, and guessing what they are saving for, is half the game.
        salvage: foe.salvage,
    };
}

/** Everything `seat` knows about itself, secrets included. */
export function ownView(match, seat) {
    const mine = match.sides[seat];
    return {
        fleet: mine.fleet,
        grid: mine.grid,
        decoys: mine.decoys,
        intel: mine.intel,
        swept: mine.swept,
        salvage: mine.salvage,
        sunk: sunkShips(mine),
        shots: mine.shots,
        hits: mine.hits,
        spent: mine.spent,
    };
}

// ------------------------------------------------------------------
//  Codes and names
// ------------------------------------------------------------------

export function normalizeCode(raw) {
    return String(raw ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}

export function isValidCode(code) {
    return /^[A-Z]{4}$/.test(code ?? '');
}

export function cleanName(raw) {
    return String(raw ?? '')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Counted in code points, so an emoji is one character rather than two. */
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
 * has to animate. Neither plot ever comes from here: the server owns both and
 * the poll snapshot carries them. These are only the moments worth a counter
 * sliding or a stamp landing.
 *
 * Nothing secret can travel in an event, by construction: sonar counts live
 * in their own private channel and a reposition says only that it happened.
 * Unknown types are ignored while the cursor still advances, so an old tab
 * never desyncs or spins against a newer server.
 */
export function applyEvents(model, events, selfId) {
    const ops = [];
    for (const ev of events ?? []) {
        model.lastSeq = Math.max(model.lastSeq, ev.seq);
        const d = ev.data ?? {};
        switch (ev.type) {
            case 'placed':
                ops.push({ op: 'placed', seat: d.seat ?? null });
                break;
            case 'start':
                model.status = 'battle';
                ops.push({ op: 'start' });
                break;
            case 'shot':
                ops.push({
                    op: 'shot',
                    seat: d.seat ?? null,
                    kind: d.kind ?? 'fire',
                    cells: d.cells ?? [],
                    sunk: d.sunk ?? [],
                });
                break;
            case 'sunk':
                ops.push({ op: 'sunk', seat: d.seat ?? null, ship: d.ship ?? null });
                break;
            case 'swept':
                // Carries the block, never the count. The sweeper's reading
                // is theirs; the fact that they looked is not.
                ops.push({ op: 'swept', seat: d.seat ?? null, at: d.at ?? null });
                break;
            case 'moved':
                // Deliberately carries no ship and no berth. The enemy learns
                // that their plot went stale, and has to work out where.
                ops.push({ op: 'moved', seat: d.seat ?? null });
                break;
            case 'verdict':
                model.status = 'over';
                ops.push({ op: 'verdict', outcome: d.outcome ?? null });
                break;
            case 'again':
                model.status = 'place';
                ops.push({ op: 'again' });
                break;
            case 'abandon':
                // A match needs two seats. Losing one voids it back to the
                // lobby so the shared link still works for whoever turns up.
                model.status = 'lobby';
                ops.push({ op: 'abandon' });
                break;
            case 'host':
                ops.push({ op: 'host', id: d.id ?? null, mine: d.id === selfId });
                break;
        }
    }
    return ops;
}

// ------------------------------------------------------------------
//  Poll pacing
// ------------------------------------------------------------------

/**
 * How long to wait before the next poll. A two seat game has one moment that
 * matters: the stretch where the other side is thinking and the plot can
 * change without you. On your own turn nothing moves until you move it, so
 * that is the cheapest phase on the page. Placement is simultaneous, so it
 * sits in between.
 */
export function pollDelay({ status, hidden = false, failures = 0, waiting = false } = {}) {
    if (failures > 0) return Math.min(10000, 800 * 2 ** failures);
    if (hidden) return 4000;
    if (status === 'lobby') return 1000;
    if (status === 'place') return 1200;
    if (status === 'battle') return waiting ? 900 : 3000;
    return 2500;
}
