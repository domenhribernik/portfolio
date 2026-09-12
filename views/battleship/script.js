/* ============================================================
   BATTLESHIP // THE PLOT TABLE :: page controller

   Two gamemodes share one set of screens:
     room  a phone each, over an anonymous four letter room code.
     solo  one plot against the bot, entirely in this tab.

   The room mode is the same base as views/spy and views/seam: adaptive short
   polling over an append-only event log whose id is the cursor, a client
   outbox so writes arrive in order, and the CONSEQUENCE OF YOUR OWN MOVE
   LEARNED THROUGH THE POLL rather than through the response. That last rule
   is worth keeping: it removes a whole class of divergence bugs, because
   there is only one path by which the plot ever changes.

   Nothing here decides anything. actionError and applyAction in logic.js
   drive the preview, the greying out and the whole solo game, and in a room
   game battleship-controller.php recomputes every one of those answers from
   the stored row and its answer is the only one that counts.

   Two things this file does own:

   THE ORDER. A tap on the plot only aims. The shot leaves when the order
   button under the rail is pressed, so a brushed thumb never fires and a
   phone never has to guess whether a tap was a hover.

   THE STAGE. The poll hands over a plot that has already changed. Every
   report is queued and played as a sequence (reticle, wait, counter, wreck),
   and while it plays the painted plot is held a second behind the truth.
   choreo.js decides how far behind; this file only paints what it says.
   ============================================================ */

import {
    SIZE, CELLS, FLEET, COST, UNLOCK, SALVAGE_CAP,
    coordName, onPlot, shipCells, placementError, autoPlace,
    blockCells, barrageCells, newMatch, actionError, applyAction,
    enemyView, ownView, other,
    normalizeCode, isValidCode, cleanName, isValidName,
    createRoomModel, applyEvents, pollDelay,
} from './logic.js';
import { LEVELS, chooseAction } from './bot.js';
import {
    tempo, landingPlan, heldCells, projectGrid, landingCells,
    buoyReveals, readingAt, restingSide, isStaleRoom,
} from './choreo.js';

const API = '../../app/controllers/battleship-controller.php';
const SESSION_KEY = 'battleship:session';
const NAME_KEY = 'battleship:name';
const LANG_KEY = 'battleship:lang';

const $ = (id) => document.getElementById(id);
const show = (el, on) => { (typeof el === 'string' ? $(el) : el).hidden = !on; };
const wait = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = () => matchMedia('(hover: hover) and (pointer: fine)').matches;

// ------------------------------------------------------------------
//  Language
// ------------------------------------------------------------------

let strings = {};
let lang = 'en';

function t(key, vars) {
    const row = strings[key];
    let out = (row && (row[lang] ?? row.en)) ?? key;
    if (vars) {
        for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
    }
    return out;
}

async function loadStrings() {
    try {
        // Revalidated rather than force-cached: a copy edit has to be able to
        // land without every returning player carrying the old wording.
        const res = await fetch('i18n/ui.json', { cache: 'no-cache' });
        strings = await res.json();
    } catch { strings = {}; }
    const stored = localStorage.getItem(LANG_KEY);
    lang = stored ?? ((navigator.language || 'en').slice(0, 2) === 'sl' ? 'sl' : 'en');
    if (!['en', 'sl'].includes(lang)) lang = 'en';
    document.documentElement.lang = lang;
    for (const el of document.querySelectorAll('[data-i18n]')) {
        el.textContent = t(el.dataset.i18n);
    }
}

// ------------------------------------------------------------------
//  Chrome
// ------------------------------------------------------------------

let toastTimer = null;

function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('is-up');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-up'), 3200);
}

/** The live region. Every resolution is spoken, so the plot is playable blind. */
function cry(message) {
    $('crier').textContent = message;
}

const SCREENS = ['bootScreen', 'rulesScreen', 'gateScreen', 'lobbyScreen',
    'seatsScreen', 'placeScreen', 'battleScreen', 'overScreen'];

let screen = 'bootScreen';

function showScreen(id) {
    screen = id;
    for (const s of SCREENS) $(s).classList.toggle('is-on', s === id);
    document.querySelector('.stage').classList.toggle('is-wide', id === 'battleScreen');
    show('roomTag', mode === 'room' && !!session && id !== 'bootScreen');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ------------------------------------------------------------------
//  Routing
//
//  The navigational screens carry a real hash, so the Android back button and
//  components/back-link.js walk them the way they walk any other view here.
//  The game screens deliberately do not: pressing back mid match must never
//  land on the placement screen of a match already at sea, so those are
//  entered with replaceState and left through EXIT.
// ------------------------------------------------------------------

const ROUTES = { '': 'bootScreen', 'rules': 'rulesScreen', 'open': 'gateScreen', 'join': 'gateScreen' };

function route() {
    const hash = location.hash.replace(/^#\/?/, '');
    if (session && ['lobbyScreen', 'placeScreen', 'battleScreen', 'overScreen'].includes(screen)) return;
    if (mode === 'solo' && screen !== 'bootScreen' && hash === '') { return; }
    const target = ROUTES[hash] ?? 'bootScreen';
    if (target === 'gateScreen') openGate(hash === 'join');
    else showScreen(target);
}

const go = (hash) => { location.hash = hash; };
const replaceTo = (id) => {
    history.replaceState(history.state, '', location.pathname + location.search);
    showScreen(id);
};

// ------------------------------------------------------------------
//  Transport. Never throws: status 0 means the network died, which is what
//  lets the poll loop and the outbox tell it apart from a refusal.
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
        return { ok: false, status: 0, body: null };
    } finally {
        clearTimeout(timer);
    }
}

// ------------------------------------------------------------------
//  State
// ------------------------------------------------------------------

let mode = null;            // 'room' | 'solo'
let session = null;         // { code, token, name }
let seat = 0;
let model = createRoomModel();
let snapshot = null;        // { room, you, enemy } as the poll hands it over
let solo = null;            // { match, seat, level, name }
let tool = 'fire';
let pendingDir = 'h';
let movingKey = null;       // the hull a reberth is moving
let aimed = null;           // the cell tapped, waiting for the order
let firedCells = [];        // cells of an order still in the air
let userSide = null;        // a plot tab the player chose this turn
let lastTurnOwner = null;
let intelStaleFrom = 0;     // readings before this index predate an enemy move
let mySweeps = 0;
let logLines = [];
let logRendered = 0;

// The outbox: writes leave in order, and the result is learned by polling.
const outbox = [];
let pumping = false;
let pollTimer = null;
let pollBusy = false;
let pollWanted = false;
let failures = 0;
// After a move leaves, the next poll has to show a room at least this many
// turns along, or it left the server before the move arrived. See choreo.js.
let expectTurns = null;
let staleSkips = 0;

function saveSession() {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
}

// ------------------------------------------------------------------
//  The plot
// ------------------------------------------------------------------

const LETTERS = 'ABCDEFGHIJ';

