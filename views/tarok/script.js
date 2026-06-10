// ===========================================================================
// Tarok scorekeeper
//
// Single source of truth: `rounds`, an array of RAW per-round inputs. Scores and
// radelci are never mutated incrementally; they are a pure function of `rounds`
// via computeState(). That is what makes editing/deleting any round correct: we
// just change `rounds` and replay. The replay order below is identical to the
// old incremental addRound() so the scoring math is unchanged.
// ===========================================================================

const HIGH_GAMES = ['berac', 'solo_brez', 'barvni_valat', 'valat', 'klop'];
const NO_PLAYER_GAMES = ['berac'];
const STORAGE_KEY = 'tarok:game:v1';
const API = '../../app/proxys/tarok.php';

let playerCount = 4;
let players = [];
let rounds = [];                 // raw: { gameType, playingPlayer, outcome, baseScores: [] }
let gameId = null;
let createdAt = null;

let currentOutcome = 'win';      // outcome currently selected in the input form
let editingGrid = false;         // true while inline-editing the score cells in the table
let isSnapshot = false;          // true while viewing a read-only shared game
let isShared = false;            // true once this game has been shared: changes auto-resync

let state = { radelci: [], scores: [], meta: [] }; // recomputed view of `rounds`

// ---------------------------------------------------------------------------
// Pure scoring
// ---------------------------------------------------------------------------
function computeState(rounds, playerCount) {
    let radelci = Array(playerCount).fill(0);
    let scores = Array.from({ length: playerCount }, () => []);
    let meta = [];

    rounds.forEach(r => {
        const isHighGame = HIGH_GAMES.includes(r.gameType);
        const isNoPlayerGame = NO_PLAYER_GAMES.includes(r.gameType);

        let finalScores = r.baseScores.slice();
        let useRadelc = false;
        let radelcConsumed = false;

        // A player with a radelc available doubles their points this round.
        if (!isNoPlayerGame && r.playingPlayer >= 0 && radelci[r.playingPlayer] > 0) {
            useRadelc = true;
            finalScores[r.playingPlayer] = finalScores[r.playingPlayer] * 2;
            if (r.outcome === 'win') {
                radelcConsumed = true; // a radelc is spent only on a win
            }
        }

        // A lost game subtracts the points from everyone.
        if (r.outcome === 'loss') {
            finalScores = finalScores.map(s => -Math.abs(s));
        }

        finalScores.forEach((s, i) => scores[i].push(s));

        // High games hand a radelc to every player (capped at 3)...
        if (isHighGame) {
            radelci = radelci.map(c => Math.min(c + 1, 3));
        }
        // ...and a used-and-won radelc is then consumed.
        if (radelcConsumed) {
            radelci[r.playingPlayer] = Math.max(radelci[r.playingPlayer] - 1, 0);
        }

        meta.push({
            gameType: r.gameType,
            playingPlayer: r.playingPlayer,
            outcome: r.outcome,
            useRadelc,
            radelcConsumed,
            isHighGame,
            isNoPlayerGame
        });
    });

    return { radelci, scores, meta };
}

function recompute() {
    state = computeState(rounds, playerCount);
}

function render() {
    recompute();
    updateScoresTable();
    updateRadelciDisplay();
    updateRoundCounter();
    updateControls();
}

// ---------------------------------------------------------------------------
// Setup screen
// ---------------------------------------------------------------------------
document.querySelectorAll('.count-btn').forEach(btn => {
    btn.addEventListener('click', function () {
        document.querySelectorAll('.count-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        playerCount = parseInt(this.dataset.count);
        updatePlayerInputs();
    });
});

function updatePlayerInputs() {
    const container = document.getElementById('playerInputs');
    container.innerHTML = '';
    for (let i = 0; i < playerCount; i++) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'player-input';
        input.placeholder = `Igralec ${i + 1}`;
        input.maxLength = 15;
        container.appendChild(input);
    }
}

function syncCountButtons() {
    document.querySelectorAll('.count-btn').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.count) === playerCount);
    });
}

function prefillSetupNames() {
    syncCountButtons();
    updatePlayerInputs();
    const inputs = document.querySelectorAll('.player-input');
    players.forEach((name, i) => { if (inputs[i]) inputs[i].value = name; });
}

