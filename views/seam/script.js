// SEAM // the plate.
//
// Three ways in, one board. `local` passes one device across a table,
// `solo` plays the bot in logic.js, and `room` is the shared-link gamemode
// built on the repo's multiplayer base (see ../spy/CLAUDE.md for the polling
// rationale, the outbox contract and the server-owns-the-state variant this
// follows).
//
// Everything that decides anything lives in logic.js. This file only wires
// it to the DOM, and in room mode it does not even do that: the server owns
// the section, the client posts a shaft number and learns what happened
// through the poll like everybody else.

import {
    COLS, ROWS, CHARGES, DEPTHS,
    newGame, applyMove, moveError, columnFull,
    normalizeCode, isValidCode, cleanName, isValidName,
    createRoomModel, applyEvents, pollDelay,
    bestMove,
    createTranslator, normalizeLang, tableLanguages, DEFAULT_LANG,
} from './logic.js';

const API = '../../app/controllers/seam-controller.php';
const SESSION_KEY = 'seam:session';
const NAME_KEY = 'seam:name';
const LANG_KEY = 'seam:lang';

/** Metres of section per bed, for the depth scale. */
const BED_METRES = 5;
// The cave, in beats. It is the one thing in the game that takes a whole
// row off both players at once, so it is allowed to take a moment; there are
// at most six of them in a section.
/** The core waits in its collar while the plate works out what it costs. */
const HOLD_MS = 380;
/** The basement shears out through the floor. */
const CUT_MS = 340;
/** One beat of empty drawpoint, so a void is actually seen. */
const VOID_MS = 130;
/** The overburden drops into it. */
const COLLAPSE_MS = 400;

/** Beds a core falls through above the datum before it crosses it. */
const COLLAR_BEDS = 1.2;
/** How long the longest possible fall takes; every shorter one is scaled off
 *  it by sqrt(distance), which is one constant acceleration for every row. */
const FALL_MAX_MS = 520;

const $ = (id) => document.getElementById(id);
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------
//  State
// ------------------------------------------------------------------

let uiTable = null;
let lang = DEFAULT_LANG;
let t = (key) => key;

let mode = null;             // 'local' | 'solo' | 'room'
let game = null;             // the logic.js state, for local and solo
let botDepth = DEPTHS.surveyor;
let botThinking = false;

let session = null;          // { code, token, name }
let roomInfo = null;
let players = [];
let you = null;
let model = createRoomModel();

let pollTimer = null;
let pollBusy = false;
let failures = 0;
let outbox = [];
let sending = false;

let painted = null;          // the board string currently on the plate
let painting = false;        // an animation owns the plate right now
let plateState = null;       // the state the plate is showing, for the preview
let plateMine = false;       // whether the viewer may cut into it
let pointerCol = -1;         // the shaft the pointer or keyboard is on
let gateIntent = 'open';     // 'open' | 'join'
let toastTimer = null;

// ------------------------------------------------------------------
//  Screens and chrome
// ------------------------------------------------------------------

function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('is-open'));
    $(id).classList.add('is-open');
    document.body.classList.toggle('is-playing', id === 'boardScreen');
    window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
}

function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

function updateSignal() {
    const el = $('signal');
    if (mode !== 'room' || !session) {
        el.hidden = true;
        return;
    }
    el.hidden = false;
    const down = failures > 0;
    el.classList.toggle('is-down', down);
    $('signalText').textContent = t(down ? 'signal.down' : 'signal.ok');
}

// ------------------------------------------------------------------
//  Translation
// ------------------------------------------------------------------

async function loadTable() {
    // 'no-cache' REVALIDATES, it does not skip the cache: an unchanged table
    // still comes back as a bodyless 304. force-cache was the wrong trade and
    // views/spy/CLAUDE.md documents why: it serves a stale copy without ever
    // asking, so every row added after a visitor's first load renders as its
    // raw key on that device forever.
    const res = await fetch('i18n/ui.json', { cache: 'no-cache' });
    uiTable = await res.json();
}

function applyLang(code) {
    lang = normalizeLang(code, uiTable);
    t = createTranslator(uiTable, lang);
    localStorage.setItem(LANG_KEY, lang);
    document.documentElement.lang = lang;

    // The markup itself is the list of what needs translating.
    document.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
        el.placeholder = t(el.dataset.i18nPlaceholder);
    });

    renderLangs();
    renderSolo();
    updateSignal();
    if (mode === 'room') renderRoom(); else renderLocal();
}

function renderLangs() {
    const box = $('gateLangs');
    box.textContent = '';
    for (const code of tableLanguages(uiTable)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'lang' + (code === lang ? ' is-on' : '');
        b.textContent = code.toUpperCase();
        b.addEventListener('click', () => applyLang(code));
        box.appendChild(b);
    }
}

// ------------------------------------------------------------------
//  Painting the section
// ------------------------------------------------------------------

/** How many times the bottom has been drawn: every spent permit is one cave. */
const caveCount = (charges) => (CHARGES - charges[0]) + (CHARGES - charges[1]);

function measureCell() {
    const grid = $('grid');
    const h = grid.getBoundingClientRect().height;
    if (h > 0) $('frame').style.setProperty('--cell', `${h / ROWS}px`);
}

function buildGrid() {
    const grid = $('grid');
    if (grid.childElementCount === COLS * ROWS) return;
    grid.textContent = '';
    for (let i = 0; i < COLS * ROWS; i++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        grid.appendChild(cell);
    }
}

/** The strata behind the section, plus one band held above the surface so
 *  there is something to slide into view when the bottom is drawn. */