/** Build a 10x10 of buttons with a lettered and numbered ruler around it. */
function buildPlot(el, onPick, onPeek) {
    el.replaceChildren();
    const corner = document.createElement('span');
    corner.className = 'ruler';
    el.append(corner);
    for (let c = 0; c < SIZE; c++) {
        const h = document.createElement('span');
        h.className = 'ruler';
        h.textContent = LETTERS[c];
        h.setAttribute('aria-hidden', 'true');
        el.append(h);
    }
    for (let r = 0; r < SIZE; r++) {
        const n = document.createElement('span');
        n.className = 'ruler';
        n.textContent = String(r + 1);
        n.setAttribute('aria-hidden', 'true');
        el.append(n);
        for (let c = 0; c < SIZE; c++) {
            const i = r * SIZE + c;
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'cell';
            b.dataset.cell = String(i);
            b.addEventListener('click', (e) => onPick(i, e));
            if (onPeek) {
                // A hover preview only where there is a hover. On a touch
                // screen a mouseover handler that changes the page is what
                // makes the first tap a hover and the second the click.
                b.addEventListener('mouseenter', () => { if (finePointer()) onPeek(i); });
                b.addEventListener('focus', () => onPeek(i));
            }
            el.append(b);
        }
    }
    if (onPeek) {
        el.addEventListener('mouseleave', () => onPeek(null));
        el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) onPeek(null); });
    }
    // A counter's landing animation is one shot: strip the class when it
    // ends so the next mark on the same cell can play it again.
    el.addEventListener('animationend', (e) => {
        if (e.animationName === 'splash') e.target.classList.remove('is-splash');
        else if (e.animationName.startsWith('counter')) e.target.classList.remove('is-new');
    });
}

const cellsOf = (el) => [...el.querySelectorAll('.cell')];

/** The cell buttons of each plot, cached once built. */
const nodes = { enemy: [], own: [] };
const plotEl = (which) => (which === 'enemy' ? $('enemyPlot') : $('ownPlot'));

const MARK_CLASS = {
    o: 'mark-miss', x: 'mark-hit', s: 'mark-sunk', d: 'mark-decoy', D: 'mark-hit',
};

const MARK_WORD = {
    '.': 'unfired', o: 'miss', x: 'hit', s: 'sunk', d: 'decoy', D: 'hit',
};

// What each plot currently shows. `shown` is the grid string as painted,
// null until the first paint, so a plot drawn from a refresh sets nothing
// in motion. `base` is the class string applied to each cell, so a poll that
// changes nothing touches nothing, and the transient classes the stage adds
// (aim, reticle, splash) survive a repaint.
const shown = { enemy: null, own: null };
const base = { enemy: [], own: [] };

function setBase(which, i, cls, markChanged) {
    const node = nodes[which][i];
    const old = base[which][i];
    if (old !== cls) {
        if (old) node.classList.remove(...old.split(' '));
        node.classList.add(...cls.split(' '));
        base[which][i] = cls;
    }
    if (markChanged && shown[which] !== null) {
        node.classList.remove('is-new');
        void node.offsetWidth;
        node.classList.add('is-new');
    }
}

const latestGrid = (which, v) => (which === 'enemy' ? v.enemy.grid : v.you.grid);

/**
 * Paint one plot from the view, holding back the cells in `hold` at what
 * they already show. `live` is true only while a tool that aims at your OWN
 * water is selected; the rest of the time your plot is a status board.
 */
function paintBoard(which, v, hold = new Set(), live = false) {
    const next = latestGrid(which, v);
    const prev = shown[which] ?? next;
    const grid = projectGrid(prev, next, hold);
    const you = v.you;
    const own = which === 'own';

    const hull = own ? new Set((you.fleet ?? []).flatMap((s) => shipCells(s))) : null;
    const buoys = own ? new Set(you.decoys ?? []) : null;
    const lit = own ? new Set((you.swept ?? []).flatMap((at) => blockCells(at))) : null;
    const swept = new Set();
    const readings = new Map();
    if (!own) {
        (you.intel ?? []).forEach((r, k) => {
            for (const c of blockCells(r.at)) swept.add(c);
            readings.set(r.at, { count: r.count, stale: k < intelStaleFrom });
        });
    }

    for (let i = 0; i < CELLS; i++) {
        const node = nodes[which][i];
        const mark = grid[i];
        const bits = ['cell'];
        if (own) {
            if (hull.has(i)) bits.push('is-hull');
            if (buoys.has(i)) bits.push('is-buoy');
            if (lit.has(i)) bits.push('is-lit');
        } else if (swept.has(i)) {
            bits.push('is-swept');
            if (readings.get(i)?.stale) bits.push('is-stale');
        }
        if (MARK_CLASS[mark]) bits.push(MARK_CLASS[mark]);
        setBase(which, i, bits.join(' '), prev[i] !== mark && shown[which] !== null);

        const reading = readings.get(i);
        if (reading) node.dataset.reading = String(reading.count);
        else delete node.dataset.reading;

        node.disabled = own ? !live : mark !== '.';
        const what = own ? (hull.has(i) ? 'your hull' : buoys.has(i) ? 'your buoy' : 'open water') : null;
        node.setAttribute('aria-label', [
            coordName(i), what, MARK_WORD[mark] ?? 'unfired',
            reading ? `sonar ${reading.count}` : null,
        ].filter(Boolean).join(', '));
    }
    shown[which] = grid;
}

/** Everything a plot remembers, forgotten. Runs when a battle screen opens. */
function resetBoards() {
    for (const which of ['enemy', 'own']) {
        shown[which] = null;
        base[which] = [];
        for (const n of nodes[which]) {
            n.className = 'cell';
            delete n.dataset.reading;
        }
        for (const el of [$('ownLamps'), $('enemyLamps')]) delete el.dataset.painted;
    }
    for (const el of [$('enemyCallout'), $('ownCallout')]) el.classList.remove('is-up');
    aimed = null;
    firedCells = [];
    userSide = null;
    lastTurnOwner = null;
    intelStaleFrom = 0;
    mySweeps = 0;
    tool = 'fire';
    pendingDir = 'h';
    movingKey = null;
}

// --- the tote board ---------------------------------------------------

function buildLamps(el) {
    el.replaceChildren();
    for (let i = 0; i < SALVAGE_CAP; i++) {
        const pip = document.createElement('span');
        pip.className = 'lamp-pip';
        pip.addEventListener('animationend', () => pip.classList.remove('is-new'));
        el.append(pip);
    }
}

/** Light the first `count` lamps. Only a lamp that changes moves. */
function setLamps(el, count) {
    const painted = el.dataset.painted === '1';
    [...el.children].forEach((pip, i) => {
        const on = i < count;
        if (on && !pip.classList.contains('is-lit') && painted) pip.classList.add('is-new');
        pip.classList.toggle('is-lit', on);
    });
    el.dataset.painted = '1';
}

// ------------------------------------------------------------------
//  The tool rail
// ------------------------------------------------------------------

const TOOLS = ['fire', 'sonar', 'decoy', 'barrage', 'reposition', 'depthCharge'];

/** Where a tool is aimed: the enemy plot, or your own. */
const AIMS_AT_SELF = new Set(['decoy', 'reposition']);

/** Tools with a direction, which the TURN button swings. */
const DIRECTIONAL = new Set(['barrage', 'reposition']);

function buildRail() {
    const rail = $('rail');
    rail.replaceChildren();
    TOOLS.forEach((kind, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tool';
        b.dataset.kind = kind;
        b.innerHTML = `<span class="tool-key">${i + 1}</span>
            <span class="tool-name"></span><span class="tool-cost"></span>`;
        b.addEventListener('click', () => pickTool(kind));
        rail.append(b);
    });
}

