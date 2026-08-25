/* ============================================================
   SPY // CLASSIFIED  —  page controller
   Two gamemodes share one set of screens:
     solo  ONE PHONE, passed round the table. No network at all.
     room  a phone each, over an anonymous four-letter room code.
   The room mode is built on the parlour's polling machinery
   (views/parlour), with one inversion: a role is a secret, so the
   server owns the deal and every phone learns only its own card.
   Everything decidable without a DOM lives in logic.js.
   ============================================================ */

import {
    MIN_PLAYERS, MAX_PLAYERS, MIN_ROUND_SECONDS, MAX_ROUND_SECONDS, ROUND_STEP_SECONDS,
    clamp, spyMax, suggestedSpies, clampRoundSeconds, defaultRoundSeconds,
    formatClock, dealRoles, pickLocation,
    normalizeCode, isValidCode, cleanName, isValidName,
    createRoomModel, applyEvents, pollDelay,
} from './logic.js';

const API = '../../app/controllers/spy-controller.php';
const LS_KEY = 'spy:lastSettings';
const SESSION_KEY = 'spy:session';
const NAME_KEY = 'spy:name';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 'solo' once the one-phone game starts, 'room' once a room is entered. */
let mode = null;

// ---------------- one-phone state ----------------

const state = {
    players: 5,
    spies: 1,
    location: '',
    spyIndices: [],
    revealIndex: 0,
    revealShown: false,
    timer: null,
    timeRemaining: 0,
    totalTime: 0,
    isPaused: false,
};

// The location list is shared with the controller, so it lives in a JSON file
// rather than in this bundle. Room mode never needs it: the server posts each
// citizen their location directly.
let LOCATIONS = null;

// ---------------- room state ----------------

let session = null;          // {code, token, you:{id,host,ready,role,location}, name}
let model = createRoomModel();
let players = [];            // last server snapshot of the seats
let roomInfo = null;         // last server snapshot of the room
let reveal = null;           // the dossier, only ever present during a debrief
let failures = 0;            // consecutive transport failures -> backoff + pip
let pollTimer = null;
let pollBusy = false;
const outbox = [];
let sending = false;
let gateKind = 'create';
let routedStatus = null;     // the status the screen currently reflects
let roundTouched = false;    // has the host set the round length by hand yet
let pendingSettings = null;  // a stepper change not yet confirmed by the server
let clockBase = null;        // {left, at, paused} anchor for the local tick
let clockTimer = null;

// ------------------------------------------------------------------
//  Screens and chrome
// ------------------------------------------------------------------

function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(id).classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toast(msg, ms = 2800) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

const show = (id, on) => $(id).classList.toggle('hidden', !on);

// ------------------------------------------------------------------
//  Transport. Never throws: status 0 means the network died, which is
//  what lets the poll loop and the outbox tell it apart from a refusal.
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

// ------------------------------------------------------------------
//  One-phone mode: settings and setup
// ------------------------------------------------------------------

function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(LS_KEY));
        if (saved && typeof saved === 'object') {
            state.players = clamp(parseInt(saved.players, 10) || 5, MIN_PLAYERS, MAX_PLAYERS);
            state.spies = clamp(parseInt(saved.spies, 10) || 1, 1, spyMax(state.players));
        }
    } catch (e) { /* no-op: first run / blocked storage */ }
}

function saveSettings() {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify({ players: state.players, spies: state.spies }));
    } catch (e) { /* no-op */ }
}

function renderSetup() {
    $('playersValue').textContent = state.players;
    $('spiesValue').textContent = state.spies;

    $('playersMinus').disabled = state.players <= MIN_PLAYERS;
    $('playersPlus').disabled = state.players >= MAX_PLAYERS;

    const max = spyMax(state.players);
    $('spiesMinus').disabled = state.spies <= 1;
    $('spiesPlus').disabled = state.spies >= max;
    $('spiesHint').textContent = `suggested: ${suggestedSpies(state.players)} · max: ${max}`;
}

function changePlayers(delta) {
    state.players = clamp(state.players + delta, MIN_PLAYERS, MAX_PLAYERS);
    state.spies = clamp(state.spies, 1, spyMax(state.players));
    renderSetup();
}

function changeSpies(delta) {
    state.spies = clamp(state.spies + delta, 1, spyMax(state.players));
    renderSetup();
}