function paintBeds(caves) {
    const box = $('beds');
    box.textContent = '';
    const bands = document.createElement('div');
    bands.className = 'beds__bands';
    bands.style.transform = 'translateY(calc(var(--cell) * -1))';
    for (let i = 0; i <= ROWS; i++) {
        const band = document.createElement('div');
        // The section continues below the window, so the pattern rolls: the
        // deeper you get, the older the rock.
        // The last band covers the basement bed, which is the one a cut
        // takes away, so it is marked for the cave to shear out on its own.
        band.className = `band band--${((caves + i - 1) % 5 + 5) % 5}`
            + (i === ROWS ? ' band--drawn' : '');
        band.style.top = `calc(var(--cell) * ${i})`;
        bands.appendChild(band);
    }
    box.appendChild(bands);
}

/**
 * The plate's metadata line. The drawpoint does not move, so the depth scale
 * is fixed; what grows is how much has been drawn out from under the
 * section, which is the number worth watching.
 */
function paintMeta(caves) {
    $('plateMeta').textContent = t('board.drawn', { n: caves * BED_METRES });
}

/**
 * Metres below datum, ticked on every bed boundary. Fixed: the workings do
 * not move, the rock moves through them, so a scale that renumbered would be
 * telling the opposite story to the one the cores tell as they settle.
 */
function paintScale() {
    const box = $('scale');
    if (box.childElementCount === ROWS) return;
    box.textContent = '';
    for (let r = 0; r < ROWS; r++) {
        const mark = document.createElement('div');
        mark.className = 'scale__mark';
        mark.style.top = `calc(var(--cell) * ${r})`;
        mark.textContent = `${(r + 1) * BED_METRES}`;
        box.appendChild(mark);
    }
}

/** Cores only: the cells themselves are built once and never rebuilt. */
function paintCores(board) {
    const cells = $('grid').children;
    for (let i = 0; i < board.length; i++) {
        const cell = cells[i];
        const want = board[i];
        const have = cell.firstElementChild;
        if (want === '.') {
            if (have) have.remove();
            continue;
        }
        if (have && have.dataset.seat === want) continue;
        if (have) have.remove();
        const core = document.createElement('div');
        core.className = `core core--${want}`;
        core.dataset.seat = want;
        cell.appendChild(core);
    }
}

// The seam svg is 100 units per bed (viewBox 700x600 over a grid locked to
// 7/6), so every number below is in beds and both axes scale alike.
const U = 100;
const svgEl = (name) => document.createElementNS('http://www.w3.org/2000/svg', name);

/** Centre of cell `i`, in seam-svg units. */
const cellAt = (i) => ({ x: ((i % COLS) + 0.5) * U, y: (Math.floor(i / COLS) + 0.5) * U });

/**
 * The struck seam: a hatched corridor of ore running BEHIND the four cores,
 * squared at both ends and ticked like a fault. Drawing it across their
 * centres, however heavily, reads as a row being cancelled rather than as
 * something being found, which is the opposite of what just happened.
 *
 * Every dash length is read back off the element with getTotalLength(). The
 * old code hard-coded `stroke-dasharray: 200` against a non-scaling stroke,
 * so the dash was 200 SCREEN pixels: any seam longer than that (every
 * diagonal, and every horizontal on a plate wider than a phone) painted 200
 * pixels and then stopped mid-air.
 */
function paintStrike(cells, seat) {
    const svg = $('strike');
    svg.textContent = '';
    // paintCores reuses a core element whose seat has not changed, so a ring
    // struck in the last section would otherwise survive into the next one.
    document.querySelectorAll('.core--struck').forEach((el) => el.classList.remove('core--struck'));
    $('grid').classList.toggle('is-struck', Boolean(cells && cells.length >= 4));
    if (!cells || cells.length < 4) return;

    svg.appendChild(seamHatches());
    const s = seat === 2 ? 2 : 1;

    for (let i = 0; i + 3 < cells.length; i += 4) {
        const a = cellAt(cells[i]);
        const b = cellAt(cells[i + 3]);
        // Squared off half a bed past each end core, so the corridor contains
        // all four rather than starting and stopping inside the outer two.
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const ux = (b.x - a.x) / len;
        const uy = (b.y - a.y) / len;
        // Just short of the outer bed boundaries, so an end tick on a seam
        // that reaches the edge of the plate is not half-clipped by it.
        const end = U * 0.44;
        const p = { x1: a.x - ux * end, y1: a.y - uy * end, x2: b.x + ux * end, y2: b.y + uy * end };

        // Outline, ore, hatch: three strokes on one path, drawn on together.
        for (const cls of [`strike__rule`, `strike__band strike__band--${s}`, `strike__hatch strike__hatch--${s}`]) {
            const line = svgEl('line');
            line.setAttribute('class', cls);
            for (const [k, v] of Object.entries(p)) line.setAttribute(k, v);
            svg.appendChild(line);
            drawOn(line);
        }

        // Fault ticks: short strokes square to the corridor at both ends.
        for (const [t, dir] of [[0, 1], [1, -1]]) {
            const cx = t === 0 ? p.x1 : p.x2;
            const cy = t === 0 ? p.y1 : p.y2;
            const tick = svgEl('line');
            tick.setAttribute('class', 'strike__tick');
            tick.setAttribute('x1', cx + uy * U * 0.3 * dir);
            tick.setAttribute('y1', cy - ux * U * 0.3 * dir);
            tick.setAttribute('x2', cx - uy * U * 0.3 * dir);
            tick.setAttribute('y2', cy + ux * U * 0.3 * dir);
            svg.appendChild(tick);
        }
    }

    // The four that struck it ink up; style.css steps the other cells back.
    for (const i of cells) {
        $('grid').children[i]?.firstElementChild?.classList.add('core--struck');
    }
}

/** Draws a stroke on from one end, off its own measured length. */
function drawOn(line) {
    if (reduced()) return;
    const len = line.getTotalLength();
    line.style.strokeDasharray = String(len);
    line.style.strokeDashoffset = String(len);
    requestAnimationFrame(() => {
        line.style.transition = 'stroke-dashoffset 0.44s cubic-bezier(0.16, 1, 0.3, 1) 0.1s';
        line.style.strokeDashoffset = '0';
    });
}

