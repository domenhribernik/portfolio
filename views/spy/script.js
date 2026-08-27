/* ============================================================
   SPY // CLASSIFIED  ::  page controller
   Two gamemodes share one set of screens:
     solo  ONE PHONE, passed round the table.
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
    createRoomModel, applyEvents, pollDelay, endVoteThreshold, VOTE_GRACE_SECONDS,
    DEFAULT_LANG, createTranslator, tableLanguages, normalizeLang, spyWord, hasString,
} from './logic.js';

const API = '../../app/controllers/spy-controller.php';
const LS_KEY = 'spy:lastSettings';
const SESSION_KEY = 'spy:session';
const NAME_KEY = 'spy:name';
const LANG_KEY = 'spy:lang';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (id, on) => $(id).classList.toggle('hidden', !on);

/** 'solo' once the one-phone game starts, 'room' once a room is entered. */
let mode = null;

// ---------------- translation ----------------

// Both tables are fetched once and shared with the controller, which reads
// the identical files. Until they land the page shows the English baked into
// the markup, so nothing is ever blank.
let uiTable = null;
let locTable = null;
let lang = DEFAULT_LANG;
let t = (key) => key;

// ---------------- one-phone state ----------------

const state = {
    players: 5,
    spies: 1,
    locationKey: '',
    spyIndices: [],
    revealIndex: 0,
    revealShown: false,
    timer: null,
    timeRemaining: 0,
    totalTime: 0,
    isPaused: false,
};

// ---------------- room state ----------------

let session = null;          // {code, token, you:{...}, name}
let model = createRoomModel();
let players = [];            // last server snapshot of the seats
let roomInfo = null;         // last server snapshot of the room
let reveal = null;           // the dossier, only ever present during a debrief
let failures = 0;
let pollTimer = null;
let pollBusy = false;
const outbox = [];
let sending = false;
let gateKind = 'create';
let routedStatus = null;
let roundTouched = false;
let pendingSettings = null;
// The same shield pendingSettings gives the host's steppers, for the two
// controls a player can flip: their ballot and their call to vote. A poll
// already in flight when you tap answers with the state from BEFORE the tap,
// and without these it lands after and snaps the control back to your old
// answer, which reads exactly like the game ignoring you.
let pendingBallot = null;
let pendingCall = null;
let clockBase = null;
let clockTimer = null;
let graceBase = null;        // interpolates the vote countdown between polls
let graceTimer = null;

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

// ------------------------------------------------------------------
//  Transport. Never throws: status 0 means the network died, which is
//  what lets the poll loop and the outbox tell it apart from a refusal.
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
//  Translation
// ------------------------------------------------------------------

async function loadTables() {
    // 'no-cache' REVALIDATES, it does not skip the cache: an unchanged table
    // still comes back as a bodyless 304. force-cache was the wrong trade
    // here, because it serves a stale copy without ever asking, so a returning
    // phone kept a table from before the last deploy and rendered every string
    // added since as its raw key.
    const [ui, loc] = await Promise.all([
        fetch('i18n/ui.json', { cache: 'no-cache' }).then((r) => r.json()),
        fetch('i18n/locations.json', { cache: 'no-cache' }).then((r) => r.json()),
    ]);
    uiTable = ui;
    locTable = loc;
    if (!Array.isArray(locTable?.locations) || locTable.locations.length === 0) {
        throw new Error('empty location table');
    }
}

/**
 * Repaints every translated string on the page. Static text is marked up with
 * data-i18n so the markup itself lists what needs translating; anything
 * assembled from numbers or names is rebuilt by the render functions below.
 */
function applyLang(next) {
    lang = normalizeLang(next, uiTable);
    t = uiTable ? createTranslator(uiTable, lang) : ((key) => key);
    document.documentElement.lang = lang;

    for (const el of document.querySelectorAll('[data-i18n]')) {
        el.textContent = t(el.dataset.i18n);
    }
    for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
        el.placeholder = t(el.dataset.i18nPlaceholder);
    }

    try {
        localStorage.setItem(LANG_KEY, lang);
    } catch { /* blocked storage */ }

    // The dynamic half: anything holding a count, a name or a role.
    renderSetup();
    if (mode === 'room' && session && roomInfo) {
        cardSignature = null;
        renderRoom();
    } else if (mode === 'solo') {
        if ($('briefScreen').classList.contains('active')) renderBriefCard();
        if ($('roundScreen').classList.contains('active')) renderSoloRoundChrome();
        if ($('debriefScreen').classList.contains('active')) renderSoloDebriefChrome();
    }
}

