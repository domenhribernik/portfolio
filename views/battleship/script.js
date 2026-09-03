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

const API = '../../app/controllers/battleship-controller.php';
const SESSION_KEY = 'battleship:session';
const NAME_KEY = 'battleship:name';
const LANG_KEY = 'battleship:lang';

const $ = (id) => document.getElementById(id);
const show = (el, on) => { (typeof el === 'string' ? $(el) : el).hidden = !on; };

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
let logLines = [];

// The outbox: writes leave in order, and the result is learned by polling.
const outbox = [];
let pumping = false;
let pollTimer = null;
let pollBusy = false;
let failures = 0;

function saveSession() {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
}

// ------------------------------------------------------------------
//  The plot
// ------------------------------------------------------------------

const LETTERS = 'ABCDEFGHIJ';

/** Build a 10x10 of buttons with a lettered and numbered ruler around it. */
function buildPlot(el, onPick, onHover) {
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
            b.addEventListener('click', () => onPick(i));
            if (onHover) {
                b.addEventListener('pointerenter', () => onHover(i));
                b.addEventListener('focus', () => onHover(i));
            }
            el.append(b);
        }
    }
    if (onHover) el.addEventListener('pointerleave', () => onHover(null));
}

const cellsOf = (el) => el.querySelectorAll('.cell');

const MARK_CLASS = {
    o: 'mark-miss', x: 'mark-hit', s: 'mark-sunk', d: 'mark-decoy',
};

const MARK_WORD = {
    '.': 'unfired', o: 'miss', x: 'hit', s: 'sunk', d: 'decoy',
};

/** Paint the enemy plot from the shot record the poll handed over. */
function paintEnemy(grid) {
    const nodes = cellsOf($('enemyPlot'));
    for (let i = 0; i < CELLS; i++) {
        const b = nodes[i];
        const mark = grid[i];
        b.className = 'cell' + (MARK_CLASS[mark] ? ' ' + MARK_CLASS[mark] : '');
        b.disabled = mark !== '.';
        b.setAttribute('aria-label', `${coordName(i)}, ${MARK_WORD[mark] ?? 'unfired'}`);
    }
}

/**
 * Paint your own plot: hulls, buoys, damage, and the blocks they swept.
 * `live` is true only while a tool that aims at your OWN water is selected;
 * the rest of the time these cells are a status board, not a control.
 */
function paintOwn(el, you, live = false) {
    const nodes = cellsOf(el);
    const hull = new Set((you.fleet ?? []).flatMap((s) => shipCells(s)));
    const buoys = new Set(you.decoys ?? []);
    const lit = new Set((you.swept ?? []).flatMap((at) => blockCells(at)));
    for (let i = 0; i < CELLS; i++) {
        const b = nodes[i];
        const mark = you.grid[i];
        const bits = ['cell'];
        if (hull.has(i)) bits.push('is-hull');
        if (buoys.has(i)) bits.push('is-buoy');
        if (lit.has(i)) bits.push('is-lit');
        if (MARK_CLASS[mark]) bits.push(MARK_CLASS[mark]);
        if (mark === 'D') bits.push('mark-hit');
        b.className = bits.join(' ');
        b.disabled = !live;
        const what = hull.has(i) ? 'your hull' : buoys.has(i) ? 'your buoy' : 'open water';
        b.setAttribute('aria-label', `${coordName(i)}, ${what}, ${MARK_WORD[mark] ?? 'unfired'}`);
    }
}

function paintLamps(el, count, cap = SALVAGE_CAP) {
    el.replaceChildren();
    for (let i = 0; i < cap; i++) {
        const pip = document.createElement('span');
        pip.className = 'lamp-pip' + (i < count ? ' is-lit' : '');
        el.append(pip);
    }
}

// ------------------------------------------------------------------
//  The tool rail
// ------------------------------------------------------------------

const TOOLS = ['fire', 'sonar', 'decoy', 'barrage', 'reposition', 'depthCharge'];