/** The two seat hatches, as svg patterns: dots for ochre and 45-degree dashes
 *  for azurite, matching --hatch-core-1 and --hatch-core-2 exactly. */
function seamHatches() {
    const defs = svgEl('defs');
    const dots = svgEl('pattern');
    dots.setAttribute('id', 'seamDots');
    dots.setAttribute('width', '16');
    dots.setAttribute('height', '16');
    dots.setAttribute('patternUnits', 'userSpaceOnUse');
    const dot = svgEl('circle');
    dot.setAttribute('cx', '5'); dot.setAttribute('cy', '5'); dot.setAttribute('r', '2.6');
    dot.setAttribute('fill', 'rgba(34, 31, 28, 0.42)');
    dots.appendChild(dot);

    const dash = svgEl('pattern');
    dash.setAttribute('id', 'seamDash');
    dash.setAttribute('width', '14');
    dash.setAttribute('height', '14');
    dash.setAttribute('patternUnits', 'userSpaceOnUse');
    dash.setAttribute('patternTransform', 'rotate(45)');
    const bar = svgEl('rect');
    bar.setAttribute('width', '4.5'); bar.setAttribute('height', '14');
    bar.setAttribute('fill', 'rgba(230, 225, 211, 0.42)');
    dash.appendChild(bar);

    defs.append(dots, dash);
    return defs;
}

/** The highest occupied bed in a shaft, which is the core most recently
 *  played into it, or -1 if the shaft is empty. */
function topRow(board, col) {
    for (let r = 0; r < ROWS; r++) {
        if (board[r * COLS + col] !== '.') return r;
    }
    return -1;
}

/** The bed a core would come to rest in, or -1 if the shaft has no room. */
function landingRow(board, col) {
    for (let r = ROWS - 1; r >= 0; r--) {
        if (board[r * COLS + col] === '.') return r;
    }
    return -1;
}

/** The core waiting in its collar while the bottom is drawn for it. */
function holdCore(col, seat) {
    releaseCore();
    const core = document.createElement('span');
    core.className = `held held--${seat}`;
    core.style.setProperty('--col', String(col));
    $('collar').appendChild(core);
}

function releaseCore() {
    document.querySelectorAll('.held').forEach((el) => el.remove());
}

/**
 * Marks the core that just landed so it falls in rather than appearing.
 *
 * The distance is quoted in BEDS, released at the top of the collar. It used
 * to be a percentage, which is a fraction of the core's own 78%-of-a-bed
 * height, so the fall came up short by a different amount on every row and
 * was invisible on the top one. One constant acceleration for every row means
 * the time follows sqrt(distance): the basement is four and a half times as
 * far as the surface and takes twice as long to reach.
 */
function dropIn(board, col) {
    // The core that just landed is the TOPMOST occupied bed in the shaft.
    // This used to scan from the basement up and take the lowest one, so
    // every drop after the first in a shaft animated somebody else's core
    // falling from the sky: after a cave, into a full shaft, it was the
    // opponent's piece in the basement that fell rather than the one that
    // had just been played.
    const row = topRow(board, col);
    if (row < 0 || reduced()) return;
    const core = $('grid').children[row * COLS + col].firstElementChild;
    if (!core) return;
    const beds = row + COLLAR_BEDS;
    const fall = FALL_MAX_MS * Math.sqrt(beds / (ROWS - 1 + COLLAR_BEDS));
    core.style.setProperty('--fall-from', `calc(var(--cell) * ${-beds})`);
    core.style.setProperty('--fall-time', `${Math.round(fall)}ms`);
    // The keyframe spends its first 78% falling and the rest landing.
    core.style.setProperty('--fall-total', `${Math.round(fall / 0.78)}ms`);
    core.classList.add('core--fresh');
    return Math.round(fall);
}

/**
 * Bring the plate to `state`. With an `edge` describing the cut that got us
 * here, the change is animated; without one it snaps, which is what a phone
 * resuming past a page of events wants.
 */
async function paintSection(state, edge) {
    buildGrid();
    measureCell();
    const caves = caveCount(state.charges);

    if (painting) { painted = null; return; }

    const seam = state.seams?.[0] ?? null;
    const animate = edge && !reduced() && painted !== null && painted !== state.board;
    if (!animate) {
        paintBeds(caves);
        paintScale();
        paintCores(state.board);
        paintMeta(caves);
        measureCell();
        painted = state.board;
        paintStrike(seam?.cells ?? null, seam?.seat);
        return;
    }

    painting = true;
    paintHot();
    paintStrike(null);
    const frame = $('frame');
    const stack = $('stack');
    const beds = $('beds');

    if (edge.caved) await caveIn(frame, stack, beds, edge);

    paintBeds(caves);
    paintScale();
    paintCores(state.board);
    paintMeta(caves);
    measureCell();
    const landing = dropIn(state.board, edge.col);
    painted = state.board;

    // The lock lifts the moment the core is in its bed, not when the landing
    // squash has finished playing out on top of it. cut() refuses everything
    // while the plate is animating, so every millisecond held past the point
    // where the move is really over is a tap silently swallowed.
    if (landing) await sleep(landing);
    painting = false;
    paintHot();

    // The seam is struck on a settled plate: drawn while a core is still in
    // the air, it announces the win before the move that won it has landed.
    if (!seam) return;
    if (landing) await sleep(Math.round(landing * 0.28));
    paintStrike(seam.cells, seam.seat);
}

