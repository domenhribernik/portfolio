// The Peal sheet: a bell founder's drawing wired to a working ring of bells.
//
// The decisions live in logic.js and the sound lives in tower.js. This file
// draws, and it draws the same four things over and over: the bell in section,
// the rows with their lines cut through, the chamber plan, and the title block.

import { METHODS, methodByKey } from './methods.js';
import {
    analyseMethod, rowToString, placeToSymbol, bellPath,
    bellName, stageName, bellHz, bellPartials,
    scoreCourse, bandFor, bellBefore, rounds
} from './logic.js';
import { Tower, Ringing } from './tower.js';

const $ = (id) => document.getElementById(id);

const el = {
    bellSvg: $('bellSvg'), bellTitle: $('bellTitle'),
    bellStage: $('bellStage'), bellBody: $('bellBody'), bellOutline: $('bellOutline'),
    bellInner: $('bellInner'), bellHatch: $('bellHatch'), bellLeaders: $('bellLeaders'),
    partials: $('partials'),
    rows: $('rows'), rowsScroll: $('rowsScroll'), rowsGrid: $('rowsGrid'), rowsScale: $('rowsScale'),
    rowsLines: $('rowsLines'), rowsMeta: $('rowsMeta'), rowsZero: $('rowsZero'),
    plan: $('plan'), planSvg: $('planSvg'), planNote: $('planNote'),
    schedule: $('schedule'), scheduleBody: $('scheduleBody'),
    methodPick: $('methodPick'), methodClass: $('methodClass'),
    figNotation: $('figNotation'), figStage: $('figStage'),
    figChanges: $('figChanges'), figLeads: $('figLeads'), figRope: $('figRope'),
    speed: $('speed'), speedNote: $('speedNote'),
    goBtn: $('goBtn'), muteBtn: $('muteBtn'),
    tally: $('tally'), pullBtn: $('pullBtn'), pullCue: $('pullCue'),
    verdict: $('verdict'), verdictTitle: $('verdictTitle'), verdictLine: $('verdictLine'),
    verdictFigs: $('verdictFigs'), againBtn: $('againBtn'), closeVerdict: $('closeVerdict'),
    library: $('library'), libraryMeta: $('libraryMeta'),
    swapStage: $('swapStage'), swapNote: $('swapNote'),
    crier: $('crier')
};

