// The Drawing Room page controller: screens, the poll loop, the outbox that
// keeps stroke chunks ordered, and the canvas renderer. Everything that can
// be decided without a DOM lives in logic.js and is tested by node --test.
import {
    INKS, PAPER, inkColor,
    normalizeCode, isValidCode, cleanName, isValidName, initials,
    SHEET_W, SHEET_H, packChunk,
    createModel, addLocalChunk, applyEvents,
    pollDelay,
} from './logic.js';

const API = '../../app/controllers/parlour-controller.php';
const SESSION_KEY = 'parlour-session';
const NAME_KEY = 'parlour-name';
const NIB_SIZES = [4, 9, 18];
const FLUSH_MS = 200;

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------
//  State
// ------------------------------------------------------------------

let session = null;            // {code, token, you:{id,host,ink}, name}
let model = createModel();
let guests = [];
let selectedInk = 0;
let selectedSize = NIB_SIZES[1];
let strokeCounter = 1;
let failures = 0;
let lastActivityAt = 0;        // last time ink moved, ours or anyone's
const lastInkAt = new Map();   // guestId -> ms, for the "drawing" pulse
let pollTimer = null;
let pollBusy = false;
const outbox = [];
let sending = false;

// ------------------------------------------------------------------
//  API
// ------------------------------------------------------------------

async function post(action, payload) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
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
        clearTimeout(t);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------
//  Screens
// ------------------------------------------------------------------

function showScreen(name) {
    for (const s of ['gate', 'lobby', 'table']) {
        $(`screen-${s}`).classList.toggle('on', s === name);
    }
    if (name === 'table') {
        requestAnimationFrame(resizeSheet);
    }
}

function toast(msg, ms = 2600) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

// ------------------------------------------------------------------
//  The gate
// ------------------------------------------------------------------

function gateError(msg) {
    const el = $('gateError');
    el.textContent = msg ?? '';
    el.classList.toggle('hidden', !msg);
}

async function submitGate(kind) {
    const btn = kind === 'create' ? $('createBtn') : $('joinBtn');
    const name = cleanName((kind === 'create' ? $('hostName') : $('joinName')).value);
    if (!isValidName(name)) {
        gateError('A name, if you please: one to twenty characters.');
        return;
    }
    const payload = { name };
    if (kind === 'join') {
        payload.code = normalizeCode($('joinCode').value);
        if (!isValidCode(payload.code)) {
            gateError('The code on the tag has four letters.');
            return;
        }
    }
    gateError(null);
    btn.disabled = true;
    const res = await post(kind, payload);
    btn.disabled = false;
    if (!res.ok) {
        gateError(res.body?.error ?? 'The parlour is unreachable; do try again.');
        return;
    }
    localStorage.setItem(NAME_KEY, name);
    enterRoom(res.body, name);
}

function enterRoom(granted, name) {
    session = { code: granted.code, token: granted.token, you: granted.you, name };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code: granted.code, token: granted.token, name }));
    history.replaceState(null, '', `?room=${granted.code}`);

    model = createModel();
    model.status = granted.room.status;
    guests = [];
    lastInkAt.clear();
    outbox.length = 0;
    strokeCounter = 1;
    failures = 0;
    selectedInk = granted.you.ink;
    buildTray();

    $('codeTagText').textContent = granted.code;
    $('codeChip').textContent = granted.code;
    renderRoles();
    showScreen(model.status === 'live' ? 'table' : 'lobby');
    if (model.status === 'live') {
        repaintAll();
    }
    schedulePoll(0);
}

// Leaving, on purpose or because the server said so.
function leaveLocal(message) {
    session = null;
    clearTimeout(pollTimer);
    sessionStorage.removeItem(SESSION_KEY);
    history.replaceState(null, '', location.pathname);
    model = createModel();
    guests = [];
    outbox.length = 0;
    showScreen('gate');
    if (message) toast(message);
}

function leaveRoom() {
    if (session) {
        // Fire and forget; presence would time us out anyway.
        post('leave', { code: session.code, token: session.token });
    }
    leaveLocal();
}

// ------------------------------------------------------------------
//  The poll loop (also our heartbeat)
// ------------------------------------------------------------------

function schedulePoll(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollOnce, ms);
}

async function pollOnce() {
    if (!session || pollBusy) return;
    pollBusy = true;
    const res = await post('poll', { code: session.code, token: session.token, since: model.lastSeq });
    pollBusy = false;
    if (!session) return; // stepped out while the request flew

    let more = false;
    if (res.ok && res.body) {
        failures = 0;
        more = handlePoll(res.body);
    } else if (res.status === 404) {
        leaveLocal('That room has been closed.');
        return;
    } else if (res.status === 401) {
        leaveLocal('You were away too long; join again with the same code.');
        return;
    } else {
        failures++;
    }
    updateWire();
    schedulePoll(more ? 30 : pollDelay({
        status: model.status,
        hidden: document.hidden,
        msSinceActivity: Date.now() - lastActivityAt,
        failures,
    }));
}