/**
 * The cave, in three beats.
 *
 * The whole mechanic is that the floor is taken away, so the floor has to be
 * seen leaving. Moving everything at once, which is what this used to do,
 * never opens a void: the basement and the overburden travel together and the
 * read is "the strata scrolled" while the bottom row quietly dissolves.
 *
 *   1  THE CUT       the fault rips and the basement shears out through the
 *                    floor, alone. Nothing above it moves.
 *   2  THE VOID      one beat of empty drawpoint, held, so the hole is seen.
 *   3  THE COLLAPSE  the overburden drops into it and the plate takes the hit.
 */
async function caveIn(frame, stack, beds, edge) {
    // The core is played above the rim of a shaft with no room left, so it
    // waits in its collar, over its own shaft, while the bottom is drawn out
    // to make space for it. That plus the status line says what is happening;
    // a floating label over the middle of the section only ever looked like it
    // belonged to whichever shaft it happened to land on.
    holdCore(edge.col, edge.seat);
    // Restored at the end: the poll repaints this line, but only on its own
    // schedule, so leaving it changed left the opponent's plate reading
    // DRAWING THE BOTTOM for a second after the bottom had gone.
    const said = $('boardStatus').textContent;
    $('boardStatus').textContent = t('board.drawing');
    await sleep(HOLD_MS);

    for (let c = 0; c < COLS; c++) {
        $('grid').children[(ROWS - 1) * COLS + c].firstElementChild?.classList.add('core--drawn');
    }
    measureCell();

    frame.classList.add('is-cutting');
    stack.classList.add('is-cutting');
    beds.classList.add('is-cutting');
    await sleep(CUT_MS + VOID_MS);

    // A fall that has finished still pins its core's transform, because
    // `coreFall` fills `both` and a filled animation outranks a plain
    // declaration in the cascade. Nothing used to take the class off again and
    // paintCores reuses a core whose seat has not changed, so it accumulated
    // until every core on the plate carried it and the collapse could not move
    // one of them: measured mid-beat, all five survivors sat at translateY(0)
    // while the strata travelled a full bed under them, and then snapped into
    // register on the repaint. Clearing it here rather than in paintCores is
    // deliberate: paintCores runs after this, and dropIn after that again.
    // Beat three is also late enough that no fall or squash is cut short.
    stack.querySelectorAll('.core--fresh').forEach((el) => el.classList.remove('core--fresh'));

    frame.classList.add('is-collapsing');
    stack.classList.add('is-collapsing');
    beds.classList.add('is-collapsing');
    // Fresh rock caves in behind the drawn bed: the bands rest one bed high
    // for exactly this, so there is always something to arrive at the top.
    requestAnimationFrame(() => {
        beds.querySelector('.beds__bands').style.transform = 'translateY(0)';
    });
    await sleep(COLLAPSE_MS);

    for (const el of [frame, stack, beds]) {
        el.classList.remove('is-cutting', 'is-collapsing');
    }
    releaseCore();
    $('boardStatus').textContent = said;
}

// ------------------------------------------------------------------
//  The shaft heads and the HUDs
// ------------------------------------------------------------------

function buildShafts() {
    const box = $('shafts');
    if (box.childElementCount === COLS + 1) return;
    box.textContent = '';

    // The scale gutter's header carries the unit, the way any ruled chart
    // labels its axis once at the top rather than on every tick.
    const unit = document.createElement('abbr');
    unit.className = 'shafts__unit';
    unit.textContent = 'M';
    unit.title = t('board.depth');
    box.appendChild(unit);

    for (let c = 0; c < COLS; c++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'shaft';
        b.dataset.col = String(c);
        b.textContent = String(c + 1);
        b.addEventListener('click', () => cut(c));
        b.addEventListener('pointerenter', () => setHot(c));
        b.addEventListener('pointerleave', () => setHot(-1));
        b.addEventListener('focus', () => setHot(c));
        b.addEventListener('blur', () => setHot(-1));
        box.appendChild(b);
    }
}

/**
 * The shafts as hit areas: the whole column, not the numbered strip above it.
 * A person reaches for the column they want a core in, and the heads are 33
 * pixels tall on a phone.
 *
 * These are deliberately NOT focusable. The heads stay the labelled control
 * for keyboard and screen readers, so the shaft still has exactly one tab
 * stop; fourteen stops for seven shafts would be worse than the problem.
 */
function buildLanes() {
    const box = $('lanes');
    if (box.childElementCount === COLS) return;
    box.textContent = '';
    for (let c = 0; c < COLS; c++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'lane';
        b.dataset.col = String(c);
        b.tabIndex = -1;
        b.setAttribute('aria-hidden', 'true');
        b.addEventListener('click', () => cut(c));
        b.addEventListener('pointerenter', () => setHot(c));
        b.addEventListener('pointerleave', () => setHot(-1));
        box.appendChild(b);
    }
}

/** Greys out the shafts this seat cannot cut into, and marks the ones that
 *  would draw the bottom. The server decides for real; this only stops a
 *  player tapping something that was always going to be refused. */
function paintShafts(state, mine) {
    buildShafts();
    buildLanes();
    plateState = state;
    plateMine = mine;
    for (const b of $('shafts').children) {
        // The first child is the gutter's unit label, not a shaft. It used to
        // fall through this loop and pick up aria-label="Shaft NaN".
        const col = Number(b.dataset.col);
        if (!Number.isInteger(col)) continue;
        const blocked = !mine || moveError(state, col) !== null;
        b.disabled = blocked;
        b.classList.toggle('is-draw', mine && !blocked && columnFull(state.board, col));
        b.setAttribute('aria-label', t('board.shaftLabel', { n: col + 1 }));
        $('lanes').children[col].disabled = blocked;
    }
    paintHot();
}

/**
 * Where the pointer or keyboard is. Deliberately only records that, and lets
 * paintHot() decide every time whether it is currently worth lighting: a
 * pointer resting on a shaft does not send another event when the turn passes
 * or an animation ends, so a hot column latched at event time went dark after
 * your own move and stayed dark until you physically moved the mouse.
 */
