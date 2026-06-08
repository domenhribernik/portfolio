/* ============================================================
   SPY // CLASSIFIED  —  game logic
   Pass-and-play deception game. 100% client-side, no backend.
   State machine: boot -> setup -> brief -> round -> debrief
   ============================================================ */

// Everyday places (so a spy can plausibly bluff) plus a few wild ones.
const LOCATIONS = [
    // everyday
    'Supermarket', 'Restaurant', 'Coffee Shop', 'Bank', 'Gas Station',
    'Pharmacy', 'Public Library', 'Gym', 'Barbershop', "Dentist's Office",
    'Hospital', 'School', 'University', 'Cinema', 'Shopping Mall',
    'Hotel', 'Beach', 'City Park', 'Zoo', 'Museum',
    'Art Gallery', 'Pub', 'Nightclub', 'Stadium', 'Airport',
    'Train Station', 'Subway Station', 'City Bus', 'Wedding', 'Cathedral',
    'Bakery', 'Bowling Alley', 'Theme Park', 'Aquarium', 'Car Wash',
    'Police Station', 'Fire Station', 'Office Party', 'Farm', 'Campsite',
    'Ski Resort', 'Casino', 'Cruise Ship',
    // wild
    'Space Station', 'Submarine', 'Pirate Ship', 'Polar Research Station',
    'Oil Rig', 'Military Base', 'Circus', 'Embassy', 'Medieval Castle',
    'Film Studio'
];

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 20;
const LS_KEY = 'spy:lastSettings';

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

/* ---------------- helpers ---------------- */

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const spyMax = (players) => Math.max(1, Math.floor(players / 2)); // never more than half
const suggestedSpies = (players) => clamp(Math.round(players / 4), 1, spyMax(players));

function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(id).classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

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

/* ---------------- setup ---------------- */

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

/* ---------------- role assignment ---------------- */