const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (name, attrs = {}) => {
    const node = document.createElementNS(SVGNS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
};

const calm = window.matchMedia('(prefers-reduced-motion: reduce)');

const state = {
    method: methodByKey('plain-bob-6'),
    analysis: null,
    myBell: 0,          // 0 while the tower rings every rope itself
    traced: 2,          // the line cut through the rows
    gapMs: 300,
    ropes: new Map(),   // bell number to its <g> in the plan
    rowNodes: [],
    tickNodes: new Map(),
    muted: false
};

const tower = new Tower();
const ringing = new Ringing(tower, {
    onBlow: (blow) => atSoundTime(blow, () => showBlow(blow)),
    onRow: (i) => showRow(i),
    onMiss: (i) => markMiss(i),
    onEnd: (why) => finish(why)
});

//? ---------------------------------------------------------------------------
//? Plate 1: the bell in section
//?
//? One profile, scaled by bell. A treble is a small bell and a tenor is a large
//? one, and the drawing says so rather than relying on a caption.
//? ---------------------------------------------------------------------------

// The profile a founder sweeps with a strickle board: crown, shoulder, waist,
// then the flare into the soundbow where the clapper lands. Axis at x=108.
const OUTER = 'M78,84 L122,84 C142,88 154,102 154,124 C154,162 152,184 153,212'
    + ' C155,246 162,268 172,286 C179,296 184,300 184,306 L16,306'
    + ' C16,300 21,296 28,286 C38,268 45,246 47,212'
    + ' C48,184 46,162 46,124 C46,102 58,88 78,84 Z';

const INNER = 'M86,92 L114,92 C132,96 143,108 143,128 C143,164 141,186 142,214'
    + ' C144,246 150,266 159,283 C165,292 169,297 169,306 L31,306'
    + ' C31,297 35,292 41,283 C50,266 56,246 58,214'
    + ' C59,186 57,164 57,128 C57,108 68,96 86,92 Z';

// Where the five leaders touch the bell, and how far out its wall is there.
const TOUCH = [
    { name: 'hum', y: 116, x: 148 },
    { name: 'quint', y: 160, x: 147 },
    { name: 'prime', y: 204, x: 149 },
    { name: 'tierce', y: 250, x: 158 },
    { name: 'nominal', y: 296, x: 177 }
];

const BELL_ORIGIN = { x: 108, y: 76 };
const LIP = { y: 316, left: 34, right: 182 };
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// The note a frequency sits on, which is how a ring of bells is described:
// a tower is known by its tenor's weight and its tenor's note.
function noteName(hz) {
    const n = Math.round(12 * Math.log2(hz / 440));
    return NOTE_NAMES[((n + 9) % 12 + 12) % 12] + (4 + Math.floor((n + 9) / 12));
}
const LEADER_END = 190;
const LABEL_X = 195;
const LABEL_Y = [110, 165, 220, 275, 330];

el.bellOutline.setAttribute('d', OUTER);
el.bellInner.setAttribute('d', INNER);
el.bellHatch.setAttribute('d', `${OUTER} ${INNER}`);

function drawBell(bell) {
    const stage = state.method.stage;
    const scale = 0.62 + 0.38 * ((bell - 1) / Math.max(1, stage - 1));
    el.bellBody.setAttribute('transform',
        `translate(${BELL_ORIGIN.x} ${BELL_ORIGIN.y}) scale(${scale.toFixed(3)}) translate(${-BELL_ORIGIN.x} ${-BELL_ORIGIN.y})`);

    el.bellTitle.textContent = bellName(bell, stage);

    const hz = bellHz(bell, stage, tower.tenorHz);
    const partials = bellPartials(hz);
    const loudest = partials.reduce((a, b) => (b.gain > a.gain ? b : a)).name;

    // The leaders run from the metal they measure out to the figures. The touch
    // point rides the scale, so the line still lands on the wall of this bell.
    el.bellLeaders.replaceChildren();
    TOUCH.forEach((t, i) => {
        const p = partials.find((x) => x.name === t.name);
        const ty = BELL_ORIGIN.y + (t.y - BELL_ORIGIN.y) * scale;
        const tx = BELL_ORIGIN.x + (t.x - BELL_ORIGIN.x) * scale;
        const ly = LABEL_Y[i];
        el.bellLeaders.append(
            svg('path', { d: `M${tx.toFixed(1)},${ty.toFixed(1)} L${LEADER_END - 30},${ly} L${LEADER_END},${ly}` }),
            svg('circle', { cx: tx, cy: ty, r: 2.5 })
        );
        const name = svg('text', { x: LABEL_X, y: ly - 9, class: 'lead-name' });
        name.textContent = t.name;
        const fig = svg('text', { x: LABEL_X, y: ly + 9, class: 'lead-fig' + (t.name === loudest ? ' is-loud' : '') });
        fig.textContent = `${p.hz.toFixed(1)} Hz`;
        el.bellLeaders.append(name, fig);
    });

    // The mouth, dimensioned: witness lines off the lip, arrowheads on the
    // dimension line, and the note this bell strikes written on it.
    const lipY = BELL_ORIGIN.y + (LIP.y - BELL_ORIGIN.y) * scale;
    const l = BELL_ORIGIN.x + (LIP.left - BELL_ORIGIN.x) * scale;
    const r = BELL_ORIGIN.x + (LIP.right - BELL_ORIGIN.x) * scale;
    const dy = lipY + 30;
    $('bellDim').replaceChildren(
        svg('line', { x1: l, y1: lipY + 3, x2: l, y2: dy + 6 }),
        svg('line', { x1: r, y1: lipY + 3, x2: r, y2: dy + 6 }),
        svg('line', { x1: l, y1: dy, x2: r, y2: dy }),
        svg('path', { d: `M${l},${dy} l9,-3.5 v7 z` }),
        svg('path', { d: `M${r},${dy} l-9,-3.5 v7 z` })
    );
    const dimLabel = svg('text', { x: (l + r) / 2, y: dy + 20, class: 'dim-label' });
    dimLabel.textContent = 'strike note';
    const dimFig = svg('text', { x: (l + r) / 2, y: dy - 13, class: 'dim-fig' });
    dimFig.textContent = noteName(hz);
    $('bellDim').append(dimLabel, dimFig);

    // The same figures again for narrow sheets, where the leaders are hidden.
    el.partials.replaceChildren(...partials.slice(0, 5).map((p) => {
        const li = document.createElement('li');
        li.className = p.name === loudest ? 'is-loud' : '';
        li.innerHTML = `<i>${p.name}</i><b>${p.hz.toFixed(1)} Hz</b>`;
        return li;
    }));
}

// The ring, listed. It is the only place the whole tuning is visible at once,
// and it is a fourth surface where picking a bell lights that bell everywhere.
function drawSchedule() {
    const stage = state.method.stage;
    el.scheduleBody.replaceChildren(...Array.from({ length: stage }, (_, i) => {
        const bell = i + 1;
        const hz = bellHz(bell, stage, tower.tenorHz);
        const nominal = bellPartials(hz).find((p) => p.name === 'nominal');
        const tr = document.createElement('tr');
        tr.tabIndex = 0;
        tr.dataset.bell = String(bell);
        if (bell === state.myBell) tr.className = 'is-mine';
        else if (bell === state.traced) tr.className = 'is-traced';
        tr.innerHTML = `<th scope="row">${placeToSymbol(bell)} ${bellName(bell, stage)}</th>`
            + `<td>${noteName(hz)}</td><td>${nominal.hz.toFixed(1)} Hz</td>`;
        tr.addEventListener('click', () => takeRope(bell));
        tr.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); takeRope(bell); }
        });
        return tr;
    }));
}