/** Fetched once, then cached; the file is same-origin and tiny. */
async function ensureLocations() {
    if (LOCATIONS) return LOCATIONS;
    const res = await fetch('locations.json', { cache: 'force-cache' });
    const json = await res.json();
    if (!Array.isArray(json?.locations) || json.locations.length === 0) {
        throw new Error('empty location list');
    }
    LOCATIONS = json.locations;
    return LOCATIONS;
}

// ------------------------------------------------------------------
//  One-phone mode: the pass-around briefing
// ------------------------------------------------------------------

function assignRoles() {
    state.location = pickLocation(LOCATIONS);
    state.spyIndices = dealRoles(state.players, state.spies);
    state.revealIndex = 0;
    state.revealShown = false;
}

async function startBriefing() {
    try {
        await ensureLocations();
    } catch {
        toast('Could not load the location file. Check your connection.');
        return;
    }
    mode = 'solo';
    assignRoles();
    showScreen('briefScreen');
    renderBriefCard();
}

/** The role face of the card, shared by both modes. */
function roleMarkup(isSpy, location, spyCount) {
    const spyWord = spyCount > 1 ? 'spies' : 'spy';
    if (isSpy) {
        return `<div class="role-title">YOU ARE A SPY</div>
            <p class="role-flavor">You don't know the location. Work it out from what others say,
                blend in, and don't get caught.</p>`;
    }
    return `<p class="role-kicker">YOUR LOCATION</p>
            <div class="role-location">${location}</div>
            <p class="role-flavor">Prove you belong here. Smoke out the ${spyWord} who can't.</p>`;
}

function renderBriefCard() {
    const i = state.revealIndex;
    const isSpy = state.spyIndices.includes(i);

    show('briefRoom', false);
    $('briefProgress').textContent = `PLAYER ${i + 1} / ${state.players}`;
    $('briefLockLabel').textContent = 'PASS DEVICE TO';
    $('briefAgent').textContent = `PLAYER ${i + 1}`;
    $('briefAgentDone').textContent = `PLAYER ${i + 1}`;
    $('briefDoneHint').textContent = '↓ pass it on';

    const role = $('briefRole');
    role.className = isSpy ? 'role-spy' : 'role-citizen';
    role.innerHTML = roleMarkup(isSpy, state.location, state.spies);

    resetBriefCard();
    const nextBtn = $('briefNextBtn');
    nextBtn.classList.add('hidden');
    nextBtn.textContent = (i === state.players - 1) ? '▶ START ROUND' : '▶ NEXT PLAYER';
}

function resetBriefCard() {
    $('briefCard').classList.remove('is-revealed', 'is-done');
    state.revealShown = false;
}

function toggleBriefCard() {
    const card = $('briefCard');
    if (card.classList.contains('is-done')) return; // locked once hidden

    if (!state.revealShown) {
        state.revealShown = true;
        card.classList.add('is-revealed');
        return;
    }
    // hide before allowing pass-on, so the next person cannot peek
    state.revealShown = false;
    card.classList.remove('is-revealed');
    card.classList.add('is-done');

    if (mode === 'room') {
        queueEvent('ready');
        session.you.ready = true;
        renderBriefRoom();
    } else {
        $('briefNextBtn').classList.remove('hidden');
    }
}

function nextAgent() {
    if (state.revealIndex < state.players - 1) {
        state.revealIndex++;
        renderBriefCard();
    } else {
        startSoloRound();
    }
}

// ------------------------------------------------------------------
//  The clock. One painter for both modes: the one-phone game owns its
//  countdown outright, a room interpolates between polls off the
//  server's secondsLeft so every phone shows the same number.
// ------------------------------------------------------------------

function paintTimer(remaining, total, paused) {
    const left = Math.max(0, remaining);
    $('timerDisplay').textContent = formatClock(left);
    $('timerDisplay').classList.toggle('low', left <= 30 && left > 0 && !paused);
    $('timerDisplay').classList.toggle('paused', paused);

    const pct = total > 0 ? ((total - left) / total) * 100 : 0;
    $('timerProgress').style.width = `${clamp(pct, 0, 100)}%`;
    $('timerProgress').classList.toggle('low', left <= 30);

    $('pauseNote').hidden = !paused;
}

// ---------------- one-phone round ----------------