function assignRoles() {
    state.location = LOCATIONS[Math.floor(Math.random() * LOCATIONS.length)];

    const idx = Array.from({ length: state.players }, (_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    state.spyIndices = idx.slice(0, state.spies).sort((a, b) => a - b);

    state.revealIndex = 0;
    state.revealShown = false;
}

/* ---------------- briefing / pass-around ---------------- */

function startBriefing() {
    assignRoles();
    showScreen('briefScreen');
    renderBriefCard();
}

function renderBriefCard() {
    const i = state.revealIndex;
    const isSpy = state.spyIndices.includes(i);
    const spyWord = state.spies > 1 ? 'spies' : 'spy';

    $('briefProgress').textContent = `PLAYER ${i + 1} / ${state.players}`;
    $('briefAgent').textContent = `PLAYER ${i + 1}`;
    $('briefAgentDone').textContent = `PLAYER ${i + 1}`;

    const role = $('briefRole');
    if (isSpy) {
        role.className = 'role-spy';
        role.innerHTML = `
            <div class="role-title">YOU ARE A SPY</div>
            <p class="role-flavor">You don't know the location. Work it out from what others say,
                blend in, and don't get caught.</p>`;
    } else {
        role.className = 'role-citizen';
        role.innerHTML = `
            <p class="role-kicker">YOUR LOCATION</p>
            <div class="role-location">${state.location}</div>
            <p class="role-flavor">Prove you belong here. Smoke out the ${spyWord} who can't.</p>`;
    }

    const card = $('briefCard');
    card.classList.remove('is-revealed', 'is-done');
    state.revealShown = false;

    const nextBtn = $('briefNextBtn');
    nextBtn.classList.add('hidden');
    nextBtn.textContent = (i === state.players - 1) ? '▶ START ROUND' : '▶ NEXT PLAYER';
}

function toggleBriefCard() {
    const card = $('briefCard');
    if (card.classList.contains('is-done')) return; // locked once hidden

    if (!state.revealShown) {
        state.revealShown = true;
        card.classList.add('is-revealed');
    } else {
        // hide before allowing pass-on, so the next person can't peek
        state.revealShown = false;
        card.classList.remove('is-revealed');
        card.classList.add('is-done');
        $('briefNextBtn').classList.remove('hidden');
    }
}

function nextAgent() {
    if (state.revealIndex < state.players - 1) {
        state.revealIndex++;
        renderBriefCard();
    } else {
        startRound();
    }
}

/* ---------------- round / timer ---------------- */

function startRound() {
    showScreen('roundScreen');
    $('roundAgentCount').textContent = state.players;
    $('roundSpyCount').textContent = state.spies;

    state.totalTime = state.players * 60;
    state.timeRemaining = state.totalTime;
    state.isPaused = false;

    $('pauseBtn').textContent = '❚❚ PAUSE';
    $('pauseNote').hidden = true;
    $('timerDisplay').classList.remove('low', 'paused');
    $('timerProgress').classList.remove('low');

    updateTimerDisplay();
    updateTimerBar();
    startTimerInterval();
}

function startTimerInterval() {
    clearInterval(state.timer);
    state.timer = setInterval(tick, 1000);
}

function tick() {
    state.timeRemaining--;
    updateTimerDisplay();
    updateTimerBar();
    if (state.timeRemaining <= 0) endRound();
}

function updateTimerDisplay() {
    const m = Math.floor(state.timeRemaining / 60);
    const s = state.timeRemaining % 60;
    $('timerDisplay').textContent =
        `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    const low = state.timeRemaining <= 30 && state.timeRemaining > 0 && !state.isPaused;
    $('timerDisplay').classList.toggle('low', low);
}

function updateTimerBar() {
    const pct = ((state.totalTime - state.timeRemaining) / state.totalTime) * 100;
    $('timerProgress').style.width = `${pct}%`;
    $('timerProgress').classList.toggle('low', state.timeRemaining <= 30);
}

function togglePause() {
    if (state.isPaused) {
        state.isPaused = false;
        $('pauseBtn').textContent = '❚❚ PAUSE';
        $('pauseNote').hidden = true;
        $('timerDisplay').classList.remove('paused');
        startTimerInterval();
    } else {
        state.isPaused = true;
        clearInterval(state.timer);
        $('pauseBtn').textContent = '▶ RESUME';
        $('pauseNote').hidden = false;
        $('timerDisplay').classList.add('paused');
        $('timerDisplay').classList.remove('low');
    }
}

function endRound() {
    clearInterval(state.timer);
    state.timer = null;
    state.isPaused = false;
    showDebrief();
}

/* ---------------- debrief / end ---------------- */

function showDebrief() {
    showScreen('debriefScreen');
    $('declassifyResult').classList.add('hidden');
    $('declassifyBtn').classList.remove('hidden');
    const spyWord = state.spies > 1 ? 'spies' : 'spy';
    $('playAgainSub').textContent = `(${state.players} players · ${state.spies} ${spyWord})`;
}

function declassify() {
    $('resultSpies').textContent =
        state.spyIndices.map((i) => `PLAYER ${i + 1}`).join('  ·  ');
    $('resultLocation').textContent = state.location;
    $('declassifyResult').classList.remove('hidden');
    $('declassifyBtn').classList.add('hidden');
}

/* ---------------- navigation ---------------- */

function goToSetup() {
    renderSetup();
    showScreen('setupScreen');
}

function deploy() {
    saveSettings();
    startBriefing();
}

function playAgainSame() {
    startBriefing(); // re-rolls location + spies, jumps straight to pass-around
}

function changeSettings() {
    renderSetup();
    showScreen('setupScreen');
}

function mainMenu() {
    showScreen('bootScreen');
}

/* ---------------- wiring ---------------- */

function init() {
    loadSettings();
    renderSetup();

    $('initiateBtn').addEventListener('click', goToSetup);

    $('playersMinus').addEventListener('click', () => changePlayers(-1));
    $('playersPlus').addEventListener('click', () => changePlayers(1));
    $('spiesMinus').addEventListener('click', () => changeSpies(-1));
    $('spiesPlus').addEventListener('click', () => changeSpies(1));
    $('deployBtn').addEventListener('click', deploy);
    $('setupBackBtn').addEventListener('click', mainMenu);

    const card = $('briefCard');
    card.addEventListener('click', toggleBriefCard);
    card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleBriefCard();
        }
    });
    $('briefNextBtn').addEventListener('click', nextAgent);

    $('pauseBtn').addEventListener('click', togglePause);
    $('endRoundBtn').addEventListener('click', endRound);

    $('declassifyBtn').addEventListener('click', declassify);
    $('playAgainBtn').addEventListener('click', playAgainSame);
    $('changeSettingsBtn').addEventListener('click', changeSettings);
    $('mainMenuBtn').addEventListener('click', mainMenu);
}

document.addEventListener('DOMContentLoaded', init);