function pickTool(kind) {
    const v = currentView();
    if (!v || !isMyTurn(v) || stage.running) return;
    // An aimed cell survives a change of tool only if the new tool aims at
    // the same plot; the order re-reads itself either way.
    if (AIMS_AT_SELF.has(kind) !== AIMS_AT_SELF.has(tool)) aimed = null;
    tool = kind;
    pendingDir = 'h';
    userSide = null;
    // Repositioning needs a hull chosen before a berth. Start on the biggest
    // one that can still run, so the tool is usable in one tap.
    if (kind === 'reposition') {
        const free = (v.you.fleet ?? []).filter((sh) => shipCells(sh).every((c) => v.you.grid[c] === '.'));
        if (!free.some((sh) => sh.key === movingKey)) {
            movingKey = free.sort((a, b) => shipCells(b).length - shipCells(a).length)[0]?.key ?? null;
        }
    }
    renderBattle();
}

function renderRail(v) {
    const mine = v.you;
    const wrecks = (mine.sunk ?? []).length;
    const live = isMyTurn(v) && !stage.running;
    for (const b of $('rail').children) {
        const kind = b.dataset.kind;
        const cost = COST[kind] ?? 0;
        const locked = kind !== 'fire' && wrecks < UNLOCK[kind];
        const broke = kind !== 'fire' && mine.salvage < cost;
        b.querySelector('.tool-name').textContent = t(`tool.${kind}`);
        b.querySelector('.tool-cost').textContent = kind === 'fire'
            ? t('tool.free')
            : locked ? t('tool.locked', { n: UNLOCK[kind] }) : String(cost);
        b.classList.toggle('is-on', tool === kind);
        b.classList.toggle('is-locked', locked);
        b.setAttribute('aria-pressed', String(tool === kind));
        b.disabled = !live || locked || broke;
    }
}

/** The footprint the selected tool would touch from `at`. */
function footprint(at) {
    if (!onPlot(at)) return [];
    switch (tool) {
        case 'fire':
        case 'decoy':
            return [at];
        case 'sonar':
        case 'depthCharge':
            return blockCells(at);
        case 'barrage':
            return barrageCells(at, pendingDir) ?? [];
        case 'reposition':
            return movingKey ? shipCells({ key: movingKey, at, dir: pendingDir }) : [];
        default:
            return [];
    }
}

function actionFor(at) {
    switch (tool) {
        case 'barrage': return { kind: 'barrage', at, dir: pendingDir };
        case 'reposition': return { kind: 'reposition', ship: movingKey, at, dir: pendingDir };
        default: return { kind: tool, at };
    }
}

// ------------------------------------------------------------------
//  Aiming and the order
// ------------------------------------------------------------------

let peekAt = null;

/** The footprint under the aim, or under the pointer while nothing is aimed. */
function renderAim() {
    const v = currentView();
    for (const which of ['enemy', 'own']) {
        for (const c of nodes[which]) c.classList.remove('is-aimed', 'is-bad', 'is-target');
    }
    if (!v || !isMyTurn(v) || stage.running) return;
    const which = AIMS_AT_SELF.has(tool) ? 'own' : 'enemy';
    if (aimed !== null) nodes[which][aimed]?.classList.add('is-target');
    const at = peekAt ?? aimed;
    if (at === null) return;
    const cells = footprint(at);
    const bad = cells.length === 0 || actionError(asMatch(v), mySeat(), actionFor(at)) !== null;
    for (const c of cells) nodes[which][c]?.classList.add(bad ? 'is-bad' : 'is-aimed');
}

function peek(at) {
    peekAt = at;
    renderAim();
}

/** A tap on the plot. It aims; only the order fires. */
function pickCell(at, e) {
    const v = currentView();
    if (!v || !isMyTurn(v) || stage.running) return;
    if (at === aimed && e?.detail === 0) {
        // Enter on the cell already aimed at. A keyboard cannot brush a
        // button by accident, so the second press is the order.
        commit();
        return;
    }
    aimed = at;
    renderAim();
    renderOrder(v);
}

/** The order button reads the move back, or the reason it cannot be given. */
function renderOrder(v) {
    const goBtn = $('cmdGo');
    const verb = $('cmdVerb');
    const cost = $('cmdCost');
    const turnBtn = $('cmdTurn');
    const mine = isMyTurn(v);
    const state = turnState(v);
    goBtn.classList.remove('is-bad', 'is-theirs', 'is-incoming', 'is-inair');
    turnBtn.hidden = !(mine && state === 'yours' && DIRECTIONAL.has(tool));
    cost.textContent = '';
    goBtn.disabled = true;

    if (state !== 'yours') {
        goBtn.classList.add(`is-${state}`);
        verb.textContent = turnText(v, state);
        return;
    }
    if (tool === 'reposition' && !movingKey) {
        verb.textContent = t('battle.pickHull');
        return;
    }
    if (tool !== 'fire') cost.textContent = t('battle.cost', { n: COST[tool] });
    if (aimed === null) {
        verb.textContent = t(AIMS_AT_SELF.has(tool) ? 'battle.pickWater' : 'battle.pickTarget');
        return;
    }
    const err = actionError(asMatch(v), mySeat(), actionFor(aimed));
    if (err !== null) {
        goBtn.classList.add('is-bad');
        verb.textContent = t('battle.badTarget');
        $('railHint').textContent = t(`refuse.${err}`);
        return;
    }
    verb.textContent = t(`commit.${tool}`, { at: coordName(aimed) });
    if (tool === 'fire') cost.textContent = t('battle.free');
    goBtn.disabled = false;
}

/** The order is given. */
function commit() {
    const v = currentView();
    if (!v || !isMyTurn(v) || stage.running || aimed === null) return;
    const action = actionFor(aimed);
    const err = actionError(asMatch(v), mySeat(), action);
    if (err !== null) { toast(t(`refuse.${err}`)); return; }
    const at = aimed;
    aimed = null;
    peekAt = null;
    if (AIMS_AT_SELF.has(tool)) {
        // Nothing lands on your own water: say what was done, and where.
        note(`<b>${t('log.you')}</b> ${t(tool === 'decoy' ? 'log.buoy' : 'log.moved')}`, true);
    } else {
        firedCells = footprint(at);
        for (const c of firedCells) nodes.enemy[c].classList.add('is-fired');
    }
    if (tool !== 'fire') tool = 'fire';
    if (mode === 'solo') soloAct(action);
    else queue(action);
    renderAim();
}

function clearFired() {
    for (const c of firedCells) nodes.enemy[c]?.classList.remove('is-fired');
    firedCells = [];
}

function swing() {
    if (!DIRECTIONAL.has(tool)) return;
    pendingDir = pendingDir === 'h' ? 'v' : 'h';
    renderAim();
    const v = currentView();
    if (v) renderOrder(v);
}

// ------------------------------------------------------------------
//  The bridge between a poll payload and the rules
//
//  actionError needs a match. In a room game we have only our own half of
//  one, so this rebuilds the shape from what the poll disclosed: our real
//  fleet, and an enemy of empty water. That is enough for every refusal the
//  client is allowed to predict (turn, price, rung, footprint, spent cell)
//  and it CANNOT predict a hit, which is exactly right.
// ------------------------------------------------------------------

function asMatch(v) {
    if (mode === 'solo') return solo.match;
    const me = mySeat() || 1;
    const foe = other(me);
    return {
        status: v.room.status === 'battle' ? 'battle' : v.room.status,
        turn: v.room.turn,
        starter: v.room.starter,
        turns: v.room.turns,
        outcome: v.room.outcome,
        sides: {
            [me]: {
                fleet: v.you.fleet ?? [], grid: v.you.grid, decoys: v.you.decoys ?? [],
                swept: v.you.swept ?? [], salvage: v.you.salvage, spent: 0, shots: 0, hits: 0,
                intel: v.you.intel ?? [],
            },
            [foe]: {
                fleet: [], grid: v.enemy.grid, decoys: [], swept: [],
                salvage: v.enemy.salvage, spent: 0, shots: 0, hits: 0, intel: [],
            },
        },
    };
}