//? ---------------------------------------------------------------------------
//? Plate 2: the rows
//? ---------------------------------------------------------------------------

const ROW_H = () => (window.innerWidth < 560 ? 22 : 26);
const CHAR_W = () => (window.innerWidth < 560 ? 17 : 20);
const TICK_SCALE = 52;  // pixels that one whole bell width of error draws as

// The zero the deviation bars are measured from, set just left of the digit
// block so a bar reads against the row it belongs to rather than across a gap.
function zeroX() {
    const width = el.rowsScroll.clientWidth || el.rows.clientWidth;
    return Math.max(6, width / 2 - (state.method.stage / 2) * CHAR_W() - TICK_SCALE - 14);
}

function drawRows() {
    const { rows, stage } = { rows: state.analysis.rows, stage: state.method.stage };
    const h = ROW_H();
    const w = CHAR_W();

    el.rowsGrid.replaceChildren();
    state.rowNodes = [];
    state.tickNodes = new Map();

    const leadLength = state.analysis.leadLength;
    const frag = document.createDocumentFragment();

    rows.forEach((row, i) => {
        const div = document.createElement('div');
        div.className = 'row' + (i % leadLength === 0 ? ' is-lead' : '');
        div.style.top = `${i * h - h / 2}px`;
        div.style.height = `${h}px`;
        div.style.fontSize = `${Math.round(h * 0.62)}px`;

        for (const bell of row) {
            const b = document.createElement('b');
            b.style.width = `${w}px`;
            b.textContent = placeToSymbol(bell);
            if (bell === state.traced) b.className = state.myBell ? 'is-mine' : 'is-traced';
            div.append(b);
        }
        frag.append(div);
        state.rowNodes.push(div);
    });

    el.rowsGrid.append(frag);
    el.rowsGrid.style.height = `${rows.length * h}px`;
    drawLines();

    el.rowsMeta.textContent = `${state.analysis.courseLength} changes / tracing the ${bellName(state.traced, stage)}`;
    el.rowsZero.style.left = `${zeroX()}px`;
    el.rowsZero.hidden = state.myBell === 0;
    drawScale();
}

// The blue line, which on this sheet is not blue. The treble is a heavy bone
// stroke and the traced bell is the only pour on the plate.
function drawLines() {
    const rows = state.analysis.rows;
    const stage = state.method.stage;
    const h = ROW_H();
    const w = CHAR_W();
    const width = el.rowsScroll.clientWidth || el.rows.clientWidth;
    const mid = width / 2;

    el.rowsLines.setAttribute('width', width);
    el.rowsLines.setAttribute('height', rows.length * h);
    el.rowsLines.style.top = `${-h / 2}px`;
    el.rowsLines.replaceChildren();

    const pathFor = (bell) => bellPath(rows, bell)
        .map((place, i) => `${i ? 'L' : 'M'}${(mid + (place - (stage + 1) / 2) * w).toFixed(1)},${(i * h + h / 2).toFixed(1)}`)
        .join(' ');

    if (state.traced !== 1) el.rowsLines.append(svg('path', { class: 'line--treble', d: pathFor(1) }));
    el.rowsLines.append(svg('path', {
        class: state.myBell ? 'line--mine' : 'line--traced',
        d: pathFor(state.traced)
    }));
}

// At rest the plate is a printed page read from the top; the strip chart only
// takes over once the bells are going.
function parkRows() {
    const h = ROW_H();
    for (const node of state.rowNodes) node.classList.remove('is-now');
    el.rowsScroll.style.transform = `translateY(${-(el.rows.clientHeight / 2) + h * 1.1}px)`;
}

