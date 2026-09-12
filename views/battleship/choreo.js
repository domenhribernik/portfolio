// BATTLESHIP // choreography planning, DOM free.
//
// The poll hands the page a plot that has already changed. Playing a shot as
// a sequence (the reticle, the wait, the counter landing, the wreck) means the
// page has to show a plot that lags the truth for a second or two, and this
// file decides exactly how far behind it is allowed to be. script.js paints
// what these functions return and adds nothing of its own.
//
// Pure library: no DOM, no timers, no Date. tests/battleship-choreo.test.mjs.

import { CELLS } from './logic.js';

// ------------------------------------------------------------------
//  Tempo. One authored moment, paced like a hand pushing a counter.
// ------------------------------------------------------------------

export const TEMPO = {
    aim: 700,        // the reticle sits on the target before anything lands
    gap: 160,        // between shells of a barrage
    settle: 560,     // after the last counter, before the turn is handed over
    callout: 1100,   // a wreck's name across the plot
    handover: 380,   // between the turn flipping and the plot switching
    think: 750,      // the bot's pause before it moves
};

const STILL = Object.fromEntries(Object.keys(TEMPO).map((k) => [k, 0]));

/** The tempo to play at: the real one, or nothing at all under reduced motion. */
export const tempo = (reduced) => (reduced ? STILL : TEMPO);

/**
 * How one report lands on a plot. Fire and a barrage set their counters one
 * at a time; a depth charge drops all nine at once and shakes the table.
 * Cells whose result is `blast` (open water a charge churned) never change on
 * the plot, but they still land: the splash is the only sign they were hit.
 */
export function landingPlan(op, reduced = false) {
    const t = tempo(reduced);
    const cells = (op.cells ?? []).map((c) => c.cell);
    const charge = op.kind === 'depthCharge';
    return {
        aimMs: t.aim,
        groups: charge ? (cells.length ? [cells] : []) : cells.map((c) => [c]),
        gapMs: charge ? 0 : t.gap,
        settleMs: t.settle,
        shake: charge && cells.length > 0 && !reduced,
    };
}

// ------------------------------------------------------------------
//  Holding a plot back
// ------------------------------------------------------------------

/** Wreck cells in `next` that were not wrecks in `shown`. */
export function newWrecks(shown, next) {
    const out = [];
    for (let i = 0; i < CELLS; i++) {
        if (next[i] === 's' && shown[i] !== 's') out.push(i);
    }
    return out;
}

/**
 * Cells the plot must keep showing as they were, because a report that
 * touches them is still queued to play. A queued sinking also holds every
 * new wreck cell, since the hull it belongs to is not known until it lands.
 * `landed` is the set the currently playing report has already set down.
 */
export function heldCells(queue, shown, next, landed = new Set()) {
    const held = new Set();
    let sinking = false;
    for (const op of queue) {
        if (op.op !== 'shot') continue;
        for (const c of op.cells ?? []) held.add(c.cell);
        if ((op.sunk ?? []).length) sinking = true;
    }
    if (sinking) for (const c of newWrecks(shown, next)) held.add(c);
    for (const c of landed) held.delete(c);
    return held;
}

/** The grid string to paint: `next`, except held cells stay as `shown`. */
export function projectGrid(shown, next, held) {
    if (held.size === 0) return next;
    let out = '';
    for (let i = 0; i < CELLS; i++) out += held.has(i) ? shown[i] : next[i];
    return out;
}

/**
 * The cells to set down for one landing group: the group itself, plus the
 * rest of a wreck when any of them sank. The rest of a hull is every new
 * wreck cell, which is only ambiguous when two hulls sink in one report.
 */
export function landingCells(group, shown, next) {
    const out = new Set(group);
    if (group.some((c) => next[c] === 's')) for (const c of newWrecks(shown, next)) out.add(c);
    return [...out];
}

// ------------------------------------------------------------------
//  Reading a plot for what happened
// ------------------------------------------------------------------

/** Enemy buoys that owned up: a plotted hit that became a decoy. */
export function buoyReveals(shown, next) {
    const out = [];
    for (let i = 0; i < CELLS; i++) {
        if (shown[i] === 'x' && next[i] === 'd') out.push(i);
    }
    return out;
}

/** The newest sonar reading centred on `at`, or null. */
export function readingAt(intel, at) {
    for (let i = (intel ?? []).length - 1; i >= 0; i--) {
        if (intel[i].at === at) return intel[i].count;
    }
    return null;
}

// ------------------------------------------------------------------
//  Which plot the room is looking at
// ------------------------------------------------------------------

/** The plot that should be under the lamp when nothing is being played. */
export function restingSide({ mine, aimsAtSelf }) {
    if (!mine) return 'own';
    return aimsAtSelf ? 'own' : 'enemy';
}

/**
 * A poll can answer with a room that is older than what the page already
 * believes, when the answer left the server before the page's own move
 * arrived. Believing it would hand the turn back for a second and invite a
 * second tap that the server then refuses.
 */
export function isStaleRoom(room, expectTurns) {
    return expectTurns !== null && typeof room?.turns === 'number' && room.turns < expectTurns;
}