/** Where a tool is aimed: the enemy plot, or your own. */
const AIMS_AT_SELF = new Set(['decoy', 'reposition']);

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
    if (!v || !isMyTurn(v)) return;
    tool = kind;
    pendingDir = 'h';
    // Repositioning needs a hull chosen before a berth. Start on the biggest
    // one that can still run, so the tool is usable in one tap.
    if (kind === 'reposition') {
        const free = (v.you.fleet ?? []).filter((sh) => shipCells(sh).every((c) => v.you.grid[c] === '.'));
        if (!free.some((sh) => sh.key === movingKey)) {
            movingKey = free.sort((a, b) => shipCells(b).length - shipCells(a).length)[0]?.key ?? null;
        }
    }
    renderBattle();
    renderAim(null);
    if (window.innerWidth < 992) showSide(AIMS_AT_SELF.has(kind) ? 'own' : 'enemy');
}

function renderRail(v) {
    const mine = v.you;
    const wrecks = (mine.sunk ?? []).length;
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
        b.disabled = !isMyTurn(v) || locked || broke;
    }
}

/** The footprint the selected tool would touch, previewed under the cursor. */
function footprint(at, v) {
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
        case 'reposition': {
            const hull = movingKey;
            return hull ? shipCells({ key: hull, at, dir: pendingDir }) : [];
        }
        default:
            return [];
    }
}

let movingKey = null;

function renderAim(at) {
    const v = currentView();
    for (const el of [$('enemyPlot'), $('ownPlot')]) {
        for (const c of cellsOf(el)) c.classList.remove('is-aimed', 'is-bad');
    }
    if (at === null || !v || !isMyTurn(v)) return;
    const el = AIMS_AT_SELF.has(tool) ? $('ownPlot') : $('enemyPlot');
    const cells = footprint(at, v);
    const bad = cells.length === 0 || actionError(asMatch(v), mySeat(), actionFor(at, v)) !== null;
    const nodes = cellsOf(el);
    for (const c of cells) nodes[c]?.classList.add(bad ? 'is-bad' : 'is-aimed');
}

function actionFor(at, v) {
    switch (tool) {
        case 'barrage': return { kind: 'barrage', at, dir: pendingDir };
        case 'reposition': return { kind: 'reposition', ship: movingKey, at, dir: pendingDir };
        default: return { kind: tool, at };
    }
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

function renderBattle() {
    const v = currentView();
    if (!v) return;
    paintEnemy(v.enemy.grid);
    paintOwn($('ownPlot'), v.you, isMyTurn(v) && AIMS_AT_SELF.has(tool));
    paintLamps($('ownLamps'), v.you.salvage);
    paintLamps($('enemyLamps'), v.enemy.salvage);
    $('ownCount').textContent = String(v.you.salvage);
    $('enemyCount').textContent = String(v.enemy.salvage);
    $('ownName').textContent = v.you.name ?? '';
    $('enemyName').textContent = v.enemy.name ?? '';

    const bar = document.querySelector('.turn-bar');
    const mine = isMyTurn(v);
    bar.classList.toggle('is-yours', mine);
    bar.classList.toggle('is-theirs', !mine);
    $('turnText').textContent = mine ? t('battle.yourTurn') : t('battle.theirTurn', { who: v.enemy.name ?? '' });

    renderRail(v);
    renderFleetStatus(v, tool === 'reposition');
    $('railHint').textContent = mine ? t(`hint.${tool}`) : '';
    renderLog();
}

function renderFleetStatus(v, pickable) {
    const list = $('fleetStatus');
    list.replaceChildren();
    const grid = v.you.grid;
    for (const { key, len } of FLEET) {
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
            b.addEventListener('click', () => { movingKey = key; renderFleetStatus(v, true); });
            li.append(b);
        }
        list.append(li);
    }
}

function renderLog() {
    const el = $('log');
    el.replaceChildren();
    for (const line of logLines.slice(-40)) {
        const li = document.createElement('li');
        li.className = line.mine ? 'is-mine' : '';
        li.innerHTML = line.html;
        el.append(li);
    }
    el.scrollTop = el.scrollHeight;
}

function note(html, mine) {
    logLines.push({ html, mine });
    if (screen === 'battleScreen') renderLog();
}