function setHot(col) {
    if (col === pointerCol) return;
    pointerCol = col;
    paintHot();
}

/**
 * The lit shaft and what cutting into it would do. On a shaft with room the
 * ghost is simply where the core lands. On a full one it cannot mean that, so
 * the plate states both ends of the trade instead: the basement marks up as
 * going, and the ghost sits at the surface, where the core ends up once the
 * section has settled onto it.
 */
function paintHot() {
    const st = plateState;
    const hot = pointerCol >= 0 && st && plateMine && !painting
        && moveError(st, pointerCol) === null ? pointerCol : -1;

    for (const el of $('lanes').children) {
        el.classList.toggle('is-hot', Number(el.dataset.col) === hot);
    }
    for (const el of $('shafts').children) {
        el.classList.toggle('is-hot', Number(el.dataset.col) === hot);
    }
    document.querySelectorAll('.ghost').forEach((el) => el.remove());

    const full = hot >= 0 && columnFull(st.board, hot);
    $('doomed').hidden = !full;
    if (hot < 0) return;

    const ghost = document.createElement('span');
    ghost.className = `ghost ghost--${st.turn}`;
    if (full) {
        // A full shaft has no bed to point at, and putting the ghost in the
        // top one drew it on top of a core that is still sitting there. It
        // goes where it really goes: above the rim, in its collar, which is
        // exactly where the cave will hold it while the bottom is drawn.
        ghost.classList.add('ghost--rim');
        ghost.style.setProperty('--col', String(hot));
        $('collar').appendChild(ghost);
        return;
    }
    const row = landingRow(st.board, hot);
    if (row < 0) return;
    ghost.style.setProperty('--row', String(row));
    $('lanes').children[hot].appendChild(ghost);
}

function permitPips(left) {
    const box = document.createElement('span');
    box.className = 'hud__permits';
    // Three pips burning down say nothing to a screen reader on their own.
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', `${t('board.permits')} ${left}/${CHARGES}`);
    for (let i = 0; i < CHARGES; i++) {
        const pip = document.createElement('span');
        // Burns down right to left, the way a gauge empties.
        pip.className = 'permit' + (i >= left ? ' is-spent' : '');
        box.appendChild(pip);
    }
    return box;
}

function paintHud(el, { seat, name, permits, turn, wins }) {
    el.textContent = '';
    el.classList.toggle('is-turn', turn);

    const core = document.createElement('span');
    core.className = `hud__core hud__core--${seat}`;
    el.appendChild(core);

    const label = document.createElement('span');
    label.className = 'hud__name';
    label.textContent = name;
    el.appendChild(label);

    // A series tally is only worth printing once there is a series.
    if (wins) {
        const w = document.createElement('span');
        w.className = 'hud__wins';
        w.textContent = String(wins);
        el.appendChild(w);
    }
    el.appendChild(permitPips(permits));
}

// ------------------------------------------------------------------
//  Local and solo
// ------------------------------------------------------------------

function startLocal(kind, depth) {
    clearVerdict();
    mode = kind;
    botDepth = depth ?? DEPTHS.surveyor;
    game = newGame({ starter: 1 });
    painted = null;
    botThinking = false;
    showScreen('boardScreen');
    renderLocal();
    // The grid has to be laid out before the bands and the depth scale can
    // be positioned off a real cell height.
    requestAnimationFrame(() => paintSection(game, null));
}

function seatName(seat) {
    if (mode === 'solo') return seat === 1 ? t('board.you') : t('board.machine');
    return t(seat === 1 ? 'board.seat1' : 'board.seat2');
}

function renderLocal() {
    if (!game || mode === 'room') return;
    const mine = game.outcome === null && !(mode === 'solo' && game.turn === 2);
    paintShafts(game, mine);
    paintHud($('hudAway'), { seat: 2, name: seatName(2), permits: game.charges[1], turn: game.turn === 2 });
    paintHud($('hudHome'), { seat: 1, name: seatName(1), permits: game.charges[0], turn: game.turn === 1 });

    if (game.outcome !== null) {
        $('boardStatus').textContent = '';
    } else if (botThinking) {
        $('boardStatus').textContent = t('board.thinking');
    } else if (mode === 'solo') {
        $('boardStatus').textContent = t('board.yourCut');
    } else {
        $('boardStatus').textContent = t('board.seatCut', { seat: seatName(game.turn) });
    }
}

async function localCut(col) {
    // The seat that cut, not the one it passed the turn to.
    const mover = game.turn;
    const move = applyMove(game, col);
    if (!move.ok) {
        toast(t(`refuse.${move.reason}`));
        return;
    }
    game = move.state;
    renderLocal();
    await paintSection(game, { col, seat: mover, caved: move.caved });

    if (game.outcome !== null) { showVerdict(); return; }
    if (mode === 'solo' && game.turn === 2) await botTurn();
}

async function botTurn() {
    botThinking = true;
    renderLocal();
    // A beat before it answers: an opponent that replies in zero time reads
    // as the page rather than as a person.
    await sleep(reduced() ? 0 : 420);

    const col = bestMove(game, { depth: botDepth });
    botThinking = false;
    if (col < 0) { renderLocal(); return; }

    const move = applyMove(game, col);
    game = move.state;
    renderLocal();
    await paintSection(game, { col, seat: 2, caved: move.caved });
    if (game.outcome !== null) showVerdict();
}