const mySeat = () => (mode === 'solo' && solo ? solo.seat : seat);
const isMyTurn = (v) => v.room.status === 'battle' && v.room.turn === mySeat();

function currentView() {
    if (mode === 'solo' && solo) return soloView();
    return snapshot;
}

// ------------------------------------------------------------------
//  Rendering a turn
// ------------------------------------------------------------------

/** yours | theirs | incoming | inair: what the room is doing right now. */
function turnState(v) {
    if (stage.state) return stage.state;
    if (firedCells.length) return 'inair';
    return isMyTurn(v) ? 'yours' : 'theirs';
}

function turnText(v, state) {
    switch (state) {
        case 'yours': return t('battle.yourTurn');
        case 'incoming': return t('battle.incoming');
        case 'inair': return t('battle.inAir');
        default: return t('battle.theirTurn', { who: v.enemy.name ?? '' });
    }
}

function renderTurn(v) {
    const state = turnState(v);
    $('turnBar').className = `turn-bar is-${state}`;
    $('turnText').textContent = turnText(v, state);
}

/** The cells each plot must keep showing as they were, per queued report. */
function holds(v) {
    const out = { enemy: new Set(), own: new Set() };
    if (!stage.running) return out;
    for (const which of ['enemy', 'own']) {
        const mine = which === 'enemy';
        const queue = stage.queue.filter((op) => (op.seat === mySeat()) === mine);
        const next = latestGrid(which, v);
        out[which] = heldCells(queue, shown[which] ?? next, next, stage.landed);
    }
    return out;
}

function paintBoards(v) {
    const hold = holds(v);
    const live = isMyTurn(v) && !stage.running && AIMS_AT_SELF.has(tool);
    // A buoy owning up is not an event, it is a mark changing under you.
    const prevEnemy = shown.enemy ?? v.enemy.grid;
    const reveals = buoyReveals(prevEnemy, projectGrid(prevEnemy, v.enemy.grid, hold.enemy));
    paintBoard('enemy', v, hold.enemy);
    paintBoard('own', v, hold.own, live);
    for (const c of reveals) {
        note(`<b>${t('log.them')}</b> ${t('log.buoyWas', { at: coordName(c) })}`, false);
    }
}

/** The salvage board. Called as counters land, so the pay reads as earned. */
function renderTote(v) {
    setLamps($('ownLamps'), v.you.salvage);
    setLamps($('enemyLamps'), v.enemy.salvage);
    $('ownCount').textContent = String(v.you.salvage);
    $('enemyCount').textContent = String(v.enemy.salvage);
}

function renderBattle({ keepSide = false } = {}) {
    const v = currentView();
    if (!v) return;
    paintBoards(v);
    renderTote(v);
    $('ownName').textContent = v.you.name ?? '';
    $('enemyName').textContent = v.enemy.name ?? '';

    renderTurn(v);
    renderRail(v);
    renderRoster(v);
    renderFleetStatus(v, tool === 'reposition' && isMyTurn(v));
    $('railHint').textContent = isMyTurn(v) && !stage.running ? t(`hint.${tool}`) : '';
    renderOrder(v);
    renderAim();
    renderLog();

    if (v.room.turn !== lastTurnOwner) {
        // A new turn, a new choice of plot: the tab the player tapped last
        // turn no longer applies.
        userSide = null;
        lastTurnOwner = v.room.turn;
    }
    if (!keepSide && !stage.running) settleSide(v);
}

/** The plot under the lamp when nothing is playing. */
function settleSide(v = currentView()) {
    if (!v) return;
    if (userSide) { showSide(userSide); return; }
    if (firedCells.length) { showSide('enemy'); return; }
    showSide(restingSide({ mine: isMyTurn(v), aimsAtSelf: AIMS_AT_SELF.has(tool) }));
}

function renderRoster(v) {
    const list = $('enemyFleet');
    const down = new Set(v.enemy.sunk ?? []);
    if (list.children.length !== FLEET.length) {
        list.replaceChildren();
        for (const { key, len } of FLEET) {
            const li = document.createElement('li');
            li.className = 'hull-row';
            li.dataset.key = key;
            const name = document.createElement('span');
            const pips = document.createElement('span');
            pips.className = 'pips';
            for (let i = 0; i < len; i++) {
                const p = document.createElement('span');
                p.className = 'pip';
                pips.append(p);
            }
            li.append(name, pips);
            list.append(li);
        }
    }
    for (const li of list.children) {
        li.firstChild.textContent = t(`ship.${li.dataset.key}`);
        li.classList.toggle('is-down', down.has(li.dataset.key));
    }
}

function renderFleetStatus(v, pickable) {
    const list = $('fleetStatus');
    list.replaceChildren();
    const grid = v.you.grid;
    for (const { key } of FLEET) {
        const hull = (v.you.fleet ?? []).find((s) => s.key === key);
        const cells = hull ? shipCells(hull) : [];
        const down = cells.length > 0 && cells.every((c) => grid[c] === 's');
        const li = document.createElement('li');
        li.className = 'hull-row' + (down ? ' is-down' : '');
        const name = document.createElement('span');
        name.textContent = t(`ship.${key}`);
        const pips = document.createElement('span');
        pips.className = 'pips';
        for (const c of cells) {
            const p = document.createElement('span');
            p.className = 'pip' + (grid[c] === 'x' || grid[c] === 's' ? ' is-hit' : '');
            pips.append(p);
        }
        li.append(name, pips);
        // In reposition mode the list becomes the hull picker, because a
        // second list of the same five names would be noise.
        if (pickable && !down && cells.every((c) => grid[c] === '.')) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'hull-pick' + (movingKey === key ? ' is-on' : '');
            b.textContent = t('place.move');
            b.addEventListener('click', () => {
                movingKey = key;
                aimed = null;
                renderFleetStatus(v, true);
                renderAim();
                renderOrder(v);
            });
            li.append(b);
        }
        list.append(li);
    }
}

/** Append what is new. The reader's scroll position is theirs. */
function renderLog() {
    const el = $('log');
    if (logRendered > logLines.length) {
        el.replaceChildren();
        logRendered = 0;
    }
    if (logRendered === logLines.length) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
    for (; logRendered < logLines.length; logRendered++) {
        const line = logLines[logRendered];
        const li = document.createElement('li');
        li.className = line.mine ? 'is-mine' : '';
        li.innerHTML = line.html;
        el.append(li);
    }
    while (el.children.length > 60) el.firstChild.remove();
    if (atBottom) el.scrollTop = el.scrollHeight;
}

function note(html, mine) {
    logLines.push({ html, mine });
    if (screen === 'battleScreen') renderLog();
}

/** Bring one plot forward. On a phone the other is hidden; on a wide screen it sits back in the dark. */
function showSide(which) {
    $('enemySide').classList.toggle('is-off', which !== 'enemy');
    $('ownSide').classList.toggle('is-off', which !== 'own');
    $('switchEnemy').classList.toggle('is-on', which === 'enemy');
    $('switchOwn').classList.toggle('is-on', which === 'own');
    $('switchEnemy').setAttribute('aria-selected', String(which === 'enemy'));
    $('switchOwn').setAttribute('aria-selected', String(which === 'own'));
}

// ------------------------------------------------------------------
//  The stage: reports are played, not painted
// ------------------------------------------------------------------