// The scale the deviation bars are read against.
function drawScale() {
    const zero = zeroX();
    el.rowsScale.hidden = state.myBell === 0;
    if (state.myBell === 0) return;

    el.rowsScale.style.left = `${zero - TICK_SCALE - 1}px`;
    el.rowsScale.style.width = `${TICK_SCALE * 2 + 2}px`;

    const ticks = [-1, -0.5, 0, 0.5, 1].map((f) => {
        const tick = document.createElement('span');
        tick.style.left = `${TICK_SCALE + f * TICK_SCALE + 1}px`;
        if (f === 0) tick.className = 'is-zero';
        return tick;
    });
    const caption = document.createElement('b');
    caption.textContent = `quick · ${state.gapMs} ms · slow`;
    el.rowsScale.replaceChildren(...ticks, caption);
}

function showRow(i) {
    const h = ROW_H();
    for (const node of state.rowNodes) node.classList.remove('is-now');
    state.rowNodes[i]?.classList.add('is-now');
    el.rowsScroll.style.transform = `translateY(${-i * h}px)`;
}

// A struck blow leaves a mark on its own row: a bar drawn left of the zero
// rule when it was early and right of it when it was late.
function markStrike(index, errorMs) {
    const blow = ringing.owed[index];
    if (!blow) return;
    const row = state.rowNodes[blow.row];
    if (!row) return;

    const px = Math.max(-TICK_SCALE, Math.min(TICK_SCALE, (errorMs / state.gapMs) * TICK_SCALE));
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.style.left = `${zeroX() + Math.min(0, px)}px`;
    tick.style.width = `${Math.max(2, Math.abs(px))}px`;
    row.append(tick);
    state.tickNodes.set(index, tick);
}

function markMiss(index) {
    const blow = ringing.owed[index];
    const row = state.rowNodes[blow?.row];
    if (!row || state.tickNodes.has(index)) return;
    const tick = document.createElement('span');
    tick.className = 'tick tick--missed';
    tick.style.left = `${zeroX()}px`;
    row.append(tick);
    state.tickNodes.set(index, tick);
    updateTally();
}

//? ---------------------------------------------------------------------------
//? Plate 3: the chamber
//?
//? The ropes hang in a circle in bell order, because that is how a ringing
//? chamber is laid out, and watching a strike travel round that circle in a
//? different order every row is what rope sight actually is.
//? ---------------------------------------------------------------------------

function drawPlan() {
    const stage = state.method.stage;
    const R = 108;
    const cx = 150, cy = 150;

    el.planSvg.replaceChildren();
    state.ropes.clear();

    el.planSvg.append(
        svg('circle', { class: 'plan__floor', cx, cy, r: 138 }),
        svg('circle', { class: 'plan__circle', cx, cy, r: R })
    );

    for (let bell = 1; bell <= stage; bell++) {
        // The treble hangs at the top and the rest run round clockwise.
        const a = (-Math.PI / 2) + (2 * Math.PI * (bell - 1)) / stage;
        const x = cx + R * Math.cos(a);
        const y = cy + R * Math.sin(a);

        const g = svg('g', {
            class: 'rope',
            tabindex: '0',
            role: 'button',
            'aria-pressed': 'false',
            'aria-label': `Take the ${bellName(bell, stage)}`
        });
        // Seen from above a rope is a coil of wool with its tail lying toward
        // the wall. The wool is what a ringer's hands actually grip.
        const tx = cx + (R + 44) * Math.cos(a);
        const ty = cy + (R + 44) * Math.sin(a);
        g.append(
            svg('circle', { class: 'rope__hit', cx: x, cy: y, r: 30 }),
            svg('path', { class: 'rope__tail', d: `M${x.toFixed(1)},${y.toFixed(1)} L${tx.toFixed(1)},${ty.toFixed(1)}` }),
            svg('circle', { class: 'rope__coil', cx: x, cy: y, r: 24 })
        );
        for (let k = 0; k < 12; k++) {
            const wa = (2 * Math.PI * k) / 12;
            g.append(svg('path', {
                class: 'rope__wool',
                d: `M${(x + 16 * Math.cos(wa)).toFixed(1)},${(y + 16 * Math.sin(wa)).toFixed(1)}`
                    + ` L${(x + 23 * Math.cos(wa)).toFixed(1)},${(y + 23 * Math.sin(wa)).toFixed(1)}`
            }));
        }
        g.append(svg('circle', { class: 'rope__sally', cx: x, cy: y, r: 15 }));
        const label = svg('text', { class: 'rope__label', x, y });
        label.textContent = placeToSymbol(bell);
        g.append(label);

        const take = () => takeRope(bell);
        g.addEventListener('click', take);
        g.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); take(); }
        });

        const err = svg('text', { class: 'rope__err', x, y: y + 40 });
        g.append(err);

        el.planSvg.append(g);
        state.ropes.set(bell, g);
    }
}