function startSoloRound() {
    showScreen('roundScreen');
    show('roundSignal', false);
    show('roundGuestNote', false);
    show('roundControls', true);
    $('roundAgentCount').textContent = state.players;
    $('roundSpyCount').textContent = state.spies;

    state.totalTime = state.players * 60;
    state.timeRemaining = state.totalTime;
    state.isPaused = false;

    $('pauseBtn').textContent = '❚❚ PAUSE';
    $('endRoundBtn').textContent = '■ END ROUND';
    paintTimer(state.timeRemaining, state.totalTime, false);
    startTimerInterval();
}

function startTimerInterval() {
    clearInterval(state.timer);
    state.timer = setInterval(soloTick, 1000);
}

function soloTick() {
    state.timeRemaining--;
    paintTimer(state.timeRemaining, state.totalTime, false);
    if (state.timeRemaining <= 0) endSoloRound();
}

function toggleSoloPause() {
    state.isPaused = !state.isPaused;
    if (state.isPaused) {
        clearInterval(state.timer);
        $('pauseBtn').textContent = '▶ RESUME';
    } else {
        $('pauseBtn').textContent = '❚❚ PAUSE';
        startTimerInterval();
    }
    paintTimer(state.timeRemaining, state.totalTime, state.isPaused);
}

function endSoloRound() {
    clearInterval(state.timer);
    state.timer = null;
    state.isPaused = false;
    showSoloDebrief();
}

// ---------------- one-phone debrief ----------------

function showSoloDebrief() {
    showScreen('debriefScreen');
    show('declassifyResult', false);
    show('declassifyBtn', true);
    show('debriefSoloActions', true);
    show('debriefRoomActions', false);
    const spyWord = state.spies > 1 ? 'spies' : 'spy';
    $('playAgainSub').textContent = `(${state.players} players · ${state.spies} ${spyWord})`;
}

function declassify() {
    if (mode === 'room') {
        if (!reveal) return;
        $('resultSpies').textContent = reveal.spies.map((s) => s.name).join('  ·  ') || 'NOBODY';
        $('resultLocation').textContent = reveal.location ?? '';
    } else {
        $('resultSpies').textContent = state.spyIndices.map((i) => `PLAYER ${i + 1}`).join('  ·  ');
        $('resultLocation').textContent = state.location;
    }
    show('declassifyResult', true);
    show('declassifyBtn', false);
}

// ------------------------------------------------------------------
//  Navigation between the menus
// ------------------------------------------------------------------

function goToMode() {
    showScreen('modeScreen');
}

function goToSetup() {
    renderSetup();
    showScreen('setupScreen');
}

function mainMenu() {
    mode = null;
    showScreen('bootScreen');
}

// ------------------------------------------------------------------
//  The gate: opening or joining a room
// ------------------------------------------------------------------

function openGate(kind) {
    gateKind = kind;
    const joining = kind === 'join';
    $('gateTitle').textContent = joining ? 'JOIN A ROOM' : 'OPEN A ROOM';
    $('gateLead').textContent = joining ? '// CODENAME AND ROOM CODE' : '// PICK A CODENAME';
    $('gateSubmitBtn').textContent = joining ? '> TAKE A SEAT' : '> OPEN ROOM';
    show('gateCodeField', joining);
    show('reclaimBox', false);
    gateError(null);

    try {
        $('gateName').value = localStorage.getItem(NAME_KEY) ?? '';
    } catch { /* blocked storage */ }
    const fromUrl = normalizeCode(new URLSearchParams(location.search).get('room') ?? '');
    if (joining && fromUrl) $('gateCode').value = fromUrl;

    showScreen('gateScreen');
}

function gateError(msg) {
    $('gateError').textContent = msg ?? '';
    show('gateError', Boolean(msg));
}

async function submitGate() {
    const name = cleanName($('gateName').value);
    if (!isValidName(name)) {
        gateError('A codename, please: one to twenty characters.');
        return;
    }
    const payload = { name };
    let code = '';
    if (gateKind === 'join') {
        code = normalizeCode($('gateCode').value);
        if (!isValidCode(code)) {
            gateError('Room codes are four letters.');
            return;
        }
        payload.code = code;
    }

    gateError(null);
    show('reclaimBox', false);
    $('gateSubmitBtn').disabled = true;
    const res = await post(gateKind, payload);
    $('gateSubmitBtn').disabled = false;

    if (res.ok) {
        rememberName(name);
        enterRoom(res.body, name);
        return;
    }
    // The one refusal that is not a dead end: the game is already running,
    // so offer the seats instead of the door.
    if (res.body?.reclaim === true) {
        gateError(null);
        await showReclaim(code);
        return;
    }
    gateError(res.body?.error ?? 'No signal. Try again in a moment.');
}