const stage = { queue: [], running: false, landed: new Set(), state: null };

/** Reports that arrived together are played one after another. */
function enqueue(ops) {
    if (!ops.length) return;
    // A phone that was asleep does not owe the player a re-enactment of the
    // whole stretch it missed; the last two land, the rest are read in.
    if (ops.length > 3) {
        for (const op of ops.slice(0, -2)) readIn(op);
        ops = ops.slice(-2);
    }
    stage.queue.push(...ops);
    if (!stage.running) runStage();
}

async function runStage() {
    stage.running = true;
    while (stage.queue.length) {
        const op = stage.queue[0];
        stage.landed = new Set();
        await playOp(op);
        stage.queue.shift();
    }
    stage.running = false;
    stage.state = null;
    const v = currentView();
    if (v && v.room.status === 'battle' && screen === 'battleScreen') {
        // The turn flips first; the plot follows a beat later, so the eye
        // reads the flag before the table moves under it.
        renderBattle({ keepSide: true });
        await wait(tempo(reduced()).handover);
        if (!stage.running) settleSide();
    }
    if (stage.running) return;
    if (mode === 'room') syncScreen();
    else afterSoloStage();
}

async function playOp(op) {
    const v = currentView();
    if (!v || screen !== 'battleScreen') { readIn(op); return; }
    const t0 = tempo(reduced());
    const mine = op.seat === mySeat();
    const which = mine ? 'enemy' : 'own';
    clearFired();
    // The bar names what the room is doing, not whose turn the snapshot says
    // it is: the turn has already passed by the time a report is played. A
    // sweep or a reberth is not a shell, so neither claims one is in the air.
    stage.state = mine ? null : 'theirs';

    switch (op.op) {
        case 'shot': {
            stage.state = mine ? 'inair' : 'incoming';
            showSide(which);
            renderTurn(v);
            renderOrder(v);
            const plan = landingPlan(op, reduced());
            const all = plan.groups.flat();
            for (const c of all) nodes[which][c].classList.add('is-incoming');
            await wait(plan.aimMs);
            for (const group of plan.groups) {
                const cur = currentView();
                const next = latestGrid(which, cur);
                for (const c of group) {
                    nodes[which][c].classList.remove('is-incoming');
                    if (next[c] === '.') {
                        // Churned water: nothing to set down, so the splash
                        // is the whole record of the shell.
                        nodes[which][c].classList.remove('is-splash');
                        void nodes[which][c].offsetWidth;
                        nodes[which][c].classList.add('is-splash');
                    }
                }
                for (const c of landingCells(group, shown[which] ?? next, next)) stage.landed.add(c);
                if (plan.shake) theatre(which);
                paintBoards(cur);
                renderTote(cur);
                await wait(plan.gapMs);
            }
            announceShot(op.seat, op.kind, op.cells, op.sunk);
            renderRoster(currentView());
            renderFleetStatus(currentView(), false);
            if (op.sunk.length) {
                callout(which, op.sunk, t0.callout);
                await wait(t0.callout);
            }
            await wait(plan.settleMs);
            break;
        }
        case 'swept': {
            showSide(which);
            const block = blockCells(op.at);
            for (const c of block) nodes[which][c].classList.add('is-incoming');
            await wait(t0.aim);
            for (const c of block) nodes[which][c].classList.remove('is-incoming');
            readIn(op);
            paintBoards(currentView());
            await wait(t0.settle);
            break;
        }
        case 'moved':
            readIn(op);
            paintBoards(currentView());
            await wait(t0.settle);
            break;
        default:
            // A buoy dropped by the other side shows nothing, but it took
            // their turn, and the room should feel it pass.
            await wait(t0.settle);
            break;
    }
}

/** Record a report in the log without playing it. */
function readIn(op) {
    const mine = op.seat === mySeat();
    switch (op.op) {
        case 'shot':
            announceShot(op.seat, op.kind, op.cells, op.sunk);
            break;
        case 'swept':
            if (mine) {
                mySweeps++;
                const count = op.count ?? readingAt(currentView()?.you?.intel, op.at);
                const line = t('log.reading', { at: coordName(op.at), n: count ?? '?' });
                note(`<b>${t('log.you')}</b> ${line}`, true);
                cry(line);
            } else {
                note(`<b>${t('log.them')}</b> ${t('log.sweptYou', { at: coordName(op.at) })}`, false);
            }
            break;
        case 'moved':
            if (!mine) {
                // Every reading taken so far may now be wrong.
                intelStaleFrom = mySweeps;
                note(`<b>${t('log.them')}</b> ${t('log.moved')}`, false);
            }
            break;
        default:
            break;
    }
}

function announceShot(seatOfActor, kind, cells, sunk) {
    const mine = seatOfActor === mySeat();
    const who = mine ? t('log.you') : t('log.them');
    if (cells.length) {
        const hits = cells.filter((c) => c.result === 'hit' || c.result === 'sunk' || c.result === 'decoy').length;
        const where = cells.map((c) => coordName(c.cell)).join(' ');
        note(`<b>${who}</b> ${t(`log.${kind}`)} ${where} &middot; ${t('log.hits', { n: hits })}`, mine);
    }
    for (const key of sunk) {
        note(`<b>${t('ship.' + key).toUpperCase()}</b> ${t('log.down')}`, !mine);
    }
    const WORD = { hit: 'res.hit', sunk: 'res.sunk', miss: 'res.miss', decoy: 'res.hit', blast: 'res.blast' };
    if (cells.length === 1) cry(`${coordName(cells[0].cell)}, ${t(WORD[cells[0].result] ?? 'res.miss')}`);
    else if (cells.length) cry(t('log.hits', { n: cells.filter((c) => c.result !== 'miss' && c.result !== 'blast').length }));
}

/** A hull's name across the plot as it goes down. */
function callout(which, keys, ms) {
    const el = which === 'enemy' ? $('enemyCallout') : $('ownCallout');
    const ship = keys.map((k) => t('ship.' + k).toUpperCase()).join(' + ');
    el.textContent = t('callout.down', { ship });
    el.classList.toggle('is-good', which === 'enemy');
    el.classList.remove('is-up');
    void el.offsetWidth;
    el.classList.add('is-up');
    setTimeout(() => el.classList.remove('is-up'), ms + 300);
}

/** The one authored moment: a charge lands and the room shakes. */
function theatre(which) {
    if (reduced()) return;
    const plot = plotEl(which);
    const lamp = document.querySelector('.lamp');
    plot.classList.remove('is-blasting');
    lamp.classList.remove('is-flare');
    void plot.offsetWidth;
    plot.classList.add('is-blasting');
    lamp.classList.add('is-flare');
    setTimeout(() => { plot.classList.remove('is-blasting'); lamp.classList.remove('is-flare'); }, 600);
}

// ------------------------------------------------------------------
//  Laying the fleet
// ------------------------------------------------------------------

let draft = [];             // the fleet being laid
let picking = FLEET[0].key;
let placeDir = 'h';