function startGame() {
    const inputs = document.querySelectorAll('.player-input');
    const entered = [];

    for (let i = 0; i < playerCount; i++) {
        const name = inputs[i].value.trim();
        if (!name) {
            alert(`Vnesi ime za igralca ${i + 1}`);
            return;
        }
        entered.push(name);
    }

    if (new Set(entered).size !== entered.length) {
        alert('Vsa imena morajo biti različna');
        return;
    }

    players = entered;
    createdAt = Date.now();
    gameId = makeGameId(players, createdAt);
    rounds = [];
    editingGrid = false;
    currentOutcome = 'win';
    isSnapshot = false;
    isShared = false;

    pingCleanup(); // a new game is being played: prune shared games older than 7 days
    enterGameScreen();
    persist();
}

// ---------------------------------------------------------------------------
// Game screen plumbing
// ---------------------------------------------------------------------------
function enterGameScreen() {
    setupPlayerSelector();
    setupScoreInputs();
    recompute();
    updateTableHeader();
    selectOutcome(currentOutcome);
    onGameTypeChange();
    editingGrid = false;

    document.getElementById('roundInputSection').classList.remove('hidden');
    document.getElementById('gameControls').classList.remove('hidden');
    document.getElementById('snapshotBanner').classList.add('hidden');

    document.getElementById('setupScreen').style.display = 'none';
    document.getElementById('gameScreen').style.display = 'block';

    render();
}

function setupPlayerSelector() {
    const playerSelect = document.getElementById('playingPlayer');
    playerSelect.innerHTML = '';
    players.forEach((player, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = player;
        playerSelect.appendChild(option);
    });
}

function setupScoreInputs() {
    const container = document.getElementById('scoresGrid');
    container.innerHTML = '';
    players.forEach((player, index) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'score-input-wrapper';

        const label = document.createElement('label');
        label.textContent = player;
        label.htmlFor = `score-${index}`;

        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'score-input';
        input.id = `score-${index}`;
        input.placeholder = '0';
        input.inputMode = 'numeric';
        input.pattern = '[0-9]*';

        wrapper.appendChild(label);
        wrapper.appendChild(input);
        container.appendChild(wrapper);
    });
}

function updateTableHeader() {
    const header = document.getElementById('tableHeader');
    header.innerHTML = '<th>#</th>';
    players.forEach((player, index) => {
        const th = document.createElement('th');
        th.innerHTML = `
            <div class="header-player">
                <span class="header-player-name">${escapeHtml(player)}</span>
                <span class="header-radelci" id="header-radelci-${index}">
                    ${getRadelciStarsHTML(index)}
                </span>
            </div>`;
        header.appendChild(th);
    });
}

function getRadelciStarsHTML(playerIndex) {
    const count = state.radelci[playerIndex] || 0;
    let html = '';
    for (let i = 0; i < 3; i++) {
        html += i < count
            ? '<span class="radelc-star">★</span>'
            : '<span class="radelc-star empty">☆</span>';
    }
    return html;
}

function updateRadelciDisplay() {
    players.forEach((player, index) => {
        const container = document.getElementById(`header-radelci-${index}`);
        if (container) container.innerHTML = getRadelciStarsHTML(index);
    });
}

function onGameTypeChange() {
    const gameType = document.getElementById('gameType').value;
    const playerSelectGroup = document.getElementById('playerSelectGroup');
    playerSelectGroup.style.display = NO_PLAYER_GAMES.includes(gameType) ? 'none' : 'block';
}