function rememberName(name) {
    try {
        localStorage.setItem(NAME_KEY, name);
    } catch { /* blocked storage */ }
}

// ------------------------------------------------------------------
//  Reclaiming a seat after a phone lost its session mid-game
// ------------------------------------------------------------------

async function showReclaim(code) {
    const res = await post('seats', { code });
    if (!res.ok) {
        gateError(res.body?.error ?? 'That room is not answering.');
        return;
    }
    const list = $('seatList');
    list.replaceChildren();
    for (const seat of res.body.players) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'seat' + (seat.reclaimable ? '' : ' seat-live');
        btn.disabled = !seat.reclaimable;
        btn.innerHTML = `<span class="seat-name"></span>
            <span class="seat-state">${seat.reclaimable ? 'TAKE BACK' : 'IN PLAY'}</span>`;
        btn.querySelector('.seat-name').textContent = seat.name;
        btn.addEventListener('click', () => reclaimSeat(code, seat));
        list.appendChild(btn);
    }
    show('reclaimBox', true);
}

async function reclaimSeat(code, seat) {
    const res = await post('reclaim', { code, playerId: seat.id });
    if (!res.ok) {
        gateError(res.body?.error ?? 'That seat could not be taken back.');
        await showReclaim(code);
        return;
    }
    rememberName(seat.name);
    enterRoom(res.body, seat.name);
}

// ------------------------------------------------------------------
//  Entering and leaving a room
// ------------------------------------------------------------------

function enterRoom(granted, name) {
    mode = 'room';
    session = { code: granted.code, token: granted.token, you: granted.you, name };
    try {
        localStorage.setItem(SESSION_KEY, JSON.stringify({
            code: granted.code, token: granted.token, name,
        }));
    } catch { /* blocked storage */ }
    // The address bar carries the code so it can be shared, never the token.
    history.replaceState(null, '', `?room=${granted.code}`);

    model = createRoomModel();
    model.status = granted.room.status;
    players = [];
    roomInfo = null;
    reveal = null;
    routedStatus = null;
    roundTouched = false;
    pendingSettings = null;
    outbox.length = 0;
    failures = 0;
    clearRosterDom();

    $('codePlateValue').textContent = granted.code;
    $('codePlateHint').textContent = '[ TAP TO COPY ]';

    // Paint from what the grant already told us, so the lobby is not blank
    // for the length of a round-trip. The first poll replaces all of it.
    roomInfo = {
        code: granted.room.code,
        status: granted.room.status,
        spies: granted.room.spies ?? 1,
        roundSeconds: granted.room.roundSeconds ?? 300,
        secondsLeft: null,
        paused: false,
        seated: 1,
    };
    players = [{
        id: granted.you.id, name, host: granted.you.host, ready: granted.you.ready, online: true,
    }];

    routeRoom();
    renderRoom();
    schedulePoll(0);
}

/** Leaving, on purpose or because the server said so. */
function leaveLocal(message) {
    mode = null;
    session = null;
    clearTimeout(pollTimer);
    stopClock();
    try {
        localStorage.removeItem(SESSION_KEY);
    } catch { /* blocked storage */ }
    history.replaceState(null, '', location.pathname);
    model = createRoomModel();
    players = [];
    roomInfo = null;
    reveal = null;
    routedStatus = null;
    pendingSettings = null;
    outbox.length = 0;
    clearRosterDom();
    showScreen('bootScreen');
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
//  The poll loop, which doubles as this phone's heartbeat
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
    if (!session) return; // left the room while the request was in flight

    let more = false;
    if (res.ok && res.body) {
        failures = 0;
        more = handlePoll(res.body);
    } else if (res.status === 404) {
        leaveLocal('That room has been closed.');
        return;
    } else if (res.status === 401) {
        leaveLocal('Your seat was taken. Join again with the room code.');
        return;
    } else {
        failures++;
    }
    updateSignal();
    schedulePoll(more ? 30 : pollDelay({
        status: model.status,
        hidden: document.hidden,
        failures,
    }));
}

/**
 * Snapshot fields (room, you, players) are replaced wholesale: the server is
 * authoritative on identity, host and phase. Log events are reduced on top
 * for the edges the UI has to react to. The snapshot status is applied AFTER
 * the reducer on purpose, so a phone that resumed past those events still
 * lands on the right screen.
 */