function renderPlace() {
    const plot = $('placePlot');
    const hull = new Set(draft.flatMap((s) => shipCells(s)));
    cellsOf(plot).forEach((b, i) => {
        b.className = 'cell' + (hull.has(i) ? ' is-hull' : '');
        b.setAttribute('aria-label', `${coordName(i)}, ${hull.has(i) ? 'your hull' : 'open water'}`);
    });

    const rail = $('hullRail');
    rail.replaceChildren();
    for (const { key, len } of FLEET) {
        const set = draft.some((s) => s.key === key);
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'hull-pick' + (picking === key ? ' is-on' : '') + (set ? ' is-set' : '');
        b.innerHTML = `${t('ship.' + key)}<span class="len">${set ? t('place.berthed') : '&times;' + len}</span>`;
        b.addEventListener('click', () => {
            if (set) draft = draft.filter((s) => s.key !== key);
            picking = key;
            renderPlace();
        });
        li.append(b);
        rail.append(li);
    }
    $('placeReady').disabled = placementError(draft) !== null;
}

function placeAt(at) {
    const key = picking;
    if (draft.some((s) => s.key === key)) {
        // Tapping a berthed hull lifts it, so a mistake costs one tap.
        const hit = draft.find((s) => shipCells(s).includes(at));
        if (hit) { draft = draft.filter((s) => s.key !== hit.key); picking = hit.key; renderPlace(); }
        return;
    }
    const candidate = { key, at, dir: placeDir };
    const next = [...draft.filter((s) => s.key !== key), candidate];
    // A partial fleet is legal on the way to a whole one, so check this hull
    // against the ones already down rather than against the fleet roster.
    const laid = new Set(draft.flatMap((s) => shipCells(s)));
    const cells = shipCells(candidate);
    const offPlot = placeDir === 'h'
        ? (at % SIZE) + cells.length > SIZE
        : Math.floor(at / SIZE) + cells.length > SIZE;
    if (offPlot) { toast(t('refuse.offPlot')); return; }
    if (cells.some((c) => laid.has(c))) { toast(t('refuse.overlap')); return; }
    draft = next;
    const left = FLEET.find((s) => !draft.some((d) => d.key === s.key));
    picking = left ? left.key : key;
    renderPlace();
}

function autoLay() {
    draft = autoPlace();
    picking = FLEET[0].key;
    renderPlace();
}

async function submitFleet() {
    if (placementError(draft) !== null) return;
    if (mode === 'solo') {
        startSolo(draft);
        return;
    }
    $('placeReady').disabled = true;
    show('placeWait', true);
    const res = await post('place', { code: session.code, token: session.token, fleet: draft });
    if (!res.ok) {
        show('placeWait', false);
        $('placeReady').disabled = false;
        toast(refusal(res));
        return;
    }
    schedulePoll(0);
}

const refusal = (res) => (res.body?.reason ? t(`refuse.${res.body.reason}`) : t('refuse.network'));

// ------------------------------------------------------------------
//  Taking a turn, room mode
// ------------------------------------------------------------------

function queue(action) {
    outbox.push(action);
    // Optimistically stand the rail down, so a second order cannot spend
    // twice while the poll is still in flight, and remember how far along
    // the room must be before a poll is believed again.
    if (snapshot) {
        expectTurns = (snapshot.room.turns ?? 0) + 1;
        staleSkips = 0;
        snapshot = { ...snapshot, room: { ...snapshot.room, turn: other(seat) } };
        renderBattle();
    }
    pump();
}

async function pump() {
    if (pumping || outbox.length === 0 || !session) return;
    pumping = true;
    while (outbox.length && session) {
        const action = outbox[0];
        const res = await post('act', { code: session.code, token: session.token, ...action });
        if (res.ok) {
            outbox.shift();
            failures = 0;
            // Learn the consequence through the poll, the same path the other
            // seat takes. That one line removes a class of divergence bugs.
            schedulePoll(0);
        } else if (res.status === 0 || res.status >= 500) {
            failures++;
            await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** failures)));
        } else {
            outbox.shift();
            expectTurns = null;
            clearFired();
            toast(refusal(res));
            schedulePoll(0);
        }
    }
    pumping = false;
}

// ------------------------------------------------------------------
//  The poll loop
// ------------------------------------------------------------------

function schedulePoll(delay) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollOnce, delay);
}

async function pollOnce() {
    if (!session || mode !== 'room') return;
    if (pollBusy) {
        // Asked for while one is in flight: go again the moment it lands,
        // rather than waiting out the delay the in-flight one will pick.
        pollWanted = true;
        return;
    }
    pollBusy = true;
    pollWanted = false;
    const replay = model.lastSeq === 0;
    const res = await post('poll', { code: session.code, token: session.token, since: model.lastSeq });
    pollBusy = false;
    if (!session) return;

    let more = false;
    if (res.ok && res.body) {
        failures = 0;
        more = handlePoll(res.body, replay);
    } else if (res.status === 404) {
        leaveLocal(t('toast.roomClosed'));
        return;
    } else if (res.status === 401) {
        leaveLocal(t('toast.seatTaken'));
        return;
    } else {
        failures++;
    }

    const v = snapshot;
    schedulePoll(more || pollWanted ? 30 : pollDelay({
        status: v?.room?.status,
        hidden: document.hidden,
        failures,
        waiting: v?.room?.status === 'battle' && v.room.turn !== seat,
    }));
}

function handlePoll(body, replay) {
    let room = body.room;
    if (isStaleRoom(room, expectTurns)) {
        // The answer left the server before our move arrived. Its plots are
        // consistent with its events, so keep both, but do not let it hand
        // the turn back: that is the flicker that invites a second tap.
        if (++staleSkips > 6) expectTurns = null;
        else room = { ...room, turn: other(seat), turns: expectTurns };
    } else {
        expectTurns = null;
        staleSkips = 0;
    }
    snapshot = { room, you: body.you, enemy: body.enemy };
    seat = body.you?.seat ?? seat;
    const ops = applyEvents(model, body.events, body.you?.id ?? null);

    const staged = [];
    for (const op of ops) {
        switch (op.op) {
            case 'shot':
            case 'swept':
            case 'moved':
                // A replay from the start of the log is the record of a
                // match already at sea, read in rather than re-enacted.
                if (replay) readIn(op);
                else staged.push(op);
                break;
            case 'abandon':
                toast(t('toast.abandoned'));
                break;
            case 'again':
                logLines = [];
                mySweeps = 0;
                intelStaleFrom = 0;
                break;
        }
    }
    // Queued BEFORE the screen syncs: the paint holds back every cell a
    // queued report is still going to land on, and a report that arrives
    // while the page is elsewhere is read into the log instead of played.
    enqueue(staged);
    syncScreen();
    return body.more === true;
}

/** The snapshot is the truth; the screen follows it, never the other way. */
function syncScreen() {
    const v = snapshot;
    if (!v || mode !== 'room') return;
    $('roomTagCode').textContent = session?.code ?? '----';
    switch (v.room.status) {
        case 'lobby':
            $('lobbyCode').textContent = session?.code ?? '----';
            if (screen !== 'lobbyScreen') replaceTo('lobbyScreen');
            break;
        case 'place':
            // A rematch waits for the last shell to land.
            if (stage.running) break;
            if (screen !== 'placeScreen') {
                draft = [];
                picking = FLEET[0].key;
                show('placeWait', false);
                renderPlace();
                replaceTo('placeScreen');
            }
            show('placeWait', (v.you?.fleet ?? []).length === FLEET.length);
            $('placeReady').disabled = (v.you?.fleet ?? []).length === FLEET.length
                || placementError(draft) !== null;
            break;
        case 'battle':
            if (screen !== 'battleScreen') { resetBoards(); replaceTo('battleScreen'); }
            renderBattle();
            break;
        case 'over':
            // So does the verdict.
            if (stage.running) break;
            renderVerdict(v);
            if (screen !== 'overScreen') replaceTo('overScreen');
            break;
    }
}