function handlePoll(body) {
    const wasLive = model.status === 'live';
    guests = body.guests;
    session.you = body.you;

    // Bookkeeping the reducer does not care about: who is drawing right now.
    const now = Date.now();
    for (const ev of body.events) {
        if (ev.type === 'stroke' && ev.guest !== session.you.id) {
            lastActivityAt = now;
            lastInkAt.set(ev.guest, now);
        }
    }

    const ops = applyEvents(model, body.events, session.you.id);
    model.lastSeq = Math.max(model.lastSeq, body.last);
    model.status = body.room.status; // covers resumes that missed the start event

    for (const op of ops) {
        if (op.op === 'draw') paintStroke(model.strokes.get(op.sid), op.from);
        else if (op.op === 'clear') repaintAll();
    }

    if (!wasLive && model.status === 'live') {
        showScreen('table');
        toast('The bell has rung: the sheet is open.');
    }
    renderGuests();
    return body.more === true;
}

function updateWire() {
    const down = failures > 0;
    for (const el of [$('lobbyWire'), $('wirePip')]) {
        el.textContent = down ? 'line down, re-establishing' : 'live wire';
        el.classList.toggle('wire-down', down);
    }
}

// ------------------------------------------------------------------
//  The outbox: stroke chunks must arrive in order, so one sender
//  drains a queue; network hiccups retry, rejections drop and tell.
// ------------------------------------------------------------------

function queueEvent(type, data) {
    outbox.push({ type, data });
    pumpOutbox();
}

async function pumpOutbox() {
    if (sending) return;
    sending = true;
    while (outbox.length > 0 && session) {
        const ev = outbox[0];
        const res = await post('event', { code: session.code, token: session.token, type: ev.type, data: ev.data });
        if (res.ok) {
            outbox.shift();
            failures = 0;
        } else if (res.status === 0 || res.status >= 500) {
            failures++;
            updateWire();
            await sleep(Math.min(8000, 500 * 2 ** failures));
        } else {
            outbox.shift(); // the server said no; retrying would not help
            if (res.body?.error) toast(res.body.error);
        }
    }
    sending = false;
    updateWire();
}

// ------------------------------------------------------------------
//  Guests: calling cards in the lobby, cameos at the table
// ------------------------------------------------------------------

function cameoEl(g) {
    const el = document.createElement('span');
    el.className = 'cameo';
    el.style.background = inkColor(g.ink);
    el.textContent = initials(g.name);
    el.title = g.name + (g.id === session.you.id ? ' (you)' : '') + (g.online ? '' : ' · away');
    if (!g.online) el.classList.add('cameo-away');
    else if (Date.now() - (lastInkAt.get(g.id) ?? 0) < 2500) el.classList.add('cameo-drawing');
    return el;
}

function renderGuests() {
    if (!session) return;

    // Lobby: calling cards
    const cards = $('guestCards');
    cards.replaceChildren(...guests.map((g) => {
        const card = document.createElement('div');
        card.className = 'guest-card' + (g.online ? '' : ' guest-away');
        const cameo = document.createElement('span');
        cameo.className = 'cameo';
        cameo.style.background = inkColor(g.ink);
        cameo.textContent = initials(g.name);
        const name = document.createElement('p');
        name.className = 'font-body text-[0.98rem] leading-tight break-words';
        name.textContent = g.name;
        const note = document.createElement('p');
        note.className = 'font-tele text-[0.6rem] tracking-[0.14em] uppercase text-inkdim mt-1';
        note.textContent = g.id === session.you.id ? 'that is you' : (g.online ? 'present' : 'away');
        card.append(cameo, name, note);
        if (g.host) {
            const ribbon = document.createElement('span');
            ribbon.className = 'guest-host-ribbon';
            ribbon.textContent = 'HOST';
            card.append(ribbon);
        }
        return card;
    }));
    $('guestCount').textContent = `${guests.length} of 12 seats`;

    // Table: the cameo strip
    $('cameoStrip').replaceChildren(...guests.map(cameoEl));

    renderRoles();
}

function renderRoles() {
    const host = session?.you.host === true;
    $('hostBell').classList.toggle('hidden', !host);
    $('waitBell').classList.toggle('hidden', host);
    $('clearBtn').classList.toggle('hidden', !host);
}

// ------------------------------------------------------------------
//  The sheet: rendering
// ------------------------------------------------------------------

const canvas = $('sheet');
const ctx = canvas.getContext('2d');
let sheetScale = 1; // device px per sheet unit