//? ---------------------------------------------------------------------------
//? Taking a rope
//? ---------------------------------------------------------------------------

function takeRope(bell) {
    const mine = state.myBell === bell ? 0 : bell;
    stopRinging('stood', true);
    state.myBell = mine;
    state.traced = mine || 2;

    for (const [b, g] of state.ropes) {
        g.classList.toggle('is-mine', b === mine);
        g.classList.toggle('is-traced', b === (mine || 2) && !mine);
        g.setAttribute('aria-pressed', String(b === mine));
        g.setAttribute('aria-label', b === mine
            ? `Give the ${bellName(b, state.method.stage)} back to the tower`
            : `Take the ${bellName(b, state.method.stage)}`);
    }

    el.figRope.textContent = mine ? bellName(mine, state.method.stage) : 'tower';
    el.figRope.classList.toggle('is-mine', Boolean(mine));
    el.planNote.textContent = mine
        ? `You have the ${bellName(mine, state.method.stage)}. Look to, then pull on every one of its blows. Nobody will ring it for you.`
        : 'Take a rope and the tower stops ringing that bell. Strike it yourself, on the beat, and your blows are measured against where they belonged.';

    el.tally.hidden = !mine;
    el.rowsZero.hidden = !mine;
    drawBell(state.traced);
    drawSchedule();
    drawRows();
    say(mine ? `You have the ${bellName(mine, state.method.stage)}.` : 'The tower has all the ropes.');
}

//? ---------------------------------------------------------------------------
//? Ringing
//? ---------------------------------------------------------------------------

// A blow is booked with the audio clock up to a third of a second early, so the
// drawing waits for the sound rather than running ahead of it.
function atSoundTime(blow, fn) {
    const delay = Math.max(0, ringing.startedAt * 1000 + blow.at - tower.now * 1000);
    if (delay < 12) fn();
    else setTimeout(fn, delay);
}

function showBlow(blow) {
    if (!ringing.running) return;
    if (blow.bell === state.myBell) return;   // nobody rings your bell but you
    flash(blow.bell);
}

// Hot on the strike, cooling over that bell's own hum time, so a tenor's glow
// outlasts a treble's the way its sound does.
function flash(bell) {
    const stage = state.method.stage;
    const hum = bellPartials(bellHz(bell, stage, tower.tenorHz))[0].seconds;
    const cool = `${Math.round(Math.min(1400, hum * 130))}ms`;

    const rope = state.ropes.get(bell);
    if (rope) {
        rope.style.setProperty('--cool', cool);
        rope.classList.add('is-struck');
        requestAnimationFrame(() => requestAnimationFrame(() => rope.classList.remove('is-struck')));
    }

    drawBell(bell);
    el.bellStage.style.setProperty('--cool', cool);
    el.bellStage.classList.add('is-struck');
    requestAnimationFrame(() => requestAnimationFrame(() => el.bellStage.classList.remove('is-struck')));
}

async function startRinging() {
    if (ringing.running) { stopRinging('stood'); return; }
    if (!(await tower.wake())) { say('This browser will not make a sound.'); return; }

    for (const node of state.rowNodes) node.querySelectorAll('.tick').forEach((t) => t.remove());
    state.tickNodes.clear();
    printRopeError('');

    ringing.load(state.analysis.rows, state.method.stage, state.gapMs, state.myBell);
    ringing.start(state.myBell ? 1400 : 700);

    el.goBtn.textContent = 'Stand';
    el.goBtn.dataset.state = 'ringing';
    el.rows.classList.add('is-ringing');
    el.pullBtn.hidden = !state.myBell;
    el.verdict.hidden = true;
    updateTally();
    if (state.myBell) startSally();
    say(state.myBell ? 'Look to. Treble’s going. She’s gone.' : 'Ringing.');
}

function stopRinging(why = 'stood', quiet = false) {
    if (!ringing.running) { if (!quiet) resetGo(); return; }
    ringing.silentQuit = quiet;
    ringing.stop(why);
}

function resetGo() {
    parkRows();
    drawBell(state.traced);
    el.goBtn.textContent = 'Look to';
    delete el.goBtn.dataset.state;
    el.rows.classList.remove('is-ringing');
    el.pullBtn.hidden = true;
    el.pullBtn.classList.remove('is-true', 'is-out');
    el.pullCue.textContent = '';
    stopSally();
}