function renderSolo() {
    const box = $('soloDoors');
    if (!box) return;
    box.textContent = '';
    const rows = [
        ['hand', DEPTHS.hand, 'olivine'],
        ['surveyor', DEPTHS.surveyor, 'jurassic'],
        ['chief', DEPTHS.chief, 'carbon'],
    ];
    for (const [key, depth, band] of rows) {
        const li = document.createElement('li');
        li.className = 'door';
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'door__hit';
        b.innerHTML = `<span class="door__swatch door__swatch--${band}"></span>`
            + '<span class="door__text"><span class="door__name"></span><span class="door__hint"></span></span>'
            + '<span class="door__arrow">&rarr;</span>';
        b.querySelector('.door__name').textContent = t(`solo.${key}`);
        b.querySelector('.door__hint').textContent = t(`solo.${key}Hint`);
        b.addEventListener('click', () => startLocal('solo', depth));
        li.appendChild(b);
        box.appendChild(li);
    }
}

// ------------------------------------------------------------------
//  The verdict
// ------------------------------------------------------------------

function showVerdict() {
    const state = mode === 'room' ? stateFromRoom(roomInfo) : game;
    const struck = state.outcome === 1 || state.outcome === 2;

    $('verdictStamp').textContent = t(struck ? 'verdict.struck' : 'verdict.stalled');

    if (!struck) {
        $('verdictWho').textContent = t('verdict.draw');
    } else if (mode === 'room') {
        $('verdictWho').textContent = state.outcome === you?.seat
            ? t('verdict.youWin')
            : t('verdict.theyWin', { name: nameOfSeat(state.outcome) });
    } else if (mode === 'solo') {
        $('verdictWho').textContent = state.outcome === 1
            ? t('verdict.youWin')
            : t('verdict.theyWin', { name: t('board.machine') });
    } else {
        $('verdictWho').textContent = t('verdict.seatWins', { seat: seatName(state.outcome) });
    }

    if (mode === 'room') {
        const a = players.find((p) => p.seat === 1)?.wins ?? 0;
        const b = players.find((p) => p.seat === 2)?.wins ?? 0;
        $('verdictSeries').textContent = t('verdict.series', { a, b });
        $('verdictSeries').hidden = false;
    } else {
        $('verdictSeries').hidden = true;
    }

    $('verdictAgain').hidden = false;
    $('verdictWaiting').hidden = true;
    $('verdict').hidden = false;
    $('boardLeave').hidden = true;
    $('boardStatus').hidden = true;
    showScreen('boardScreen');
}

/** Back to a live section: the stamp comes off the plate. */
function clearVerdict() {
    $('verdict').hidden = true;
    $('boardLeave').hidden = false;
    $('boardStatus').hidden = false;
}

// ------------------------------------------------------------------
//  Room transport
// ------------------------------------------------------------------