/** Fills the picker from whatever languages the table declares. */
function buildLangPicker() {
    const names = { en: 'ENGLISH', sl: 'SLOVENŠČINA' };
    const select = $('gateLang');
    select.replaceChildren();
    for (const code of tableLanguages(uiTable)) {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = names[code] ?? code.toUpperCase();
        select.appendChild(option);
    }
    select.value = lang;
}

/** One location, in the language this client is playing in. */
function locationText(key) {
    const row = locTable?.locations?.find((l) => l.key === key);
    if (!row) return key ?? '';
    // An empty column counts as "not translated yet" and falls through to
    // English, matching resolveString() and the PHP resolver. Plain ?? would
    // keep the empty string and leave the citizens with a blank card.
    const pick = (code) => (typeof row[code] === 'string' && row[code] !== '' ? row[code] : null);
    return pick(lang) ?? pick(DEFAULT_LANG) ?? key;
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
    } catch { /* first run / blocked storage */ }
}

function saveSettings() {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify({ players: state.players, spies: state.spies }));
    } catch { /* blocked storage */ }
}

function renderSetup() {
    $('playersValue').textContent = state.players;
    $('spiesValue').textContent = state.spies;

    $('playersMinus').disabled = state.players <= MIN_PLAYERS;
    $('playersPlus').disabled = state.players >= MAX_PLAYERS;

    const max = spyMax(state.players);
    $('spiesMinus').disabled = state.spies <= 1;
    $('spiesPlus').disabled = state.spies >= max;
    $('spiesHint').textContent = t('setup.spiesHint', { n: suggestedSpies(state.players), max });
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

// ------------------------------------------------------------------
//  The briefing card, shared by both modes
// ------------------------------------------------------------------

function assignRoles() {
    state.locationKey = pickLocation(locTable.locations)?.key ?? '';
    state.spyIndices = dealRoles(state.players, state.spies);
    state.revealIndex = 0;
    state.revealShown = false;
}

function startBriefing() {
    if (!locTable) {
        toast(t('toast.noLocations'));
        return;
    }
    mode = 'solo';
    assignRoles();
    showScreen('briefScreen');
    renderBriefCard();
}

/** The role face of the card, in the current language. */
function roleMarkup(isSpy, location, spyCount) {
    if (isSpy) {
        return `<div class="role-title">${t('brief.spyTitle')}</div>
            <p class="role-flavor">${t('brief.spyFlavor')}</p>`;
    }
    const el = document.createElement('div');
    el.textContent = location;
    return `<p class="role-kicker">${t('brief.locationKicker')}</p>
            <div class="role-location">${el.innerHTML}</div>
            <p class="role-flavor">${t('brief.citizenFlavor', { spyWord: spyWord(t, spyCount) })}</p>`;
}

function renderBriefCard() {
    const i = state.revealIndex;
    const isSpy = state.spyIndices.includes(i);
    const who = t('brief.playerN', { n: i + 1 });

    show('briefRoom', false);
    $('briefProgress').textContent = t('brief.progress', { n: i + 1, total: state.players });
    $('briefLockLabel').textContent = t('brief.passTo');
    $('briefAgent').textContent = who;
    $('briefAgentDone').textContent = who;
    $('briefDoneHint').textContent = t('brief.passOn');

    const role = $('briefRole');
    role.className = isSpy ? 'role-spy' : 'role-citizen';
    role.innerHTML = roleMarkup(isSpy, locationText(state.locationKey), state.spies);

    resetBriefCard();
    const nextBtn = $('briefNextBtn');
    nextBtn.classList.add('hidden');
    nextBtn.textContent = (i === state.players - 1) ? t('brief.startRound') : t('brief.next');
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

// ---------------- one-phone round and debrief ----------------

function renderSoloRoundChrome() {
    $('roundHud').textContent = t('round.hud', { players: state.players, spies: state.spies });
    $('pauseBtn').textContent = state.isPaused ? t('round.resume') : t('round.pause');
    $('endRoundBtn').textContent = t('round.end');
}

function startSoloRound() {
    showScreen('roundScreen');
    show('roundSignal', false);
    show('roundGuestNote', false);
    show('callVoteBox', false);
    show('roundControls', true);

    state.totalTime = state.players * 60;
    state.timeRemaining = state.totalTime;
    state.isPaused = false;

    renderSoloRoundChrome();
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
    } else {
        startTimerInterval();
    }
    $('pauseBtn').textContent = state.isPaused ? t('round.resume') : t('round.pause');
    paintTimer(state.timeRemaining, state.totalTime, state.isPaused);
}

function endSoloRound() {
    clearInterval(state.timer);
    state.timer = null;
    state.isPaused = false;
    showSoloDebrief();
}

function renderSoloDebriefChrome() {
    $('playAgainSub').textContent = t('debrief.subSolo', {
        players: state.players,
        spies: state.spies,
        spyWord: spyWord(t, state.spies),
    });
}

function showSoloDebrief() {
    showScreen('debriefScreen');
    show('declassifyResult', false);
    show('declassifyBtn', true);
    show('debriefSolo', true);
    show('verdictBlock', false);
    show('debriefSoloActions', true);
    show('debriefRoomActions', false);
    renderSoloDebriefChrome();
}

function declassify() {
    if (mode === 'room') {
        if (!reveal) return;
        $('resultSpies').textContent = reveal.spies.map((s) => s.name).join('  ·  ');
        $('resultLocation').textContent = reveal.location ?? '';
    } else {
        $('resultSpies').textContent = state.spyIndices
            .map((i) => t('brief.playerN', { n: i + 1 })).join('  ·  ');
        $('resultLocation').textContent = locationText(state.locationKey);
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
    $('gateTitle').textContent = joining ? t('gate.joinTitle') : t('gate.createTitle');
    $('gateLead').textContent = joining ? t('gate.joinLead') : t('gate.createLead');
    $('gateSubmitBtn').textContent = joining ? t('gate.joinBtn') : t('gate.createBtn');
    show('gateCodeField', joining);
    // Only the host chooses; joiners inherit whatever the room plays in.
    show('gateLangField', !joining);
    show('reclaimBox', false);
    gateError(null);

    try {
        $('gateName').value = localStorage.getItem(NAME_KEY) ?? '';
    } catch { /* blocked storage */ }
    const fromUrl = normalizeCode(new URLSearchParams(location.search).get('room') ?? '');
    if (joining && fromUrl) $('gateCode').value = fromUrl;
    if (!joining) $('gateLang').value = lang;

    showScreen('gateScreen');
}

function gateError(msg) {
    $('gateError').textContent = msg ?? '';
    show('gateError', Boolean(msg));
}

async function submitGate() {
    const name = cleanName($('gateName').value);
    if (!isValidName(name)) {
        gateError(t('gate.errName'));
        return;
    }
    const payload = { name };
    let code = '';
    if (gateKind === 'join') {
        code = normalizeCode($('gateCode').value);
        if (!isValidCode(code)) {
            gateError(t('gate.errCode'));
            return;
        }
        payload.code = code;
    } else {
        payload.lang = lang;
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
    gateError(res.body?.error ?? t('gate.errNet'));
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
        gateError(res.body?.error ?? t('gate.errRoom'));
        return;
    }
    const list = $('seatList');
    list.replaceChildren();
    for (const seat of res.body.players) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'seat' + (seat.reclaimable ? '' : ' seat-live');
        btn.disabled = !seat.reclaimable;
        const name = document.createElement('span');
        name.className = 'seat-name';
        name.textContent = seat.name;
        const stateEl = document.createElement('span');
        stateEl.className = 'seat-state';
        stateEl.textContent = seat.reclaimable ? t('gate.takeBack') : t('gate.inPlay');
        btn.append(name, stateEl);
        btn.addEventListener('click', () => reclaimSeat(code, seat));
        list.appendChild(btn);
    }
    show('reclaimBox', true);
}

async function reclaimSeat(code, seat) {
    const res = await post('reclaim', { code, playerId: seat.id });
    if (!res.ok) {
        gateError(res.body?.error ?? t('gate.errSeat'));
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
    pendingBallot = null;
    pendingCall = null;
    cardSignature = null;
    tallySignature = null;
    stopGraceClock();
    outbox.length = 0;
    failures = 0;
    clearRosterDom();

    // The room decides the language, so a joiner switches into it here.
    if (granted.room.lang) applyLang(granted.room.lang);

    $('codePlateValue').textContent = granted.code;
    $('codePlateHint').textContent = t('lobby.tapCopy');

    // Paint from what the grant already told us, so the lobby is not blank
    // for the length of a round-trip. The first poll replaces all of it.
    roomInfo = {
        code: granted.room.code,
        status: granted.room.status,
        lang: granted.room.lang ?? lang,
        spies: granted.room.spies ?? 1,
        roundSeconds: granted.room.roundSeconds ?? 300,
        secondsLeft: null,
        paused: false,
        seated: 1,
        endVotes: 0,
        endVotesNeeded: 1,
        ballots: 0,
    };
    players = [{
        id: granted.you.id, name, host: granted.you.host, ready: granted.you.ready,
        wantsEnd: false, voted: false, online: true,
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
    pendingBallot = null;
    pendingCall = null;
    tallySignature = null;
    stopGraceClock();
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
        leaveLocal(t('toast.roomClosed'));
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
        grace: graceBase !== null,
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
    const firstPoll = routedStatus === null;
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

    // Same shield for this player's own two flippable answers. Each clears the
    // moment the server agrees, so the snapshot takes over again as soon as it
    // is telling the truth.
    pendingBallot = holdPending(pendingBallot, 'votedFor');
    pendingCall = holdPending(pendingCall, 'wantsEnd');

    // The room owns the language, so a phone that resumed adopts it.
    // Normalize before comparing: measuring a raw server value against an
    // already-normalized local one means a language this client cannot
    // resolve never matches, and applyLang re-runs on every poll forever.
    const wanted = normalizeLang(roomInfo.lang, uiTable);
    if (wanted !== lang) applyLang(wanted);

    for (const op of ops) {
        if (op.op === 'deal') onDealt();
        else if (op.op === 'pause') toast(t('toast.paused'));
        else if (op.op === 'resume') toast(t('toast.resumed'));
        else if (op.op === 'host' && op.mine) toast(t('toast.hostLeft'));
    }
    // A resume seeds `you` with id 0, so the first poll always looks like a
    // promotion. Only a genuine change mid-session is worth announcing.
    if (!firstPoll && !wasHost && session.you.host && !ops.some((o) => o.op === 'host')) {
        toast(t('toast.nowHost'));
    }

    syncClock();
    syncGraceClock();
    routeRoom();
    renderRoom();
    return body.more === true;
}

/**
 * One optimistic answer held over an incoming snapshot. Returns the record to
 * keep: dropped once the server confirms the value or the wait runs out, so a
 * refusal we never heard about cannot pin the wrong answer on screen forever.
 */
function holdPending(pending, field) {
    if (!pending) return null;
    if (session.you[field] === pending.value) return null; // the server agrees
    if (Date.now() >= pending.until) return null;          // gave it long enough
    session.you[field] = pending.value;
    return pending;
}

function updateSignal() {
    const down = failures > 0;
    for (const id of ['lobbySignal', 'roundSignal', 'voteSignal']) {
        const el = $(id);
        el.textContent = down ? t('signal.down') : t('signal.ok');
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
    $('ballotList').replaceChildren();
}

/** `marks` picks which state tag a row carries, per screen. */
function renderRoster(container, marks) {
    syncById(container, players, () => {
        const row = document.createElement('div');
        row.className = 'roster-row';
        row.innerHTML = '<span class="roster-dot"></span>'
            + '<span class="roster-name"></span><span class="roster-tags"></span>';
        return row;
    }, (row, p) => {
        row.classList.toggle('is-offline', !p.online);
        row.classList.toggle('is-you', p.id === session.you.id);
        row.querySelector('.roster-name').textContent = p.name;

        const tags = row.querySelector('.roster-tags');
        tags.replaceChildren();
        const tag = (text, cls) => {
            const el = document.createElement('span');
            el.className = `roster-tag${cls ? ' ' + cls : ''}`;
            el.textContent = text;
            tags.appendChild(el);
        };
        if (p.host) tag(t('tag.host'));
        if (marks === 'ready' && p.ready) tag(t('tag.briefed'), 'ok');
        if (!p.online) tag(t('tag.away'), 'dim');
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
let tallySignature = null;  // which ballot graph is currently drawn

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
        show('callVoteBox', true);
    } else if (model.status === 'vote') {
        showScreen('voteScreen');
    } else if (model.status === 'debrief') {
        showScreen('debriefScreen');
        tallySignature = null; // a fresh debrief always draws its own graph
        show('declassifyResult', false);
        show('declassifyBtn', true);
        show('debriefSolo', false);
        show('verdictBlock', true);
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
    else if (model.status === 'vote') renderVote();
    else if (model.status === 'debrief') renderDebriefRoom();
}

function renderLobby() {
    $('codePlateValue').textContent = roomInfo.code;
    $('lobbyCount').textContent = players.length;
    renderRoster($('lobbyRoster'), null);

    const host = session.you.host;
    show('hostControls', host);
    show('guestWait', !host);

    const seated = players.length;
    const max = spyMax(seated);

    // Until the host sets it by hand, the round tracks the table the way the
    // one-phone game always has: a minute per player.
    if (host && !roundTouched) {
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
    $('roomSpiesHint').textContent = t('setup.spiesHint', { n: suggestedSpies(seated), max });
    $('roomSpiesMinus').disabled = roomInfo.spies <= 1;
    $('roomSpiesPlus').disabled = roomInfo.spies >= max;
    $('roomTimeMinus').disabled = roomInfo.roundSeconds <= MIN_ROUND_SECONDS;
    $('roomTimePlus').disabled = roomInfo.roundSeconds >= MAX_ROUND_SECONDS;

    const deal = $('roomDealBtn');
    deal.disabled = seated < MIN_PLAYERS;
    deal.textContent = seated < MIN_PLAYERS
        ? t('lobby.needMore', { n: MIN_PLAYERS - seated })
        : t('lobby.deal');

    const hostName = players.find((p) => p.host)?.name ?? t('lobby.theHost');
    $('hostNameWait').textContent = t('lobby.waitingFor', { name: hostName.toUpperCase() });
    $('guestSettings').textContent = t('lobby.summary', {
        seated,
        spies: roomInfo.spies,
        spyWord: spyWord(t, roomInfo.spies),
        clock: formatClock(roomInfo.roundSeconds),
    });
}

function renderBriefRoom() {
    const isSpy = session.you.role === 'spy';
    const signature = `${lang}|${session.you.role}|${session.you.location ?? ''}|${roomInfo.spies}`;
    if (signature !== cardSignature) {
        cardSignature = signature;
        $('briefProgress').textContent = t('brief.yours');
        $('briefLockLabel').textContent = t('brief.eyesOnly');
        $('briefAgent').textContent = session.name.toUpperCase();
        $('briefAgentDone').textContent = session.name.toUpperCase();
        $('briefDoneHint').textContent = t('brief.sitTight');
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
    $('briefTally').textContent = t('brief.tally', { n: ready, total: players.length });
    renderRoster($('briefRoster'), 'ready');

    const allReady = players.length > 0 && ready === players.length;
    show('briefStartBtn', session.you.host);
    show('briefWait', !session.you.host);
    $('briefStartBtn').textContent = allReady
        ? t('brief.startRound')
        : t('brief.startAnyway', { n: ready, total: players.length });
}

function renderRoundRoom() {
    $('roundHud').textContent = t('round.hud', { players: players.length, spies: roomInfo.spies });
    show('roundControls', session.you.host);
    show('roundGuestNote', !session.you.host);
    $('pauseBtn').textContent = roomInfo.paused ? t('round.resume') : t('round.pause');
    $('endRoundBtn').textContent = t('round.end');

    // The call to vote: a public tally so the table can watch agreement form.
    const wanted = roomInfo.endVotes ?? 0;
    const needed = roomInfo.endVotesNeeded ?? endVoteThreshold(players.length);
    $('callVoteBtn').textContent = session.you.wantsEnd ? t('round.retractVote') : t('round.callVote');
    $('callVoteBtn').classList.toggle('is-on', Boolean(session.you.wantsEnd));
    $('callVoteTally').textContent = t('round.voteTally', { n: wanted, total: needed });
    $('callVoteFill').style.width = `${clamp((wanted / Math.max(1, needed)) * 100, 0, 100)}%`;
}

/**
 * The ballot. Everyone picks at the same time and the page shows only how
 * many have voted, never for whom, which is the entire reason the phase
 * exists: nobody has to accuse anyone out loud first.
 */
function renderVote() {
    const candidates = players.filter((p) => p.id !== session.you.id);
    syncById($('ballotList'), candidates, () => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ballot-row';
        btn.innerHTML = '<span class="ballot-mark" aria-hidden="true"></span>'
            + '<span class="ballot-name"></span><span class="ballot-state"></span>';
        return btn;
    }, (btn, p) => {
        const picked = session.you.votedFor === p.id;
        btn.classList.toggle('is-picked', picked);
        btn.classList.toggle('is-offline', !p.online);
        btn.setAttribute('aria-pressed', picked ? 'true' : 'false');
        btn.querySelector('.ballot-name').textContent = p.name;
        btn.querySelector('.ballot-state').textContent = p.voted ? t('tag.voted') : '';
        btn.onclick = () => castVote(p.id);
    });

    const cast = players.filter((p) => p.voted).length;
    $('voteTally').textContent = t('vote.cast', { n: cast, total: players.length });
    show('closeVoteBtn', session.you.host);

    // Every seated ballot is in, so the room is closing on a countdown rather
    // than the instant the last tap landed. Rows stay tappable throughout:
    // switching now is the whole reason the countdown exists, and it restarts
    // the clock for everybody.
    const closing = graceBase !== null;
    show('voteGrace', closing);
    if (closing) paintGraceClock();
    // The hint under the ballot changes meaning once the room is closing, so
    // it is repainted here rather than left to its data-i18n default: the
    // countdown can be disarmed again by a late switch, and the stale line
    // would otherwise still invite a change nobody is waiting for.
    $('voteWait').textContent = closing && hasString(uiTable, 'vote.graceHint')
        ? t('vote.graceHint')
        : t('vote.waiting');
    show('voteWait', closing || !session.you.host);
}

// ---------------- the vote's own countdown ----------------

/**
 * Interpolated locally between polls, exactly like the round clock, so the
 * number ticks smoothly on a screen that only hears from the server every
 * fraction of a second. graceLeft is a separate field from secondsLeft
 * because the round clock drives a progress bar scaled to roundSeconds.
 */
function syncGraceClock() {
    const left = roomInfo && roomInfo.status === 'vote' ? roomInfo.graceLeft ?? null : null;
    if (left === null) {
        stopGraceClock();
        return;
    }
    graceBase = { left, at: Date.now() };
    if (!graceTimer) graceTimer = setInterval(paintGraceClock, 250);
}

function stopGraceClock() {
    graceBase = null;
    clearInterval(graceTimer);
    graceTimer = null;
}

function paintGraceClock() {
    if (!graceBase) return;
    const left = Math.max(0, graceBase.left - Math.floor((Date.now() - graceBase.at) / 1000));
    // Every other string on the page ships its English in the markup, so a
    // table that cannot say it is invisible. These two are written from
    // scratch by JS and have nothing to fall back on, and t() returns the raw
    // key for a row it does not have: a tab opened before the row existed
    // would print "vote.grace" at people. A bare number says the same thing in
    // every language, so degrade to that rather than to a key.
    $('voteGrace').textContent = hasString(uiTable, 'vote.grace')
        ? t('vote.grace', { n: left })
        : String(left);
}

function castVote(targetId) {
    if (session.you.votedFor === targetId) return;
    // Paint at once and hold it over the next snapshot: a poll already in
    // flight still believes the old pick, and letting it win here is what made
    // a changed vote look like it had been ignored.
    session.you.votedFor = targetId;
    pendingBallot = { value: targetId, until: Date.now() + 2500 };
    // The server restarts the countdown for this ballot, so restart it here
    // too rather than letting the old deadline keep ticking down until the
    // confirming poll. Otherwise switching at "CLOSING IN 1" shows a 0 right
    // after the tap that just bought the table ten more seconds, which is the
    // same "it ignored me" the pending shields exist to prevent.
    if (graceBase !== null) graceBase = { left: VOTE_GRACE_SECONDS, at: Date.now() };
    queueEvent('castvote', { target: targetId });
    renderVote();
}

function renderDebriefRoom() {
    const host = session.you.host;
    show('roomAgainBtn', host);
    show('roomLobbyBtn', host);
    show('debriefWait', !host);
    $('roomAgainSub').textContent = t('debrief.subSolo', {
        players: players.length,
        spies: roomInfo.spies,
        spyWord: spyWord(t, roomInfo.spies),
    });

    if (!reveal) return;
    const agentsWon = reveal.outcome === 'agents';
    const verdict = $('verdict');
    verdict.classList.toggle('is-agents', agentsWon);
    verdict.classList.toggle('is-spies', !agentsWon);
    $('verdictTitle').textContent = agentsWon ? t('outcome.agentsWin') : t('outcome.spiesWin');
    $('verdictSub').textContent = agentsWon ? t('outcome.agentsWinSub') : t('outcome.spiesWinSub');
    $('verdictAccused').textContent = reveal.accused?.name ?? t('debrief.noAccused');

    // The ballots, readable at last. Bars are drawn against the largest
    // count so a runaway winner still reads as one.
    //
    // Only redrawn when the figures actually change, for the same reason the
    // brief card is: the debrief keeps polling, and rebuilding these nodes
    // every couple of seconds threw away whatever the reader was looking at.
    const signature = JSON.stringify([
        reveal.tally, reveal.accused?.id ?? null, reveal.spies.map((sp) => sp.id),
    ]);
    if (signature === tallySignature) return;
    tallySignature = signature;

    const top = Math.max(1, ...reveal.tally.map((row) => row.votes));
    const chart = $('tallyChart');
    chart.replaceChildren();
    for (const row of reveal.tally) {
        const line = document.createElement('div');
        line.className = 'tally-row';
        if (reveal.accused && row.id === reveal.accused.id) line.classList.add('is-accused');
        if (reveal.spies.some((s) => s.id === row.id)) line.classList.add('is-spy');

        const name = document.createElement('span');
        name.className = 'tally-name';
        name.textContent = row.name;
        const bar = document.createElement('span');
        bar.className = 'tally-bar';
        const fill = document.createElement('span');
        fill.className = 'tally-fill';
        fill.style.width = `${(row.votes / top) * 100}%`;
        bar.appendChild(fill);
        const count = document.createElement('span');
        count.className = 'tally-count';
        count.textContent = row.votes;

        line.append(name, bar, count);
        chart.appendChild(line);
    }
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
        hint.textContent = t('lobby.linkCopied');
    } catch {
        hint.textContent = `[ ${session.code} ]`;
    }
    clearTimeout(copyCode.t);
    copyCode.t = setTimeout(() => { hint.textContent = t('lobby.tapCopy'); }, 1800);
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
            you: { id: 0, host: false, ready: false, wantsEnd: false, votedFor: null, role: null, location: null },
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

async function init() {
    loadSettings();

    // The tables decide what the page can say, so nothing else runs until
    // they land. The markup ships English, so a failure here is survivable.
    try {
        await loadTables();
        let saved = DEFAULT_LANG;
        try {
            saved = localStorage.getItem(LANG_KEY) ?? DEFAULT_LANG;
        } catch { /* blocked storage */ }
        applyLang(saved);
        buildLangPicker();
    } catch {
        applyLang(DEFAULT_LANG);
    }
    renderSetup();

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
    // Picking the language repaints the page at once, so the host sees what
    // the room will look like before committing to it.
    $('gateLang').addEventListener('change', (e) => {
        applyLang(e.target.value);
        openGate(gateKind);
    });
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
    $('callVoteBtn').addEventListener('click', () => {
        // Paint the flip at once; the poll confirms and carries the tally.
        session.you.wantsEnd = !session.you.wantsEnd;
        pendingCall = { value: session.you.wantsEnd, until: Date.now() + 2500 };
        queueEvent('callvote');
        renderRoundRoom();
    });

    // The ballot
    $('closeVoteBtn').addEventListener('click', () => queueEvent('closevote'));

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