function finish(why) {
    const quiet = ringing.silentQuit;
    ringing.silentQuit = false;
    resetGo();
    if (quiet) return;
    if (state.myBell && ringing.strikes.some((s) => s !== null)) showVerdict(why);
    else if (why === 'come round') say('That’s all. Stand.');
}

//? ---------------------------------------------------------------------------
//? Pulling
//? ---------------------------------------------------------------------------

function pull() {
    const hit = ringing.pull();
    if (!hit) return;

    if (!hit.matched) {
        el.pullBtn.classList.remove('is-true');
        el.pullBtn.classList.add('is-out');
        el.pullCue.textContent = hit.doubled ? 'twice' : 'nowhere near';
        return;
    }

    const band = bandFor(hit.error);
    const sign = hit.error >= 0 ? '+' : '−';
    el.pullBtn.classList.toggle('is-true', band === 'true' || band === 'close');
    el.pullBtn.classList.toggle('is-out', band === 'out');
    el.pullCue.textContent = `${band} ${sign}${Math.abs(Math.round(hit.error))} ms`;

    flash(state.myBell);
    markStrike(hit.index, hit.error);
    printRopeError(`${sign}${Math.abs(Math.round(hit.error))}`);
    updateTally();
}

// Only the blows that have actually come due are scored. Standing part way
// through a course is a decision, not forty missed blows.
function currentScore() {
    const upto = Math.max(ringing.owedCursor, countStruck());
    return scoreCourse(ringing.strikes.slice(0, upto));
}

// RAISE 1: the striking figure hangs off the rope it was struck on, not in a panel.
function printRopeError(text) {
    for (const [b, g] of state.ropes) {
        const err = g.querySelector('.rope__err');
        if (err) err.textContent = b === state.myBell ? text : '';
    }
}

function updateTally() {
    const s = currentScore();
    $('tallyBlows').textContent = s.struck + s.missed;
    $('tallyTrue').textContent = s.bands.true;
    $('tallyClose').textContent = s.bands.close;
    $('tallyLoose').textContent = s.bands.loose;
    $('tallyOut').textContent = s.bands.out;
    $('tallyMissed').textContent = s.missed;
    $('tallyDrift').textContent = s.drift === null ? '0' : (s.drift >= 0 ? '+' : '−') + Math.abs(Math.round(s.drift));
}

function countStruck() {
    return ringing.strikes.reduce((n, s, i) => (s !== null ? i + 1 : n), 0);
}

//? The sally is the one thing on this page allowed to move continuously. It
//? rises after your blow and comes back down to nothing exactly when the next
//? one is due, which is the cue a ringer reads off the rope in front of them.
let sallyFrame = 0;

function startSally() {
    if (calm.matches) return;
    const step = () => {
        if (!ringing.running) return;
        const now = ringing.elapsedMs;
        let next = null, prev = 0;
        for (const blow of ringing.owed) {
            if (blow.at > now) { next = blow.at; break; }
            prev = blow.at;
        }
        const span = next === null ? state.gapMs : next - prev;
        const p = next === null ? 1 : Math.max(0, Math.min(1, (now - prev) / span));
        el.pullBtn.style.setProperty('--sally', `${(-18 * (1 - p)).toFixed(1)}px`);
        sallyFrame = requestAnimationFrame(step);
    };
    sallyFrame = requestAnimationFrame(step);
}

function stopSally() {
    cancelAnimationFrame(sallyFrame);
    el.pullBtn.style.setProperty('--sally', '0px');
}

//? ---------------------------------------------------------------------------
//? The verdict
//? ---------------------------------------------------------------------------

function showVerdict(why) {
    const round = why === 'come round';
    const s = round ? scoreCourse(ringing.strikes) : currentScore();
    const stage = state.method.stage;

    el.verdictTitle.textContent = round ? 'Come round' : 'Stood';
    el.verdictLine.textContent = verdictLine(s, stage, round);

    el.verdictFigs.replaceChildren(...[
        ['Blows', `${s.struck}/${s.blows}`, false],
        ['Accuracy', `${Math.round(s.accuracy * 100)}%`, false],
        ['Error', s.rms === null ? '--' : `${Math.round(s.rms)} ms`, true],
        ['Evenness', s.spread === null ? '--' : `${Math.round(s.spread)} ms`, false],
        ['Drift', s.drift === null ? '--' : `${s.drift >= 0 ? '+' : '−'}${Math.abs(Math.round(s.drift))} ms`, true]
    ].map(([label, value, hot]) => {
        const div = document.createElement('div');
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        if (hot) dd.className = 'is-hot';
        div.append(dt, dd);
        return div;
    }));

    el.verdict.hidden = false;
    el.againBtn.focus();
}