function handlePoll(body) {
    const ops = applyEvents(model, body.events, session.you.id);
    model.lastSeq = Math.max(model.lastSeq, body.last);
    model.status = body.room.status;

    const wasHost = session.you.host;
    session.you = body.you;
    players = body.players;
    roomInfo = body.room;
    reveal = body.reveal ?? null;

    // Hold the host's un-confirmed stepper choice over the snapshot, so it
    // does not flip back under their finger while the change is in flight.
    if (pendingSettings) {
        if (Date.now() < settingsDirtyUntil) {
            roomInfo.spies = pendingSettings.spies;
            roomInfo.roundSeconds = pendingSettings.roundSeconds;
        } else {
            pendingSettings = null;
        }
    }

    for (const op of ops) {
        if (op.op === 'deal') onDealt();
        else if (op.op === 'pause') toast('The host paused the clock.');
        else if (op.op === 'resume') toast('The clock is running again.');
        else if (op.op === 'host' && op.mine) toast('The host left. You are running the operation now.');
    }
    if (!wasHost && session.you.host && !ops.some((o) => o.op === 'host')) {
        toast('You are running the operation now.');
    }

    syncClock();
    routeRoom();
    renderRoom();
    return body.more === true;
}

function updateSignal() {
    const down = failures > 0;
    for (const id of ['lobbySignal', 'roundSignal']) {
        const el = $(id);
        el.textContent = down ? 'SIGNAL LOST' : 'SIGNAL SECURE';
        el.classList.toggle('signal-down', down);
    }
}

// ------------------------------------------------------------------
//  The outbox: our events must reach the server in the order we made
//  them, so one drainer works the queue. Network trouble retries for
//  as long as it takes; a refusal is final and says why.
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
        const res = await post('event', {
            code: session.code, token: session.token, type: ev.type, data: ev.data,
        });
        if (res.ok) {
            outbox.shift();
            failures = 0;
            schedulePoll(0); // learn the consequence through the normal path
        } else if (res.status === 0 || res.status >= 500) {
            failures++;
            updateSignal();
            await sleep(Math.min(8000, 500 * 2 ** failures));
        } else {
            outbox.shift(); // the server said no; retrying would not help
            if (res.body?.error) toast(res.body.error);
        }
    }
    sending = false;
    updateSignal();
}

// ------------------------------------------------------------------
//  Rosters. Reconciled by player id rather than rebuilt: rows carry a
//  one-shot deal-in animation and the poll runs about once a second,
//  so re-creating the nodes would leave the list twitching.
// ------------------------------------------------------------------

const rosterEls = new Map(); // `${containerId}:${playerId}` -> row element

function syncById(container, items, create, update) {
    const key = (id) => `${container.id}:${id}`;
    for (const [k, el] of rosterEls) {
        if (!k.startsWith(`${container.id}:`)) continue;
        if (!items.some((it) => key(it.id) === k)) {
            el.remove();
            rosterEls.delete(k);
        }
    }
    let prev = null;
    for (const item of items) {
        let el = rosterEls.get(key(item.id));
        if (!el) {
            el = create(item);
            rosterEls.set(key(item.id), el);
        }
        update(el, item);
        // Moving an attached node re-inserts it and restarts its animation,
        // so only touch the ones actually out of place.
        const slot = prev ? prev.nextSibling : container.firstChild;
        if (el !== slot) container.insertBefore(el, slot);
        prev = el;
    }
}

function clearRosterDom() {
    rosterEls.clear();
    $('lobbyRoster').replaceChildren();
    $('briefRoster').replaceChildren();
}

function renderRoster(container, showReady) {
    syncById(container, players, () => {
        const row = document.createElement('div');
        row.className = 'roster-row';
        row.innerHTML = `<span class="roster-dot"></span>
            <span class="roster-name"></span>
            <span class="roster-tags"></span>`;
        return row;
    }, (row, p) => {
        row.classList.toggle('is-offline', !p.online);
        row.classList.toggle('is-you', p.id === session.you.id);
        row.querySelector('.roster-name').textContent = p.name;
        const tags = [];
        if (p.host) tags.push('<span class="roster-tag">HOST</span>');
        if (showReady && p.ready) tags.push('<span class="roster-tag ok">BRIEFED</span>');
        if (!p.online) tags.push('<span class="roster-tag dim">AWAY</span>');
        row.querySelector('.roster-tags').innerHTML = tags.join('');
    });
}