function renderVerdict(v) {
    const won = v.room.outcome === (mySeat() === 1 ? 'p1' : 'p2');
    const stamp = $('verdictStamp');
    stamp.textContent = won ? t('over.won') : t('over.lost');
    stamp.classList.toggle('is-win', won);
    $('verdictTitle').textContent = won ? t('over.wonTitle') : t('over.lostTitle');
    $('verdictLine').textContent = won
        ? t('over.wonLine', { who: v.enemy.name ?? '' })
        : t('over.lostLine', { who: v.enemy.name ?? '' });

    const tally = $('verdictTally');
    tally.replaceChildren();
    const hitRate = v.you.shots ? Math.round((v.you.hits / v.you.shots) * 100) : 0;
    const rows = [
        [t('tally.turns'), v.room.turns],
        [t('tally.shots'), v.you.shots],
        [t('tally.hits'), `${v.you.hits} (${hitRate}%)`],
        [t('tally.spent'), v.you.spent],
        [t('tally.series'), v.you.wins ?? 0],
    ];
    for (const [k, val] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = String(val);
        tally.append(dt, dd);
    }
    show('againWait', v.you.wantsAgain === true);
    $('againBtn').disabled = v.you.wantsAgain === true;
}

// ------------------------------------------------------------------
//  Solo
//
//  Entirely in this tab: the bot never touches the controller, which is why
//  a solo result posted to ?action=record is self reported and the card
//  labels those games practice. Both seats' reports go through the same
//  stage as a room game's, so the two modes feel the same.
// ------------------------------------------------------------------

function soloView() {
    const me = solo.seat;
    const mine = ownView(solo.match, me);
    const theirs = enemyView(solo.match, me);
    return {
        room: {
            status: solo.match.status === 'over' ? 'over' : 'battle',
            turn: solo.match.turn,
            starter: solo.match.starter,
            turns: solo.match.turns,
            outcome: solo.match.outcome,
        },
        you: { ...mine, name: solo.name, wins: 0, wantsAgain: false, seat: me },
        enemy: { ...theirs, name: t(`level.${solo.level}`), seat: other(me) },
    };
}

/** A local report in the shape the event log would have given it. */
function opFromReport(actor, report) {
    switch (report.kind) {
        case 'sonar': return { op: 'swept', seat: actor, at: report.swept, count: report.intel?.count ?? null };
        case 'reposition': return { op: 'moved', seat: actor };
        case 'decoy': return { op: 'decoy', seat: actor };
        default: return { op: 'shot', seat: actor, kind: report.kind, cells: report.cells, sunk: report.sunk };
    }
}

function startSolo(fleet) {
    const me = 1;
    solo = {
        seat: me,
        level: solo?.level ?? 'admiral',
        name: solo?.name ?? t('log.you'),
        match: newMatch({ fleets: [fleet, autoPlace()], starter: Math.random() < 0.5 ? 1 : 2 }),
    };
    logLines = [];
    resetBoards();
    replaceTo('battleScreen');
    renderBattle();
    if (solo.match.turn !== me) setTimeout(botTurn, tempo(reduced()).think);
}

function soloAct(action) {
    const me = solo.seat;
    const { match, report } = applyAction(solo.match, me, action);
    solo.match = match;
    enqueue([opFromReport(me, report)]);
}

function afterSoloStage() {
    if (!solo) return;
    if (solo.match.outcome) { finishSolo(); return; }
    if (solo.match.turn !== solo.seat) setTimeout(botTurn, tempo(reduced()).think);
}

function botTurn() {
    if (!solo || solo.match.outcome || solo.match.turn === solo.seat || stage.running) return;
    const foe = other(solo.seat);
    const action = chooseAction({
        enemy: enemyView(solo.match, foe),
        own: ownView(solo.match, foe),
        policy: LEVELS[solo.level],
    });
    let report;
    if (actionError(solo.match, foe, action) !== null) {
        const open = solo.match.sides[solo.seat].grid.indexOf('.');
        if (open < 0) return;
        ({ match: solo.match, report } = applyAction(solo.match, foe, { kind: 'fire', at: open }));
    } else {
        ({ match: solo.match, report } = applyAction(solo.match, foe, action));
    }
    enqueue([opFromReport(foe, report)]);
}

async function finishSolo() {
    const v = soloView();
    const won = v.room.outcome === (solo.seat === 1 ? 'p1' : 'p2');
    seat = solo.seat;
    snapshot = v;
    renderVerdict(v);
    show('againWait', false);
    $('againBtn').disabled = false;
    replaceTo('overScreen');
    // Self reported, and labelled practice on the card for exactly that reason.
    await post('record', {
        mode: 'bot',
        result: won ? 'win' : 'loss',
        opponent: t(`level.${solo.level}`),
        turns: v.room.turns,
        shots: v.you.shots,
        hits: v.you.hits,
        salvageSpent: v.you.spent,
    });
}

// ------------------------------------------------------------------
//  Joining, leaving and the record card
// ------------------------------------------------------------------

function openGate(joining) {
    $('gateTitle').textContent = t(joining ? 'gate.join' : 'gate.open');
    show('gateCodeField', joining);
    show('gateError', false);
    $('gateName').value = localStorage.getItem(NAME_KEY) ?? '';
    showScreen('gateScreen');
    setTimeout(() => (joining && !$('gateCode').value ? $('gateCode') : $('gateName')).focus(), 60);
}

async function gateGo() {
    const name = cleanName($('gateName').value);
    if (!isValidName(name)) { gateFail(t('refuse.badName')); return; }
    localStorage.setItem(NAME_KEY, name);
    const joining = !$('gateCodeField').hidden;
    $('gateGo').disabled = true;

    let res;
    if (joining) {
        const code = normalizeCode($('gateCode').value);
        if (!isValidCode(code)) { $('gateGo').disabled = false; gateFail(t('refuse.badCode')); return; }
        res = await post('join', { code, name });
        if (res.status === 409 && res.body?.reclaim) {
            $('gateGo').disabled = false;
            offerSeats(code);
            return;
        }
    } else {
        res = await post('create', { name, lang });
    }
    $('gateGo').disabled = false;
    if (!res.ok) { gateFail(refusal(res)); return; }

    mode = 'room';
    session = { code: res.body.code, token: res.body.token, name };
    seat = res.body.you.seat;
    model = createRoomModel();
    logLines = [];
    saveSession();
    history.replaceState(history.state, '', `?room=${session.code}`);
    schedulePoll(0);
}

function gateFail(message) {
    const el = $('gateError');
    el.textContent = message;
    show('gateError', true);
}

async function offerSeats(code) {
    const res = await post('seats', { code });
    if (!res.ok) { gateFail(refusal(res)); return; }
    const list = $('seatList');
    list.replaceChildren();
    for (const s of res.body.seats) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn';
        b.disabled = !s.claimable;
        b.textContent = s.claimable ? t('seats.take', { who: s.name }) : t('seats.busy', { who: s.name });
        b.addEventListener('click', () => reclaim(code, s.seat));
        li.append(b);
        list.append(li);
    }
    showScreen('seatsScreen');
}

async function reclaim(code, seatNo) {
    const res = await post('reclaim', { code, seat: seatNo });
    if (!res.ok) { toast(refusal(res)); return; }
    mode = 'room';
    session = { code, token: res.body.token, name: localStorage.getItem(NAME_KEY) ?? '' };
    seat = res.body.you.seat;
    model = createRoomModel();
    logLines = [];
    saveSession();
    schedulePoll(0);
}