// The sentence a conductor would actually say, which depends on which fault it
// was: being uneven is a different problem from being evenly in the wrong place.
function verdictLine(s, stage, round) {
    if (s.struck === 0) return 'You never pulled. The rope was yours the whole way, and it stayed down.';
    if (s.missed > s.struck) return `You struck ${s.struck} of the ${s.blows} blows that came round to you. Most of the bell went unrung, which in a real tower is a hole everybody standing underneath can hear.`;

    const short = !round ? `You stood after ${s.blows} of your blows. ` : '';

    const drift = Math.round(s.drift);
    const spread = Math.round(s.spread);
    const gapNote = `A bell on ${stageName(stage)} is about ${state.gapMs} milliseconds wide, so that is ${Math.round((s.rms / state.gapMs) * 100)}% of a place.`;

    if (spread < 30 && Math.abs(drift) > 45) {
        return short + `Your striking is even to ${spread} milliseconds, which is good, but you sit ${Math.abs(drift)} milliseconds ${drift > 0 ? 'behind' : 'in front of'} the band the whole way. Ring ${drift > 0 ? 'up' : 'back'} into the gap and this is already a decent piece of striking.`;
    }
    if (s.rms < 35) return short + `${Math.round(s.rms)} milliseconds out on average. That is properly good striking. ${gapNote}`;
    if (s.rms < 70) return short + `${Math.round(s.rms)} milliseconds out on average, which is audible from underneath, but the shape of the method is clearly there. ${gapNote}`;
    return short + `${Math.round(s.rms)} milliseconds out on average. ${gapNote} Slow the ring down and count your place out loud; speed is the last thing to add.`;
}

//? ---------------------------------------------------------------------------
//? The title block and the library
//? ---------------------------------------------------------------------------

function loadMethod(key) {
    const method = methodByKey(key);
    if (!method) return;
    stopRinging('stood', true);

    state.method = method;
    state.analysis = analyseMethod(method.notation, method.stage);
    if (state.myBell > method.stage) takeRope(0);
    state.traced = state.myBell || Math.min(2, method.stage);

    el.methodPick.value = key;
    el.methodClass.textContent = `${method.class} · ${stageName(method.stage)}`;
    el.figNotation.textContent = method.notation;
    el.figStage.textContent = `${method.stage} bells`;
    el.figChanges.textContent = state.analysis.courseLength;
    el.figLeads.textContent = state.analysis.leads;

    for (const li of el.library.children) {
        li.classList.toggle('is-loaded', li.dataset.key === key);
    }

    drawPlan();
    drawBell(state.traced);
    drawSchedule();
    drawRows();
    parkRows();

    for (const [b, g] of state.ropes) {
        g.classList.toggle('is-mine', b === state.myBell);
        g.classList.toggle('is-traced', b === state.traced && !state.myBell);
        g.setAttribute('aria-pressed', String(b === state.myBell));
    }
    el.figRope.textContent = state.myBell ? bellName(state.myBell, method.stage) : 'tower';
    el.figRope.classList.toggle('is-mine', Boolean(state.myBell));
    el.tally.hidden = !state.myBell;
}

function buildPicker() {
    const byStage = new Map();
    for (const m of METHODS) {
        if (!byStage.has(m.stage)) byStage.set(m.stage, []);
        byStage.get(m.stage).push(m);
    }
    for (const [stage, list] of [...byStage].sort((a, b) => a[0] - b[0])) {
        const group = document.createElement('optgroup');
        group.label = `${stage} bells · ${stageName(stage)}`;
        for (const m of list) {
            const opt = document.createElement('option');
            opt.value = m.key;
            opt.textContent = m.name;
            group.append(opt);
        }
        el.methodPick.append(group);
    }
}

function buildLibrary() {
    el.libraryMeta.textContent = `${METHODS.length} methods`;
    el.library.replaceChildren(...METHODS.map((m, i) => {
        const li = document.createElement('li');
        li.className = 'method';
        li.dataset.key = m.key;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'method__btn';
        btn.innerHTML = `
            <span class="method__no">${String(i + 1).padStart(2, '0')}</span>
            <span>
                <span class="method__name">${m.name}</span>
                <span class="method__facts">
                    <span>${m.class}</span>
                    <span>${m.stage} bells</span>
                    <span>${m.changes} changes</span>
                    <span>${m.leads} leads</span>
                    <code>${m.notation.replace(/&/g, '&amp;')}</code>
                </span>
                <span class="method__note">${m.note}</span>
            </span>
            <span class="method__ring">Ring it</span>`;
        btn.addEventListener('click', () => {
            loadMethod(m.key);
            document.querySelector('.sheet').scrollIntoView({ behavior: calm.matches ? 'auto' : 'smooth', block: 'start' });
        });
        li.append(btn);
        return li;
    }));
}