function selectOutcome(outcome) {
    currentOutcome = outcome;
    document.querySelectorAll('.outcome-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelector(`[data-outcome="${outcome}"]`).classList.add('active');
}

function toggleScoringHelp() {
    document.getElementById('scoringHelpContent').classList.toggle('open');
    document.getElementById('scoringHelpArrow').classList.toggle('open');
}

// ---------------------------------------------------------------------------
// Scores table
// ---------------------------------------------------------------------------
function updateScoresTable() {
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '';

    for (let round = 0; round < rounds.length; round++) {
        const row = document.createElement('tr');

        const roundCell = document.createElement('td');
        roundCell.className = 'round-cell';
        roundCell.textContent = round + 1;
        row.appendChild(roundCell);

        const meta = state.meta[round];
        players.forEach((player, playerIndex) => {
            const cell = document.createElement('td');

            if (editingGrid) {
                // Inline edit: show the raw points originally entered for this
                // player; win/loss and radelc are re-derived on save.
                const input = document.createElement('input');
                input.type = 'number';
                input.className = 'grid-edit-input';
                input.id = `grid-${round}-${playerIndex}`;
                input.value = rounds[round].baseScores[playerIndex] ?? 0;
                input.inputMode = 'numeric';
                cell.appendChild(input);
                row.appendChild(cell);
                return;
            }

            const score = state.scores[playerIndex][round];
            if (score !== undefined && score !== null) {
                if (meta && meta.useRadelc && meta.playingPlayer === playerIndex) {
                    cell.innerHTML = `${score}<span class="radelc-indicator">★</span>`;
                } else if (meta && meta.isHighGame) {
                    cell.innerHTML = `${score}<span class="radelc-indicator">☆</span>`;
                } else {
                    cell.textContent = score;
                }
            } else {
                cell.textContent = '-';
            }
            row.appendChild(cell);
        });

        tbody.appendChild(row);
    }

    const totalRow = document.createElement('tr');
    totalRow.className = 'total-row';
    const totalLabel = document.createElement('td');
    totalLabel.innerHTML = '<strong>∑</strong>';
    totalRow.appendChild(totalLabel);

    players.forEach((player, playerIndex) => {
        const totalCell = document.createElement('td');
        const total = state.scores[playerIndex].reduce((sum, s) => sum + (s || 0), 0);
        const cls = total > 0 ? 'total-pos' : (total < 0 ? 'total-neg' : '');
        totalCell.innerHTML = `<strong class="${cls}">${total}</strong>`;
        totalRow.appendChild(totalCell);
    });

    tbody.appendChild(totalRow);
}

function updateRoundCounter() {
    const next = rounds.length + 1;
    const chip = document.getElementById('roundNumber');
    if (chip) chip.textContent = isSnapshot ? rounds.length : next;


}

// Toolbar button states. While the grid is being inline-edited, every other
// action is disabled so nothing can mutate `rounds` out from under the edit.
function updateControls() {
    const noRounds = rounds.length === 0;
    setDisabled('undoBtn', editingGrid || noRounds);
    setDisabled('shareBtn', editingGrid);
    setDisabled('newGameBtn', editingGrid);
    setDisabled('submitRoundBtn', editingGrid);

    const editBtn = document.getElementById('editBtn');
    if (editBtn) {
        editBtn.disabled = !editingGrid && noRounds;
        editBtn.textContent = editingGrid ? '💾 Shrani' : '✎ Uredi';
        editBtn.classList.toggle('editing', editingGrid);
    }
}

function setDisabled(id, disabled) {
    const el = document.getElementById(id);
    if (el) el.disabled = !!disabled;
}

// ---------------------------------------------------------------------------
// Add / edit / undo
// ---------------------------------------------------------------------------
function readRoundInputs() {
    const gameType = document.getElementById('gameType').value;
    const isNoPlayerGame = NO_PLAYER_GAMES.includes(gameType);
    const sel = document.getElementById('playingPlayer');
    const playingPlayer = (!isNoPlayerGame && sel.value !== '') ? parseInt(sel.value) : -1;

    const baseScores = [];
    for (let i = 0; i < playerCount; i++) {
        baseScores.push(parseInt(document.getElementById(`score-${i}`).value) || 0);
    }
    return { gameType, playingPlayer, outcome: currentOutcome, baseScores };
}

function submitRound() {
    if (editingGrid) return;          // not while inline-editing the grid
    rounds.push(readRoundInputs());
    clearRoundInputs();
    render();
    persist();
    syncShared();
}

// Inline grid editing. The Edit button toggles every score cell into a number
// input pre-filled with the raw points originally entered (win/loss negation
// and radelc doubling are re-applied automatically). Save writes the values
// straight back into each round's baseScores and replays from there, so this
// only ever corrects a mistyped number; the scoring logic is untouched.
function toggleGridEdit() {
    if (!editingGrid) {
        if (rounds.length === 0) return;
        editingGrid = true;
        render();
        document.getElementById('scoresTable').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
        saveGridEdit();
    }
}

function saveGridEdit() {
    for (let round = 0; round < rounds.length; round++) {
        for (let p = 0; p < playerCount; p++) {
            const el = document.getElementById(`grid-${round}-${p}`);
            if (el) rounds[round].baseScores[p] = parseInt(el.value) || 0;
        }
    }
    editingGrid = false;
    render();
    persist();
    syncShared();
}

function undoLastRound() {
    if (rounds.length === 0 || editingGrid) return;
    rounds.pop();
    render();
    persist();
    syncShared();
}

function clearRoundInputs() {
    for (let i = 0; i < playerCount; i++) {
        const el = document.getElementById(`score-${i}`);
        if (el) el.value = '';
    }
}

function newGame() {
    rounds = [];
    editingGrid = false;
    gameId = null;
    createdAt = null;
    isSnapshot = false;
    isShared = false;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }

    document.getElementById('gameScreen').style.display = 'none';
    document.getElementById('setupScreen').style.display = 'block';
    prefillSetupNames();
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function gameObject() {
    return { playerCount, players, rounds, gameId, createdAt, shared: isShared };
}

function persist() {
    if (isSnapshot) return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(gameObject()));
    } catch (e) { /* storage full or unavailable: ignore */ }
}

function loadFromStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const g = JSON.parse(raw);
        if (!g || !Array.isArray(g.players) || !Array.isArray(g.rounds)) return null;
        return g;
    } catch (e) {
        return null;
    }
}

function restoreGame(g) {
    playerCount = g.playerCount || g.players.length;
    players = g.players;
    rounds = g.rounds || [];
    createdAt = g.createdAt || Date.now();
    gameId = g.gameId || makeGameId(players, createdAt);
    editingGrid = false;
    isSnapshot = false;
    isShared = !!g.shared;
    enterGameScreen();
}

// ---------------------------------------------------------------------------
// Share + shared snapshot
// ---------------------------------------------------------------------------
// cyrb53: tiny, fast, dependency-free string hash. Works in any context (no
// secure-context requirement, unlike crypto.subtle), and base36 output matches
// the server-side id sanitizer ([a-z0-9]).
function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function makeGameId(players, createdAt) {
    return cyrb53(players.join('|') + '|' + createdAt).toString(36);
}

async function shareGame() {
    const btn = document.getElementById('shareBtn');
    btn.disabled = true;
    btn.classList.add('loading');

    try {
        const res = await fetch(`${API}?action=save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(gameObject())
        });
        if (!res.ok) throw new Error('save failed');
        const data = await res.json();
        const url = `${location.origin}${location.pathname}?game=${data.id}`;
        await copyToClipboard(url);
        isShared = true;
        persist();
        showToast('Povezava kopirana ✓ Posodobitve se delijo sproti');
    } catch (e) {
        showToast('Deljenje ni uspelo');
    } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
    }
}

// Once a game has been shared, push the latest state to the server on every
// change so anyone viewing the link only needs to refresh. Fire-and-forget.
function syncShared() {
    if (!isShared || isSnapshot || !gameId) return;
    try {
        fetch(`${API}?action=save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(gameObject()),
            keepalive: true
        }).catch(() => {});
    } catch (e) { /* ignore */ }
}

async function loadSharedGame(id) {
    isSnapshot = true;
    isShared = false;
    editingGrid = false;
    try {
        const res = await fetch(`${API}?action=load&id=${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error('not found');
        const g = await res.json();
        if (!g || !Array.isArray(g.players) || !Array.isArray(g.rounds)) throw new Error('bad data');

        playerCount = g.playerCount || g.players.length;
        players = g.players;
        rounds = g.rounds;
        gameId = g.gameId || id;
        renderSnapshot();
    } catch (e) {
        isSnapshot = false;
        updatePlayerInputs();
        document.getElementById('setupScreen').style.display = 'block';
        document.getElementById('gameScreen').style.display = 'none';
        showToast('Deljena igra ni bila najdena');
    }
}

function renderSnapshot() {
    document.getElementById('setupScreen').style.display = 'none';
    document.getElementById('gameScreen').style.display = 'block';
    document.getElementById('roundInputSection').classList.add('hidden');
    document.getElementById('gameControls').classList.add('hidden');

    const banner = document.getElementById('snapshotBanner');
    banner.classList.remove('hidden');
    document.getElementById('snapshotPlayers').textContent = players.join(' · ');

    updateTableHeader();
    render();
}

// Snapshot's "start your own" navigates away from the share link, which lets the
// normal init restore any local game in progress instead of clobbering it.
function startOwnGame() {
    window.location.href = window.location.pathname;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
function pingCleanup() {
    try {
        fetch(`${API}?action=cleanup`, { method: 'GET', keepalive: true }).catch(() => {});
    } catch (e) { /* ignore */ }
}

async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return;
        }
    } catch (e) { /* fall through to legacy path */ }

    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
}

let toastTimer = null;
function showToast(msg) {
    let el = document.getElementById('toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* ignored */ });
}

function init() {
    const sharedId = new URLSearchParams(window.location.search).get('game');
    if (sharedId) {
        loadSharedGame(sharedId);
        return;
    }
    const stored = loadFromStorage();
    if (stored) {
        restoreGame(stored);
        return;
    }
    updatePlayerInputs();
}

init();