function showSide(which) {
    $('enemySide').classList.toggle('is-off', which !== 'enemy');
    $('ownSide').classList.toggle('is-off', which !== 'own');
    $('switchEnemy').classList.toggle('is-on', which === 'enemy');
    $('switchOwn').classList.toggle('is-on', which === 'own');
    $('switchEnemy').setAttribute('aria-selected', String(which === 'enemy'));
    $('switchOwn').setAttribute('aria-selected', String(which === 'own'));
}

// ------------------------------------------------------------------
//  Animating what a report says
// ------------------------------------------------------------------

const WORD = { hit: 'res.hit', sunk: 'res.sunk', miss: 'res.miss', decoy: 'res.hit', blast: 'res.blast' };

function announce(seatOfActor, kind, cells, sunk) {
    const mine = seatOfActor === mySeat();
    const who = mine ? t('log.you') : t('log.them');
    if (kind === 'sonar') {
        note(`<b>${who}</b> ${t('log.swept')}`, mine);
    } else if (kind === 'decoy') {
        note(`<b>${who}</b> ${t('log.buoy')}`, mine);
    } else if (kind === 'reposition') {
        note(`<b>${who}</b> ${t('log.moved')}`, mine);
    } else if (cells.length) {
        const hits = cells.filter((c) => c.result === 'hit' || c.result === 'sunk' || c.result === 'decoy').length;
        const where = cells.map((c) => coordName(c.cell)).join(' ');
        note(`<b>${who}</b> ${t(`log.${kind}`)} ${where} &middot; ${t('log.hits', { n: hits })}`, mine);
    }
    for (const key of sunk) {
        note(`<b>${t('ship.' + key).toUpperCase()}</b> ${t('log.down')}`, !mine);
    }
    if (cells.length === 1) cry(`${coordName(cells[0].cell)}, ${t(WORD[cells[0].result] ?? 'res.miss')}`);
    else if (cells.length) cry(t('log.hits', { n: cells.filter((c) => c.result !== 'miss' && c.result !== 'blast').length }));
}

/** The one authored moment: a charge lands and the room shakes. */
function theatre(kind, which) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (kind !== 'depthCharge') return;
    const plot = which === 'enemy' ? $('enemyPlot') : $('ownPlot');
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
    const you = { fleet: draft, grid: '.'.repeat(CELLS), decoys: [], swept: [] };
    paintOwn($('placePlot'), you);

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
//  Taking a turn
// ------------------------------------------------------------------

function aimAt(at) {
    const v = currentView();
    if (!v || !isMyTurn(v)) return;
    const action = actionFor(at, v);
    const err = actionError(asMatch(v), mySeat(), action);
    if (err !== null) { toast(t(`refuse.${err}`)); return; }
    if (mode === 'solo') { soloAct(action); return; }
    queue(action);
}