async function post(action, payload) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
        const res = await fetch(`${API}?action=${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: ctrl.signal,
        });
        const body = await res.json().catch(() => null);
        return { ok: res.ok, status: res.status, body };
    } catch {
        // status 0 is the whole contract: it separates "the network died,
        // retry" from "the server refused, do not".
        return { ok: false, status: 0, body: null };
    } finally {
        clearTimeout(timer);
    }
}

function schedulePoll(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollOnce, ms);
}

async function pollOnce() {
    if (!session || pollBusy) return;
    pollBusy = true;
    const res = await post('poll', { code: session.code, token: session.token, since: model.lastSeq });
    pollBusy = false;
    if (!session) return;

    let more = false;
    if (res.ok && res.body) {
        failures = 0;
        more = handlePoll(res.body);
    } else if (res.status === 404) {
        leaveLocal(t('toast.sectionClosed'));
        return;
    } else if (res.status === 401) {
        leaveLocal(t('toast.seatTaken'));
        return;
    } else {
        failures++;
    }
    updateSignal();
    schedulePoll(more ? 30 : pollDelay({
        status: model.status,
        hidden: document.hidden,
        failures,
        waiting: roomInfo?.status === 'play' && roomInfo?.turn !== you?.seat,
    }));
}

function handlePoll(body) {
    const ops = applyEvents(model, body.events, you?.id ?? 0);
    model.lastSeq = Math.max(model.lastSeq, body.last);
    model.status = body.room.status;

    const wasHost = you?.host === true;
    const first = roomInfo === null;
    you = body.you;
    players = body.players;
    const previous = roomInfo;
    roomInfo = body.room;

    const wanted = normalizeLang(roomInfo.lang, uiTable);
    if (wanted !== lang) { applyLang(wanted); return body.more === true; }

    for (const op of ops) {
        if (op.op === 'abandon') toast(t('toast.opponentLeft'));
        else if (op.op === 'host' && op.mine) toast(t('toast.nowHost'));
    }
    if (!first && !wasHost && you.host && !ops.some((o) => o.op === 'host')) {
        toast(t('toast.nowHost'));
    }
    // A new section means the plate starts clean rather than sliding from
    // whatever the last one ended on.
    if (previous && previous.moves > 0 && roomInfo.moves === 0) painted = null;

    renderRoom(ops);
    return body.more === true;
}

/** The room snapshot in the shape logic.js speaks, so the plate can reuse
 *  every rule to grey out a dead shaft. The server still decides. */
function stateFromRoom(room) {
    return {
        board: room.board,
        starter: room.starter,
        turn: room.turn,
        charges: room.charges,
        cooling: room.cooling,
        moves: room.moves,
        outcome: room.outcome === 'p1' ? 1 : room.outcome === 'p2' ? 2 : room.outcome,
        seams: room.seam ? [{ seat: room.outcome === 'p2' ? 2 : 1, cells: room.seam }] : [],
    };
}

const nameOfSeat = (seat) => players.find((p) => p.seat === seat)?.name ?? '';

function renderRoom(ops = []) {
    if (mode !== 'room' || !roomInfo || !you) return;

    if (roomInfo.status === 'lobby') {
        $('codeValue').textContent = session.code;
        renderRoster($('lobbyRoster'), players);
        showScreen('lobbyScreen');
        painted = null;
        return;
    }

    const state = stateFromRoom(roomInfo);
    const mine = state.outcome === null && state.turn === you.seat;
    const themSeat = you.seat === 1 ? 2 : 1;

    paintShafts(state, mine);
    paintHud($('hudAway'), {
        seat: themSeat,
        name: nameOfSeat(themSeat) || '—',
        permits: state.charges[themSeat - 1],
        turn: state.turn === themSeat && state.outcome === null,
        wins: players.find((p) => p.seat === themSeat)?.wins ?? 0,
    });
    paintHud($('hudHome'), {
        seat: you.seat,
        name: nameOfSeat(you.seat),
        permits: state.charges[you.seat - 1],
        turn: mine,
        wins: players.find((p) => p.seat === you.seat)?.wins ?? 0,
    });

    $('boardStatus').textContent = state.outcome !== null ? ''
        : mine ? t('board.yourCut')
            : t('board.theirCut', { name: nameOfSeat(themSeat) });

    // Events give the edge worth animating; the snapshot gives the truth.
    // Several at once (a phone coming back from the background) simply snap.
    const moves = ops.filter((o) => o.op === 'move');
    const edge = moves.length === 1 ? { col: moves[0].col, seat: moves[0].seat, caved: moves[0].caved } : null;

    if (roomInfo.status !== 'over') clearVerdict();
    showScreen('boardScreen');

    // The stamp waits for the section to finish settling, so the seam is on
    // the plate before anything announces it.
    paintSection(state, edge).then(() => {
        if (roomInfo?.status === 'over') showVerdictWhenSettled();
    });
}

function showVerdictWhenSettled() {
    showVerdict();
    const asked = players.find((p) => p.id === you.id)?.wantsAgain === true;
    const other = players.find((p) => p.seat !== you.seat);
    $('verdictAgain').hidden = asked;
    $('verdictWaiting').hidden = !asked;
    if (asked) $('verdictWaiting').textContent = t('verdict.asked', { name: other?.name ?? '' });
}

function renderRoster(list, rows) {
    list.textContent = '';
    for (const seat of [1, 2]) {
        const p = rows.find((r) => r.seat === seat);
        const li = document.createElement('li');
        li.className = 'roster__row' + (p && !p.online ? ' is-offline' : '');

        const core = document.createElement('span');
        core.className = p ? `roster__core roster__core--${seat}` : 'roster__core roster__core--empty';
        li.appendChild(core);

        const name = document.createElement('span');
        name.className = 'roster__name';
        name.textContent = p ? p.name : t('lobby.emptySeat');
        li.appendChild(name);

        const tag = document.createElement('span');
        tag.className = 'roster__tag';
        tag.textContent = t(seat === 1 ? 'board.seat1' : 'board.seat2');
        li.appendChild(tag);

        list.appendChild(li);
    }
}

// ------------------------------------------------------------------
//  The outbox
// ------------------------------------------------------------------

function queue(action, payload) {
    outbox.push({ action, payload });
    pump();
}

async function pump() {
    if (sending) return;
    sending = true;
    while (outbox.length > 0 && session) {
        const job = outbox[0];
        const res = await post(job.action, {
            code: session.code, token: session.token, ...job.payload,
        });
        if (res.ok) {
            outbox.shift();
            failures = 0;
            // Learn the consequence through the poll, the same path everyone
            // else takes. That one line removes a class of divergence bugs.
            schedulePoll(0);
        } else if (res.status === 0 || res.status >= 500) {
            failures++;
            updateSignal();
            await sleep(Math.min(8000, 500 * 2 ** failures));
        } else {
            outbox.shift();
            const reason = res.body?.reason;
            toast(reason ? t(`refuse.${reason}`) : (res.body?.error ?? t('error.network')));
            schedulePoll(0);
        }
    }
    sending = false;
    updateSignal();
}

// ------------------------------------------------------------------
//  Cutting
// ------------------------------------------------------------------

function cut(col) {
    if (painting || botThinking) return;
    if (mode === 'room') {
        if (!roomInfo || roomInfo.status !== 'play' || roomInfo.turn !== you?.seat) return;
        queue('move', { col });
        return;
    }
    localCut(col);
}

// ------------------------------------------------------------------
//  Joining, leaving, resuming
// ------------------------------------------------------------------

function saveSession() {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
}

function enterRoom(granted, name) {
    mode = 'room';
    session = { code: granted.code, token: granted.token, name };
    you = granted.you;
    roomInfo = granted.room;
    players = [];
    model = createRoomModel();
    painted = null;
    failures = 0;
    saveSession();
    // The code, never the token.
    history.replaceState(null, '', `?room=${granted.code}`);
    updateSignal();
    renderRoom();
    schedulePoll(0);
}

function leaveLocal(message) {
    clearTimeout(pollTimer);
    session = null;
    roomInfo = null;
    you = null;
    players = [];
    outbox = [];
    mode = null;
    painted = null;
    saveSession();
    history.replaceState(null, '', location.pathname);
    updateSignal();
    if (message) toast(message);
    showScreen('bootScreen');
}

async function copyLink() {
    const url = `${location.origin}${location.pathname}?room=${session.code}`;
    const hint = $('codeHint');
    try {
        await navigator.clipboard.writeText(url);
        hint.textContent = t('lobby.linkCopied');
    } catch {
        // Clipboard blocked: show the code big enough to read out loud.
        hint.textContent = `[ ${session.code} ]`;
    }
    setTimeout(() => { hint.textContent = t('lobby.tapToCopy'); }, 2600);
}

function openGate(intent, prefill) {
    gateIntent = intent;
    $('gateTitle').textContent = t(intent === 'join' ? 'gate.joinTitle' : 'gate.openTitle');
    $('gateSubmit').textContent = t(intent === 'join' ? 'gate.join' : 'gate.open');
    $('gateCodeField').hidden = intent !== 'join';
    $('gateLangField').hidden = intent !== 'open';
    $('gateError').hidden = true;
    $('gateName').value = localStorage.getItem(NAME_KEY) ?? '';
    if (prefill) $('gateCode').value = prefill;
    showScreen('gateScreen');
}

async function submitGate(event) {
    event.preventDefault();
    const name = cleanName($('gateName').value);
    if (!isValidName(name)) {
        $('gateError').textContent = t('error.nameRequired');
        $('gateError').hidden = false;
        return;
    }
    localStorage.setItem(NAME_KEY, name);

    const button = $('gateSubmit');
    button.disabled = true;

    if (gateIntent === 'open') {
        const res = await post('create', { name, lang });
        button.disabled = false;
        if (!res.ok) { gateFailed(res); return; }
        enterRoom(res.body, name);
        return;
    }

    const code = normalizeCode($('gateCode').value);
    if (!isValidCode(code)) {
        button.disabled = false;
        $('gateError').textContent = t('error.codeRequired');
        $('gateError').hidden = false;
        return;
    }
    const res = await post('join', { code, name });
    button.disabled = false;
    if (res.ok) { enterRoom(res.body, name); return; }
    // A section already being worked offers the seat picker instead of just
    // failing: this is the phone that lost its session mid-match.
    if (res.body?.reclaim === true) { openSeats(code); return; }
    gateFailed(res);
}

function gateFailed(res) {
    $('gateError').textContent = res.body?.error ?? t('error.network');
    $('gateError').hidden = false;
}

async function openSeats(code) {
    const res = await post('seats', { code });
    if (!res.ok) { gateFailed(res); return; }
    const list = $('seatsList');
    list.textContent = '';
    for (const p of res.body.players) {
        const li = document.createElement('li');
        li.className = 'roster__row';
        li.innerHTML = `<span class="roster__core roster__core--${p.seat}"></span>`;
        const name = document.createElement('span');
        name.className = 'roster__name';
        name.textContent = p.name;
        li.appendChild(name);

        const take = document.createElement('button');
        take.type = 'button';
        take.className = 'roster__take';
        take.textContent = t(p.reclaimable ? 'seats.take' : 'seats.busy');
        take.disabled = !p.reclaimable;
        take.addEventListener('click', async () => {
            const claim = await post('reclaim', { code, playerId: p.id });
            if (claim.ok) enterRoom(claim.body, p.name);
            else toast(claim.body?.error ?? t('error.network'));
        });
        li.appendChild(take);
        list.appendChild(li);
    }
    showScreen('seatsScreen');
}

async function resume() {
    const saved = localStorage.getItem(SESSION_KEY);
    if (!saved) return false;
    let parsed;
    try { parsed = JSON.parse(saved); } catch { return false; }
    if (!parsed?.code || !parsed?.token) return false;

    session = parsed;
    mode = 'room';
    you = { id: 0, seat: 0, host: false, wins: 0 };
    // since: 0 replays the whole section in one request.
    const res = await post('poll', { code: session.code, token: session.token, since: 0 });
    if (!res.ok) { session = null; mode = null; you = null; saveSession(); return false; }
    model = createRoomModel();
    painted = null;
    history.replaceState(null, '', `?room=${session.code}`);
    handlePoll(res.body);
    updateSignal();
    schedulePoll(0);
    return true;
}

// ------------------------------------------------------------------
//  Wiring
// ------------------------------------------------------------------

function wire() {
    $('doorRoom').addEventListener('click', () => openGate('open'));
    // The join gate is the same gate, with the code field shown. It used to be
    // reachable only by following a shared link, which left anyone sitting in
    // the same room reading the code aloud with nowhere to type it.
    $('doorJoin').addEventListener('click', () => openGate('join'));
    $('doorLocal').addEventListener('click', () => startLocal('local'));
    $('doorSolo').addEventListener('click', () => { renderSolo(); showScreen('soloScreen'); });
    $('doorRules').addEventListener('click', () => showScreen('rulesScreen'));

    document.querySelectorAll('[data-close-rules], [data-back-to-boot]').forEach((el) => {
        el.addEventListener('click', () => {
            if (mode === 'room' && session) leaveLocal();
            else { mode = null; game = null; painted = null; updateSignal(); showScreen('bootScreen'); }
        });
    });

    $('gateForm').addEventListener('submit', submitGate);
    $('gateCode').addEventListener('input', (e) => { e.target.value = normalizeCode(e.target.value); });

    $('codePlate').addEventListener('click', copyLink);
    $('lobbyLeave').addEventListener('click', () => {
        if (session) post('leave', { code: session.code, token: session.token });
        leaveLocal();
    });
    $('boardLeave').addEventListener('click', () => {
        if (mode === 'room' && session) {
            post('leave', { code: session.code, token: session.token });
            leaveLocal();
        } else { mode = null; game = null; painted = null; showScreen('bootScreen'); }
    });

    $('verdictAgain').addEventListener('click', () => {
        if (mode === 'room') { queue('again', {}); return; }
        game = newGame({ starter: game.starter === 1 ? 2 : 1 });
        painted = null;
        clearVerdict();
        showScreen('boardScreen');
        renderLocal();
        paintSection(game, null);
        if (mode === 'solo' && game.turn === 2) botTurn();
    });

    window.addEventListener('resize', () => { if (!painting) measureCell(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedulePoll(0); });
}

async function boot() {
    await loadTable();
    applyLang(localStorage.getItem(LANG_KEY) ?? navigator.language?.slice(0, 2));
    wire();
    buildGrid();
    buildShafts();

    const shared = normalizeCode(new URLSearchParams(location.search).get('room') ?? '');
    if (localStorage.getItem(SESSION_KEY) && await resume()) return;
    if (isValidCode(shared)) { openGate('join', shared); return; }

    showScreen('bootScreen');
}

boot();