// ------------------------------------------------------------------
//  The shared clock
// ------------------------------------------------------------------

function syncClock() {
    if (!roomInfo || roomInfo.status !== 'round' || roomInfo.secondsLeft === null) {
        clockBase = null;
        stopClock();
        return;
    }
    clockBase = { left: roomInfo.secondsLeft, at: Date.now(), paused: roomInfo.paused };
    if (roomInfo.paused) stopClock();
    else startClock();
    paintRoomClock();
}

function currentRoomSeconds() {
    if (!clockBase) return 0;
    if (clockBase.paused) return clockBase.left;
    return Math.max(0, clockBase.left - Math.floor((Date.now() - clockBase.at) / 1000));
}

function paintRoomClock() {
    if (!roomInfo) return;
    paintTimer(currentRoomSeconds(), roomInfo.roundSeconds, clockBase?.paused ?? false);
}

function startClock() {
    if (!clockTimer) clockTimer = setInterval(paintRoomClock, 500);
}

function stopClock() {
    clearInterval(clockTimer);
    clockTimer = null;
}

// ------------------------------------------------------------------
//  Room rendering
// ------------------------------------------------------------------

let settingsDirtyUntil = 0; // shields the steppers from a poll mid-tap
let cardSignature = null;   // which card face is currently painted

function routeRoom() {
    if (model.status === routedStatus) return;
    routedStatus = model.status;

    if (model.status === 'lobby') {
        showScreen('lobbyScreen');
    } else if (model.status === 'brief') {
        showScreen('briefScreen');
    } else if (model.status === 'round') {
        showScreen('roundScreen');
        show('roundSignal', true);
    } else if (model.status === 'debrief') {
        showScreen('debriefScreen');
        show('declassifyResult', false);
        show('declassifyBtn', true);
        show('debriefSoloActions', false);
        show('debriefRoomActions', true);
    }
}

/** A fresh deal: the card goes back behind its cover, wherever we were. */
function onDealt() {
    cardSignature = null;
    resetBriefCard();
}

function renderRoom() {
    if (!session || !roomInfo) return;
    if (model.status === 'lobby') renderLobby();
    else if (model.status === 'brief') renderBriefRoom();
    else if (model.status === 'round') renderRoundRoom();
    else if (model.status === 'debrief') renderDebriefRoom();
}

function renderLobby() {
    $('codePlateValue').textContent = roomInfo.code;
    $('lobbyCount').textContent = players.length;
    renderRoster($('lobbyRoster'), false);

    const host = session.you.host;
    show('hostControls', host);
    show('guestWait', !host);

    const seated = players.length;
    const max = spyMax(seated);

    // Until the host sets it by hand, the round tracks the table the way the
    // one-phone game always has: a minute per player.
    if (session.you.host && !roundTouched) {
        const want = defaultRoundSeconds(seated);
        if (want !== roomInfo.roundSeconds) {
            roomInfo.roundSeconds = want;
            queueSettings();
        }
    }

    // roomInfo is the single source here: handlePoll already holds an
    // un-confirmed stepper change over the snapshot, so the value on screen
    // and the enabled state of the steppers can never disagree.
    $('roomSpiesValue').textContent = roomInfo.spies;
    $('roomTimeValue').textContent = formatClock(roomInfo.roundSeconds);
    $('roomSpiesHint').textContent = `suggested: ${suggestedSpies(seated)} · max: ${max}`;
    $('roomSpiesMinus').disabled = roomInfo.spies <= 1;
    $('roomSpiesPlus').disabled = roomInfo.spies >= max;
    $('roomTimeMinus').disabled = roomInfo.roundSeconds <= MIN_ROUND_SECONDS;
    $('roomTimePlus').disabled = roomInfo.roundSeconds >= MAX_ROUND_SECONDS;

    const deal = $('roomDealBtn');
    deal.disabled = seated < MIN_PLAYERS;
    deal.textContent = seated < MIN_PLAYERS
        ? `> NEED ${MIN_PLAYERS - seated} MORE`
        : '> DEAL ROLES';

    const hostName = players.find((p) => p.host)?.name ?? 'THE HOST';
    $('hostNameWait').textContent = hostName.toUpperCase();
    const spyWord = roomInfo.spies > 1 ? 'spies' : 'spy';
    $('guestSettings').textContent =
        `${seated} agents · ${roomInfo.spies} ${spyWord} · ${formatClock(roomInfo.roundSeconds)} on the clock`;
}