function leaveLocal(message) {
    clearTimeout(pollTimer);
    session = null;
    snapshot = null;
    solo = null;
    mode = null;
    seat = 0;
    outbox.length = 0;
    stage.queue.length = 0;
    expectTurns = null;
    saveSession();
    history.replaceState(history.state, '', location.pathname);
    showScreen('bootScreen');
    loadRecord();
    if (message) toast(message);
}

async function leaveRoom() {
    if (session) await post('leave', { code: session.code, token: session.token });
    leaveLocal(null);
}

async function loadRecord() {
    const res = await post('record', {});
    if (!res.ok || !res.body) return;
    const signedIn = res.body.viewer !== null;
    show('recordCard', signedIn && res.body.records.length > 0);
    show('recordSignin', !signedIn);
    if (!signedIn) {
        $('recordSigninLink').href = `../account/?redirect=${encodeURIComponent(location.pathname)}`;
        return;
    }
    const rows = res.body.records;
    const wins = rows.filter((r) => r.result === 'win').length;
    $('recordTally').innerHTML =
        `<span><b>${wins}</b> ${t('record.won')}</span><span><b>${rows.length - wins}</b> ${t('record.lost')}</span>`;
    const list = $('recordList');
    list.replaceChildren();
    for (const r of rows) {
        const li = document.createElement('li');
        const rate = r.shots ? Math.round((r.hits / r.shots) * 100) : 0;
        li.innerHTML = `<span class="res-${r.result}">${t('record.' + r.result)}</span>`
            + `<span class="who">${escapeHtml(r.opponent)}${r.mode === 'bot' ? ' &middot; ' + t('record.practice') : ''}</span>`
            + `<span>${rate}%</span>`;
        list.append(li);
    }
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------------
//  How it works
// ------------------------------------------------------------------

function renderRules() {
    const tools = TOOLS.filter((k) => k !== 'fire').map((k) => {
        const rung = UNLOCK[k] === 0 ? t('rules.open') : t('rules.rung', { n: UNLOCK[k] });
        return `<p><b>${t('tool.' + k)}</b> <span class="cost">${COST[k]} &middot; ${rung}</span><br>${t('rules.' + k)}</p>`;
    }).join('');
    $('rulesProse').innerHTML = `
        <p>${t('rules.intro')}</p>
        <h3>${t('rules.turnHead')}</h3>
        <p>${t('rules.turn')}</p>
        <h3>${t('rules.salvageHead')}</h3>
        <p>${t('rules.salvage')}</p>
        <h3>${t('rules.ladderHead')}</h3>
        <p>${t('rules.ladder')}</p>
        <h3>${t('rules.toolsHead')}</h3>
        ${tools}`;
}

// ------------------------------------------------------------------
//  Boot
// ------------------------------------------------------------------

async function init() {
    await loadStrings();
    buildRail();
    renderRules();
    buildPlot($('enemyPlot'), pickCell, peek);
    buildPlot($('ownPlot'), pickCell, peek);
    buildPlot($('placePlot'), placeAt, null);
    nodes.enemy = cellsOf($('enemyPlot'));
    nodes.own = cellsOf($('ownPlot'));
    buildLamps($('ownLamps'));
    buildLamps($('enemyLamps'));

    $('doorRoom').addEventListener('click', () => go('open'));
    $('doorJoin').addEventListener('click', () => go('join'));
    $('doorRules').addEventListener('click', () => go('rules'));
    $('doorSolo').addEventListener('click', () => {
        mode = 'solo';
        solo = { level: 'admiral', name: localStorage.getItem(NAME_KEY) || t('log.you') };
        draft = [];
        picking = FLEET[0].key;
        show('placeWait', false);
        renderPlace();
        replaceTo('placeScreen');
    });
    $('rulesBack').addEventListener('click', () => history.back());
    $('gateBack').addEventListener('click', () => history.back());
    $('seatsBack').addEventListener('click', () => showScreen('bootScreen'));
    $('gateGo').addEventListener('click', gateGo);
    for (const id of ['gateName', 'gateCode']) {
        $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') gateGo(); });
    }
    $('gateCode').addEventListener('input', (e) => { e.target.value = normalizeCode(e.target.value); });

    $('lobbyLeave').addEventListener('click', leaveRoom);
    $('overLeave').addEventListener('click', () => (mode === 'solo' ? leaveLocal(null) : leaveRoom()));
    $('lobbyShare').addEventListener('click', async () => {
        const url = `${location.origin}${location.pathname}?room=${session?.code ?? ''}`;
        try { await navigator.clipboard.writeText(url); toast(t('toast.copied')); }
        catch { toast(url); }
    });

    $('placeRotate').addEventListener('click', () => { placeDir = placeDir === 'h' ? 'v' : 'h'; renderPlace(); });
    $('placeAuto').addEventListener('click', autoLay);
    $('placeReady').addEventListener('click', submitFleet);

    $('switchEnemy').addEventListener('click', () => { userSide = 'enemy'; showSide('enemy'); });
    $('switchOwn').addEventListener('click', () => { userSide = 'own'; showSide('own'); });
    $('cmdGo').addEventListener('click', commit);
    $('cmdTurn').addEventListener('click', swing);
    $('againBtn').addEventListener('click', async () => {
        if (mode === 'solo') {
            draft = [];
            picking = FLEET[0].key;
            renderPlace();
            replaceTo('placeScreen');
            return;
        }
        $('againBtn').disabled = true;
        await post('again', { code: session.code, token: session.token });
        schedulePoll(0);
    });

    // The keyboard. Numbers pick a tool, R swings a barrage or a hull, and
    // the plot is a real grid of buttons, so arrows, Tab and Enter already
    // work: Enter aims, Enter again on the same cell gives the order.
    document.addEventListener('keydown', (e) => {
        if (e.target.matches('input')) return;
        if (screen === 'battleScreen') {
            const n = Number(e.key);
            if (n >= 1 && n <= TOOLS.length) { pickTool(TOOLS[n - 1]); e.preventDefault(); }
            if (e.key.toLowerCase() === 'r') swing();
        } else if (screen === 'placeScreen' && e.key.toLowerCase() === 'r') {
            placeDir = placeDir === 'h' ? 'v' : 'h';
            renderPlace();
        }
    });

    // On a wide screen both plots are on the table and the dimmed one is
    // still readable; on a phone the hidden one has to come back.
    window.addEventListener('resize', () => { if (screen === 'battleScreen' && !stage.running) settleSide(); });

    $('back-link').addEventListener('click', (e) => {
        // The game screens carry no history entry of their own, so the href
        // would take a player mid match clean off the site. Leaving a room is
        // what EXIT means here; back-link.js still handles the title screen.
        if (!mode) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (mode === 'room') leaveRoom();
        else leaveLocal(null);
    }, true);

    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedulePoll(0); });
    window.addEventListener('hashchange', route);

    await arrive();
}

async function arrive() {
    const deep = new URLSearchParams(location.search).get('room');
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');

    if (saved && (!deep || normalizeCode(deep) === saved.code)) {
        // Replay the whole room from the beginning, so a phone that was asleep
        // catches every counter it missed rather than waking up mid plot.
        mode = 'room';
        session = saved;
        model = createRoomModel();
        schedulePoll(0);
        return;
    }
    if (deep && isValidCode(normalizeCode(deep))) {
        $('gateCode').value = normalizeCode(deep);
        go('join');
        return;
    }
    route();
    loadRecord();
}

document.addEventListener('DOMContentLoaded', init);