//? A worked change, drawn once. It is the one thing on the page that says what
//? "everything that does not stand still swaps with its neighbour" looks like.
function drawSwap() {
    const before = [2, 1, 4, 3, 6, 5];
    const holds = [1, 6];
    const after = [2, 4, 1, 6, 3, 5];
    const W = 46, x0 = 34, yTop = 22, yBot = 84;

    const fig = svg('svg', { class: 'swap__svg', width: x0 * 2 + W * 6, height: 108, viewBox: `0 0 ${x0 * 2 + W * 6} 108` });
    const at = (i) => x0 + W * i + W / 2;

    const topLabel = svg('text', { class: 'swap-label', x: at(0) - W / 2 - 6, y: yTop, 'text-anchor': 'end' });
    topLabel.textContent = 'before';
    const botLabel = svg('text', { class: 'swap-label', x: at(0) - W / 2 - 6, y: yBot, 'text-anchor': 'end' });
    botLabel.textContent = 'after';
    fig.append(topLabel, botLabel);

    before.forEach((bell, i) => {
        const held = holds.includes(i + 1);
        const t = svg('text', { x: at(i), y: yTop, class: held ? 'swap-hold' : '' });
        t.textContent = bell;
        fig.append(t);
        if (held) {
            fig.append(svg('path', { class: 'swap-stand', d: `M${at(i)},${yTop + 13} L${at(i)},${yBot - 13}` }));
        }
    });

    // Each swapping pair gets one arc crossing to its new place.
    for (let i = 0; i < 6; i++) {
        if (holds.includes(i + 1)) continue;
        const target = after.indexOf(before[i]);
        const from = at(i), to = at(target);
        fig.append(svg('path', {
            class: 'swap-arc',
            d: `M${from},${yTop + 13} C${from},${yTop + 34} ${to},${yBot - 34} ${to},${yBot - 13}`
        }));
    }

    after.forEach((bell, i) => {
        const t = svg('text', { x: at(i), y: yBot, class: holds.includes(i + 1) ? 'swap-hold' : '' });
        t.textContent = bell;
        fig.append(t);
    });

    el.swapStage.replaceChildren(fig);
    el.swapNote.textContent = 'The change written 16, applied to the row 214365. The bells in first and sixth place stand, drawn on their dotted verticals. The other four cross in pairs, and the row that comes out is 241635.';
}

//? ---------------------------------------------------------------------------
//? Wiring
//? ---------------------------------------------------------------------------

function say(text) {
    el.crier.textContent = text;
}

el.methodPick.addEventListener('change', (e) => loadMethod(e.target.value));
el.goBtn.addEventListener('click', startRinging);

el.speed.addEventListener('input', (e) => {
    state.gapMs = Number(e.target.value);
    el.speedNote.textContent = `${state.gapMs} ms a bell`;
    drawScale();
    if (ringing.running) stopRinging('stood', true);
});

el.muteBtn.addEventListener('click', () => {
    state.muted = !state.muted;
    tower.setVolume(state.muted ? 0 : 0.6);
    el.muteBtn.textContent = state.muted ? 'Sound off' : 'Sound on';
    el.muteBtn.setAttribute('aria-pressed', String(state.muted));
});

el.pullBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); pull(); });
el.againBtn.addEventListener('click', () => { el.verdict.hidden = true; startRinging(); });
el.closeVerdict.addEventListener('click', () => { el.verdict.hidden = true; el.goBtn.focus(); });

document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === 'Escape' && !el.verdict.hidden) { el.verdict.hidden = true; return; }
    if ((e.key === ' ' || e.key === 'Enter') && ringing.running && state.myBell) {
        if (e.target === el.pullBtn || e.target === document.body || e.target === document.documentElement) {
            e.preventDefault();
            pull();
        }
    }
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        drawRows();
        if (ringing.running) showRow(ringing.currentRow); else parkRows();
    }, 140);
});

// Cut the bells off if the page goes away mid course.
document.addEventListener('visibilitychange', () => {
    if (document.hidden && ringing.running) stopRinging('stood', true);
});

buildPicker();
buildLibrary();
drawSwap();
el.speedNote.textContent = `${state.gapMs} ms a bell`;
loadMethod('plain-bob-6');