function renderBriefRoom() {
    const isSpy = session.you.role === 'spy';
    const signature = `${session.you.role}|${session.you.location ?? ''}|${roomInfo.spies}`;
    if (signature !== cardSignature) {
        cardSignature = signature;
        $('briefProgress').textContent = 'YOUR BRIEFING';
        $('briefLockLabel').textContent = 'EYES ONLY';
        $('briefAgent').textContent = session.name.toUpperCase();
        $('briefAgentDone').textContent = session.name.toUpperCase();
        $('briefDoneHint').textContent = 'sit tight';
        const role = $('briefRole');
        role.className = isSpy ? 'role-spy' : 'role-citizen';
        role.innerHTML = roleMarkup(isSpy, session.you.location ?? '', roomInfo.spies);
        show('briefNextBtn', false);
        show('briefRoom', true);
        // A phone that resumed straight into the briefing has already
        // memorized its card if the server says so.
        if (session.you.ready) $('briefCard').classList.add('is-done');
    }

    const ready = players.filter((p) => p.ready).length;
    $('briefTally').textContent = `${ready} / ${players.length} BRIEFED`;
    renderRoster($('briefRoster'), true);

    const allReady = players.length > 0 && ready === players.length;
    show('briefStartBtn', session.you.host);
    show('briefWait', !session.you.host);
    $('briefStartBtn').textContent = allReady ? '▶ START ROUND' : `▶ START ANYWAY (${ready}/${players.length})`;
}

function renderRoundRoom() {
    $('roundAgentCount').textContent = players.length;
    $('roundSpyCount').textContent = roomInfo.spies;
    show('roundControls', session.you.host);
    show('roundGuestNote', !session.you.host);
    $('pauseBtn').textContent = roomInfo.paused ? '▶ RESUME' : '❚❚ PAUSE';
}

function renderDebriefRoom() {
    const host = session.you.host;
    show('roomAgainBtn', host);
    show('roomLobbyBtn', host);
    show('debriefWait', !host);
    const spyWord = roomInfo.spies > 1 ? 'spies' : 'spy';
    $('roomAgainSub').textContent = `(${players.length} agents · ${roomInfo.spies} ${spyWord})`;
}

// ------------------------------------------------------------------
//  Host controls
// ------------------------------------------------------------------

let settingsTimer = null;

/**
 * Steppers feel instant, so paint locally and let the server confirm. The
 * values are captured here rather than read when the debounce fires: a poll
 * landing in between replaces roomInfo wholesale, and sending whatever it
 * put there would post the host's change straight back to its old value.
 */
function queueSettings() {
    pendingSettings = { spies: roomInfo.spies, roundSeconds: roomInfo.roundSeconds };
    settingsDirtyUntil = Date.now() + 2500;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => {
        if (pendingSettings) queueEvent('settings', pendingSettings);
    }, 350);
}

function changeRoomSpies(delta) {
    const next = clamp(roomInfo.spies + delta, 1, spyMax(players.length));
    if (next === roomInfo.spies) return;
    roomInfo.spies = next;
    queueSettings();
    renderLobby();
}

function changeRoomTime(delta) {
    const next = clampRoundSeconds(roomInfo.roundSeconds + delta * ROUND_STEP_SECONDS);
    if (next === roomInfo.roundSeconds) return;
    roomInfo.roundSeconds = next;
    roundTouched = true; // stop tracking the player count from here on
    queueSettings();
    renderLobby();
}

async function copyCode() {
    // The link is more useful than the four letters on their own: it opens
    // the join gate with the code already filled in.
    const url = `${location.origin}${location.pathname}?room=${session.code}`;
    const hint = $('codePlateHint');
    try {
        await navigator.clipboard.writeText(url);
        hint.textContent = '[ LINK COPIED ]';
    } catch {
        hint.textContent = `[ ${session.code} ]`;
    }
    clearTimeout(copyCode.t);
    copyCode.t = setTimeout(() => { hint.textContent = '[ TAP TO COPY ]'; }, 1800);
}

// ------------------------------------------------------------------
//  Arrival: resume a room, honour a shared link, or just boot
// ------------------------------------------------------------------