function resizeSheet() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    if (w === canvas.width && Math.round(rect.height * dpr) === canvas.height) return;
    canvas.width = w;
    canvas.height = Math.round(rect.height * dpr);
    sheetScale = canvas.width / SHEET_W;
    repaintAll();
}

function setSheetTransform() {
    ctx.setTransform(sheetScale, 0, 0, sheetScale, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
}

function repaintAll() {
    setSheetTransform();
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, SHEET_W, SHEET_H);
    for (const sid of model.order) {
        paintStroke(model.strokes.get(sid), 0);
    }
}

/** Paints stroke s from flat-array index `from` on, smoothing through midpoints. */
function paintStroke(s, from = 0) {
    if (!s || s.pts.length < 2) return;
    setSheetTransform();
    ctx.strokeStyle = inkColor(s.ink);
    ctx.lineWidth = s.size;
    const pts = s.pts;
    // Rewind two points for curve continuity across chunk boundaries.
    const start = Math.max(0, from - 4);
    ctx.beginPath();
    ctx.moveTo(pts[start], pts[start + 1]);
    if (pts.length - start === 2) {
        ctx.lineTo(pts[start] + 0.01, pts[start + 1]); // a dot
    } else {
        for (let j = start + 2; j < pts.length - 2; j += 2) {
            ctx.quadraticCurveTo(pts[j], pts[j + 1], (pts[j] + pts[j + 2]) / 2, (pts[j + 1] + pts[j + 3]) / 2);
        }
        ctx.lineTo(pts[pts.length - 2], pts[pts.length - 1]);
    }
    ctx.stroke();
}

function paintLiveSegment(x0, y0, x1, y1) {
    setSheetTransform();
    ctx.strokeStyle = inkColor(selectedInk);
    ctx.lineWidth = selectedSize;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1 + (x1 === x0 && y1 === y0 ? 0.01 : 0), y1);
    ctx.stroke();
}

// ------------------------------------------------------------------
//  The sheet: your pen
// ------------------------------------------------------------------

let pen = null; // {sid, buf:[], lastX, lastY, lastSent, flushTimer}

function toSheet(e) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: Math.max(0, Math.min(SHEET_W, ((e.clientX - rect.left) / rect.width) * SHEET_W)),
        y: Math.max(0, Math.min(SHEET_H, ((e.clientY - rect.top) / rect.height) * SHEET_H)),
    };
}

function flushPen(end) {
    if (!pen) return;
    let pts = packChunk(pen.buf);
    pen.buf = [];
    if (pts.length === 0) {
        if (!end || !pen.lastSent) return;
        pts = pen.lastSent; // an empty goodbye still needs a point to carry `end`
    }
    pen.lastSent = [pts[pts.length - 2], pts[pts.length - 1]];
    const data = { sid: pen.sid, ink: selectedInk, size: selectedSize, pts };
    if (end) data.end = true;
    addLocalChunk(model, data);
    queueEvent('stroke', data);
    lastActivityAt = Date.now();
}

canvas.addEventListener('pointerdown', (e) => {
    if (model.status !== 'live' || !session || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = toSheet(e);
    pen = {
        sid: `${session.you.id}.${strokeCounter++}`,
        buf: [x, y],
        lastX: x,
        lastY: y,
        lastSent: null,
        flushTimer: setInterval(() => flushPen(false), FLUSH_MS),
    };
    paintLiveSegment(x, y, x, y);
});

canvas.addEventListener('pointermove', (e) => {
    if (!pen) return;
    e.preventDefault();
    const moves = e.getCoalescedEvents?.() ?? [e];
    for (const m of moves) {
        const { x, y } = toSheet(m);
        pen.buf.push(x, y);
        paintLiveSegment(pen.lastX, pen.lastY, x, y);
        pen.lastX = x;
        pen.lastY = y;
    }
});

for (const type of ['pointerup', 'pointercancel']) {
    canvas.addEventListener(type, () => {
        if (!pen) return;
        clearInterval(pen.flushTimer);
        flushPen(true);
        pen = null;
    });
}

// ------------------------------------------------------------------
//  The tray
// ------------------------------------------------------------------

function buildTray() {
    const inks = $('inkTray');
    inks.replaceChildren(...INKS.map((hex, i) => {
        const b = document.createElement('button');
        b.className = 'ink-pot';
        b.style.background = hex;
        b.title = i === session?.you.ink ? 'Your ink' : 'Ink pot';
        b.dataset.ink = String(i);
        return b;
    }));
    const rubber = document.createElement('button');
    rubber.className = 'ink-pot ink-pot-rubber';
    rubber.title = 'India rubber (eraser)';
    rubber.dataset.ink = '-1';
    rubber.textContent = '✕';
    inks.append(rubber);

    const nibs = $('nibTray');
    nibs.replaceChildren(...NIB_SIZES.map((size, i) => {
        const b = document.createElement('button');
        b.className = 'nib';
        b.title = ['Fine nib', 'Regular nib', 'Broad nib'][i];
        b.dataset.size = String(size);
        const dot = document.createElement('i');
        const px = [6, 10, 16][i];
        dot.style.width = `${px}px`;
        dot.style.height = `${px}px`;
        b.append(dot);
        return b;
    }));
    refreshTray();
}

function refreshTray() {
    for (const b of $('inkTray').children) {
        b.classList.toggle('on', Number(b.dataset.ink) === selectedInk);
    }
    for (const b of $('nibTray').children) {
        b.classList.toggle('on', Number(b.dataset.size) === selectedSize);
    }
}

$('inkTray').addEventListener('click', (e) => {
    const pot = e.target.closest('.ink-pot');
    if (!pot) return;
    selectedInk = Number(pot.dataset.ink);
    refreshTray();
});

$('nibTray').addEventListener('click', (e) => {
    const nib = e.target.closest('.nib');
    if (!nib) return;
    selectedSize = Number(nib.dataset.size);
    refreshTray();
});

// ------------------------------------------------------------------
//  Bell, fresh sheet, copying, leaving
// ------------------------------------------------------------------

$('startBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.classList.add('bell-rung');
    setTimeout(() => btn.classList.remove('bell-rung'), 700);
    btn.disabled = true;
    const res = await post('event', { code: session.code, token: session.token, type: 'start' });
    btn.disabled = false;
    if (res.ok) {
        schedulePoll(0); // let the poll deliver the start to us too
    } else if (res.body?.error) {
        toast(res.body.error);
    }
});