function queue(action) {
    outbox.push(action);
    // Optimistically stand the rail down, so a double tap cannot spend twice
    // while the poll is still in flight.
    if (snapshot) { snapshot = { ...snapshot, room: { ...snapshot.room, turn: other(seat) } }; renderBattle(); }
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
    if (!session || pollBusy || mode !== 'room') return;
    pollBusy = true;
    const res = await post('poll', { code: session.code, token: session.token, since: model.lastSeq });
    pollBusy = false;
    if (!session) return;

    let more = false;
    if (res.ok && res.body) {
        failures = 0;
        more = handlePoll(res.body);
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
    schedulePoll(more ? 30 : pollDelay({
        status: v?.room?.status,
        hidden: document.hidden,
        failures,
        waiting: v?.room?.status === 'battle' && v.room.turn !== seat,
    }));
}

function handlePoll(body) {
    snapshot = { room: body.room, you: body.you, enemy: body.enemy };
    seat = body.you?.seat ?? seat;
    const ops = applyEvents(model, body.events, body.you?.id ?? null);

    for (const op of ops) {
        switch (op.op) {
            case 'shot':
                announce(op.seat, op.kind, op.cells, op.sunk);
                theatre(op.kind, op.seat === seat ? 'enemy' : 'own');
                break;
            case 'swept':
                if (op.seat !== seat) note(`<b>${t('log.them')}</b> ${t('log.sweptYou', { at: coordName(op.at) })}`, false);
                break;
            case 'moved':
                if (op.seat !== seat) note(`<b>${t('log.them')}</b> ${t('log.moved')}`, false);
                break;
            case 'abandon':
                toast(t('toast.abandoned'));
                break;
            case 'again':
                logLines = [];
                break;
        }
    }

    syncScreen();
    return body.more === true;
}

/** The snapshot is the truth; the screen follows it, never the other way. */
function syncScreen() {
    const v = snapshot;
    if (!v) return;
    $('roomTagCode').textContent = session?.code ?? '----';
    switch (v.room.status) {
        case 'lobby':
            $('lobbyCode').textContent = session?.code ?? '----';
            if (screen !== 'lobbyScreen') replaceTo('lobbyScreen');
            break;
        case 'place':
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
            if (screen !== 'battleScreen') { replaceTo('battleScreen'); showSide('enemy'); }
            renderBattle();
            break;
        case 'over':
            renderVerdict(v);
            if (screen !== 'overScreen') replaceTo('overScreen');
            break;
    }
}

function renderVerdict(v) {
    const won = v.room.outcome === (seat === 1 ? 'p1' : 'p2');
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
//  labels those games practice.
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

function startSolo(fleet) {
    const me = 1;
    solo = {
        seat: me,
        level: solo?.level ?? 'admiral',
        name: solo?.name ?? t('log.you'),
        match: newMatch({ fleets: [fleet, autoPlace()], starter: Math.random() < 0.5 ? 1 : 2 }),
    };
    logLines = [];
    tool = 'fire';
    replaceTo('battleScreen');
    showSide('enemy');
    renderBattle();
    if (solo.match.turn !== me) setTimeout(botTurn, 700);
}

function soloAct(action) {
    const me = solo.seat;
    const { match, report } = applyAction(solo.match, me, action);
    solo.match = match;
    announce(me, report.kind, report.cells, report.sunk);
    theatre(report.kind, 'enemy');
    if (match.outcome) { finishSolo(); return; }
    renderBattle();
    setTimeout(botTurn, 620);
}

function botTurn() {
    if (!solo || solo.match.outcome || solo.match.turn === solo.seat) return;
    const foe = other(solo.seat);
    const action = chooseAction({
        enemy: enemyView(solo.match, foe),
        own: ownView(solo.match, foe),
        policy: LEVELS[solo.level],
    });
    if (actionError(solo.match, foe, action) !== null) {
        const open = solo.match.sides[solo.seat].grid.indexOf('.');
        if (open < 0) return;
        ({ match: solo.match } = applyAction(solo.match, foe, { kind: 'fire', at: open }));
    } else {
        const { match, report } = applyAction(solo.match, foe, action);
        solo.match = match;
        announce(foe, report.kind, report.cells, report.sunk);
        theatre(report.kind, 'own');
    }
    if (solo.match.outcome) { finishSolo(); return; }
    renderBattle();
    if (solo.match.turn !== solo.seat) setTimeout(botTurn, 620);
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
    buildPlot($('enemyPlot'), aimAt, renderAim);
    buildPlot($('ownPlot'), aimAt, renderAim);
    buildPlot($('placePlot'), placeAt, null);

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

    $('switchEnemy').addEventListener('click', () => showSide('enemy'));
    $('switchOwn').addEventListener('click', () => showSide('own'));
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

    // The keyboard. Numbers pick a tool, R turns a barrage or a hull, and the
    // plot is a real grid of buttons, so arrows and Enter already work.
    document.addEventListener('keydown', (e) => {
        if (e.target.matches('input')) return;
        if (screen === 'battleScreen') {
            const n = Number(e.key);
            if (n >= 1 && n <= TOOLS.length) { pickTool(TOOLS[n - 1]); e.preventDefault(); }
            if (e.key.toLowerCase() === 'r') { pendingDir = pendingDir === 'h' ? 'v' : 'h'; toast(t('toast.turned')); }
        } else if (screen === 'placeScreen' && e.key.toLowerCase() === 'r') {
            placeDir = placeDir === 'h' ? 'v' : 'h';
            renderPlace();
        }
    });

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