async function arrive() {
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(SESSION_KEY));
    } catch { /* blocked storage */ }

    if (saved?.code && saved?.token) {
        mode = 'room';
        model = createRoomModel();
        session = {
            code: saved.code,
            token: saved.token,
            name: saved.name ?? '',
            you: { id: 0, host: false, ready: false, role: null, location: null },
        };
        // since: 0 replays the room from the start, so a phone that was away
        // rebuilds its whole picture in one request.
        const res = await post('poll', { code: saved.code, token: saved.token, since: 0 });
        if (res.ok && res.body) {
            $('codePlateValue').textContent = saved.code;
            history.replaceState(null, '', `?room=${saved.code}`);
            handlePoll(res.body);
            updateSignal();
            schedulePoll(pollDelay({ status: model.status, hidden: document.hidden, failures: 0 }));
            return;
        }
        mode = null;
        session = null;
        try {
            localStorage.removeItem(SESSION_KEY);
        } catch { /* blocked storage */ }
        history.replaceState(null, '', location.pathname);
    }

    const shared = normalizeCode(new URLSearchParams(location.search).get('room') ?? '');
    if (isValidCode(shared)) {
        openGate('join');
        return;
    }
    showScreen('bootScreen');
}

// ------------------------------------------------------------------
//  Wiring
// ------------------------------------------------------------------

function init() {
    loadSettings();
    renderSetup();
    // Warm the location file so the one-phone deal never waits on it.
    ensureLocations().catch(() => { /* retried on deal */ });

    // Menus
    $('initiateBtn').addEventListener('click', goToMode);
    $('modeSoloBtn').addEventListener('click', goToSetup);
    $('modeCreateBtn').addEventListener('click', () => openGate('create'));
    $('modeJoinBtn').addEventListener('click', () => openGate('join'));
    $('modeBackBtn').addEventListener('click', mainMenu);

    // One-phone setup
    $('playersMinus').addEventListener('click', () => changePlayers(-1));
    $('playersPlus').addEventListener('click', () => changePlayers(1));
    $('spiesMinus').addEventListener('click', () => changeSpies(-1));
    $('spiesPlus').addEventListener('click', () => changeSpies(1));
    $('deployBtn').addEventListener('click', () => { saveSettings(); startBriefing(); });
    $('setupBackBtn').addEventListener('click', goToMode);

    // The gate
    $('gateSubmitBtn').addEventListener('click', submitGate);
    $('gateBackBtn').addEventListener('click', goToMode);
    $('gateCode').addEventListener('input', (e) => { e.target.value = normalizeCode(e.target.value); });
    for (const id of ['gateName', 'gateCode']) {
        $(id).addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); submitGate(); }
        });
    }

    // The lobby
    $('codePlate').addEventListener('click', copyCode);
    $('roomSpiesMinus').addEventListener('click', () => changeRoomSpies(-1));
    $('roomSpiesPlus').addEventListener('click', () => changeRoomSpies(1));
    $('roomTimeMinus').addEventListener('click', () => changeRoomTime(-1));
    $('roomTimePlus').addEventListener('click', () => changeRoomTime(1));
    $('roomDealBtn').addEventListener('click', () => queueEvent('deal'));
    $('lobbyLeaveBtn').addEventListener('click', leaveRoom);

    // The briefing card, shared by both modes
    const card = $('briefCard');
    card.addEventListener('click', toggleBriefCard);
    card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleBriefCard();
        }
    });
    $('briefNextBtn').addEventListener('click', nextAgent);
    $('briefStartBtn').addEventListener('click', () => queueEvent('start'));

    // The round, shared by both modes
    $('pauseBtn').addEventListener('click', () => {
        if (mode === 'room') queueEvent(roomInfo?.paused ? 'resume' : 'pause');
        else toggleSoloPause();
    });
    $('endRoundBtn').addEventListener('click', () => {
        if (mode === 'room') queueEvent('end');
        else endSoloRound();
    });

    // The debrief
    $('declassifyBtn').addEventListener('click', declassify);
    $('playAgainBtn').addEventListener('click', startBriefing);
    $('changeSettingsBtn').addEventListener('click', goToSetup);
    $('mainMenuBtn').addEventListener('click', mainMenu);
    $('roomAgainBtn').addEventListener('click', () => queueEvent('deal'));
    $('roomLobbyBtn').addEventListener('click', () => queueEvent('again'));
    $('roomLeaveBtn').addEventListener('click', leaveRoom);

    // Coming back to the tab should catch up at once, not on the next tick.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && session) schedulePoll(0);
    });

    arrive();
}

document.addEventListener('DOMContentLoaded', init);