let clearArmed = null;
$('clearBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!clearArmed) {
        btn.textContent = 'Again to confirm';
        clearArmed = setTimeout(() => {
            clearArmed = null;
            btn.textContent = 'Fresh sheet';
        }, 2600);
        return;
    }
    clearTimeout(clearArmed);
    clearArmed = null;
    btn.textContent = 'Fresh sheet';
    const res = await post('event', { code: session.code, token: session.token, type: 'clear' });
    if (res.ok) {
        schedulePoll(0);
    } else if (res.body?.error) {
        toast(res.body.error);
    }
});

async function copyCode() {
    if (!session) return;
    try {
        await navigator.clipboard.writeText(session.code);
    } catch {
        const ta = document.createElement('textarea');
        ta.value = session.code;
        document.body.append(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
    }
    $('codeTagHint').textContent = 'copied!';
    setTimeout(() => { $('codeTagHint').textContent = 'tap to copy'; }, 1600);
    $('codeTag').classList.add('copied');
    setTimeout(() => $('codeTag').classList.remove('copied'), 1600);
    toast(`Code ${session.code} copied; hand it round.`);
}

$('codeTag').addEventListener('click', copyCode);
$('codeChip').addEventListener('click', copyCode);
$('lobbyLeaveBtn').addEventListener('click', leaveRoom);
$('tableLeaveBtn').addEventListener('click', leaveRoom);

// ------------------------------------------------------------------
//  Wiring and arrival
// ------------------------------------------------------------------

$('createBtn').addEventListener('click', () => submitGate('create'));
$('joinBtn').addEventListener('click', () => submitGate('join'));
$('joinCode').addEventListener('input', (e) => { e.target.value = normalizeCode(e.target.value); });
for (const [id, kind] of [['hostName', 'create'], ['joinName', 'join'], ['joinCode', 'join']]) {
    $(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitGate(kind);
    });
}

new ResizeObserver(() => resizeSheet()).observe($('sheetFrame'));
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && session) schedulePoll(0);
});

async function arrive() {
    const rememberedName = localStorage.getItem(NAME_KEY) ?? '';
    $('hostName').value = rememberedName;
    $('joinName').value = rememberedName;

    const urlCode = normalizeCode(new URLSearchParams(location.search).get('room'));
    if (urlCode) $('joinCode').value = urlCode;

    // A refresh mid-party: pick the session back up where it was.
    let stored = null;
    try { stored = JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { /* fresh visit */ }
    if (stored?.code && stored?.token) {
        const res = await post('poll', { code: stored.code, token: stored.token, since: 0 });
        if (res.ok && res.body) {
            session = { code: stored.code, token: stored.token, you: res.body.you, name: stored.name ?? '' };
            model = createModel();
            selectedInk = res.body.you.ink;
            buildTray();
            $('codeTagText').textContent = stored.code;
            $('codeChip').textContent = stored.code;
            handlePoll(res.body);
            showScreen(model.status === 'live' ? 'table' : 'lobby');
            if (model.status === 'live') requestAnimationFrame(() => { resizeSheet(); repaintAll(); });
            schedulePoll(0);
            return;
        }
        sessionStorage.removeItem(SESSION_KEY);
    }
    showScreen('gate');
    if (urlCode) $('joinName').focus();
}

arrive();
