let playerCount = 4;
let players = [];
let scores = []; // Array of arrays: scores[playerIndex][round] = score
let radelci = []; // Array to track radelci count per player (max 3)
let roundHistory = []; // Track game type, radelc usage, etc. for each round
let currentRound = 1;
let gameEnded = false;
let currentOutcome = 'win';

// Game types that give radelci to all players
const HIGH_GAMES = ['berac', 'solo_brez', 'barvni_valat', 'valat', 'klop'];

// Game types where no one is playing (everyone plays for themselves)
const NO_PLAYER_GAMES = ['berac'];

// Player count selection
document.querySelectorAll('.count-btn').forEach(btn => {
    btn.addEventListener('click', function() {
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

function startGame() {
    const inputs = document.querySelectorAll('.player-input');
    players = [];

    for (let i = 0; i < playerCount; i++) {
        const name = inputs[i].value.trim();
        if (!name) {
            alert(`Vnesi ime za igralca ${i + 1}`);
            return;
        }
        players.push(name);
    }

    // Check for duplicate names
    const uniqueNames = [...new Set(players)];
    if (uniqueNames.length !== players.length) {
        alert('Vsa imena morajo biti različna');
        return;
    }

    initializeGame();
}

function initializeGame() {
    scores = players.map(() => []);
    radelci = players.map(() => 0); // Initialize with 0 radelci
    roundHistory = [];
    currentRound = 1;
    gameEnded = false;
    currentOutcome = 'win';

    setupGameScreen();
    updateTableHeader();

    document.getElementById('setupScreen').style.display = 'none';
    document.getElementById('gameScreen').style.display = 'block';
    document.getElementById('winnerAnnouncement').style.display = 'none';
}

function setupGameScreen() {
    // Setup player selector
    const playerSelect = document.getElementById('playingPlayer');
    playerSelect.innerHTML = '';
    players.forEach((player, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = player;
        playerSelect.appendChild(option);
    });

    // Setup score inputs
    setupScoreInputs();

    // Reset outcome buttons
    selectOutcome('win');

    // Attach event listeners
    document.getElementById('gameType').addEventListener('change', onGameTypeChange);

    // Initial check for game type
    onGameTypeChange();
    updateScoresTable();
}

function updateTableHeader() {
    // Setup table header with player names and radelci
    const header = document.getElementById('tableHeader');
    header.innerHTML = '<th>#</th>';
    
    players.forEach((player, index) => {
        const th = document.createElement('th');
        th.innerHTML = `
            <div class="header-player">
                <span class="header-player-name">${player}</span>
                <span class="header-radelci" id="header-radelci-${index}">
                    ${getRadelciStarsHTML(index)}
                </span>
            </div>
        `;
        header.appendChild(th);
    });
}

function getRadelciStarsHTML(playerIndex) {
    let html = '';
    for (let i = 0; i < 3; i++) {
        if (i < radelci[playerIndex]) {
            html += '<span class="radelc-star">★</span>';
        } else {
            html += '<span class="radelc-star empty">☆</span>';
        }
    }
    return html;
}

function updateRadelciDisplay() {
    // Update radelci stars in table header
    players.forEach((player, index) => {
        const container = document.getElementById(`header-radelci-${index}`);
        if (container) {
            container.innerHTML = getRadelciStarsHTML(index);
        }
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
        input.value = '0';
        input.inputMode = 'numeric';
        input.pattern = '[0-9]*';

        wrapper.appendChild(label);
        wrapper.appendChild(input);
        container.appendChild(wrapper);
    });
}

function onGameTypeChange() {
    const gameType = document.getElementById('gameType').value;
    const playerSelectGroup = document.getElementById('playerSelectGroup');
    const isNoPlayerGame = NO_PLAYER_GAMES.includes(gameType);

    if (isNoPlayerGame) {
        playerSelectGroup.style.display = 'none';
    } else {
        playerSelectGroup.style.display = 'block';
    }
}

function selectOutcome(outcome) {
    currentOutcome = outcome;
    document.querySelectorAll('.outcome-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`[data-outcome="${outcome}"]`).classList.add('active');
}

function toggleScoringHelp() {
    const content = document.getElementById('scoringHelpContent');
    const arrow = document.getElementById('scoringHelpArrow');
    
    content.classList.toggle('open');
    arrow.classList.toggle('open');
}

function updateScoresTable() {
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '';

    // Add all completed rounds
    const maxRounds = Math.max(...scores.map(s => s.length));
    
    for (let round = 0; round < maxRounds; round++) {
        const row = document.createElement('tr');

        const roundCell = document.createElement('td');
        roundCell.textContent = round + 1;
        row.appendChild(roundCell);

        players.forEach((player, playerIndex) => {
            const cell = document.createElement('td');
            const score = scores[playerIndex][round];
            if (score !== undefined && score !== null) {
                let displayText = score;
                // Check if this round used radelc
                const history = roundHistory[round];
                if (history && history.useRadelc && history.playingPlayer === playerIndex) {
                    cell.innerHTML = displayText + '<span class="radelc-indicator">★</span>';
                } else if (history && history.isHighGame) {
                    cell.innerHTML = displayText + '<span class="radelc-indicator">☆</span>';
                } else {
                    cell.textContent = displayText;
                }
            } else {
                cell.textContent = '-';
            }
            row.appendChild(cell);
        });

        tbody.appendChild(row);
    }

    // Add total row
    const totalRow = document.createElement('tr');
    totalRow.className = 'total-row';

    const totalLabel = document.createElement('td');
    totalLabel.innerHTML = '<strong>∑</strong>';
    totalRow.appendChild(totalLabel);

    players.forEach((player, playerIndex) => {
        const totalCell = document.createElement('td');
        const total = scores[playerIndex].reduce((sum, score) => sum + (score || 0), 0);
        totalCell.innerHTML = `<strong>${total}</strong>`;
        totalRow.appendChild(totalCell);
    });

    tbody.appendChild(totalRow);

    // Update round counter
    document.getElementById('roundNumber').textContent = currentRound;
    document.getElementById('currentRound').textContent = currentRound;
}

function addRound() {
    if (gameEnded) return;

    const gameType = document.getElementById('gameType').value;
    const playingPlayerSelect = document.getElementById('playingPlayer');
    const playingPlayerIndex = playingPlayerSelect.value ? parseInt(playingPlayerSelect.value) : -1;
    const isHighGame = HIGH_GAMES.includes(gameType);
    const isNoPlayerGame = NO_PLAYER_GAMES.includes(gameType);

    // Get scores from inputs
    const roundScores = [];
    for (let i = 0; i < playerCount; i++) {
        const input = document.getElementById(`score-${i}`);
        const value = parseInt(input.value) || 0;
        roundScores.push(value);
    }

    // Start with base scores (no multipliers)
    let finalScores = [...roundScores];

    // Determine if radelc is used
    let useRadelc = false;
    let radelcConsumed = false;

    if (!isNoPlayerGame && playingPlayerIndex >= 0 && radelci[playingPlayerIndex] > 0) {
        // Player has radelci - use one automatically
        useRadelc = true;
        finalScores = finalScores.map(score => score * 2);

        // Radelc is consumed only if the player wins
        if (currentOutcome === 'win') {
            radelcConsumed = true;
        }
    }

    // Apply outcome (win/loss)
    if (currentOutcome === 'loss') {
        // Loss: playing player gets negative, others get positive
        if (!isNoPlayerGame && playingPlayerIndex >= 0) {
            finalScores = finalScores.map((score, idx) => {
                if (idx === playingPlayerIndex) {
                    return -Math.abs(score);
                }
                return Math.abs(score);
            });
        }
    }

    // Add scores to each player
    players.forEach((player, index) => {
        scores[index].push(finalScores[index]);
    });

    // Award radelci for high games (max 3 per player)
    if (isHighGame) {
        radelci = radelci.map(count => Math.min(count + 1, 3));
    }

    // Consume radelc if used and won
    if (radelcConsumed) {
        radelci[playingPlayerIndex] = Math.max(radelci[playingPlayerIndex] - 1, 0);
    }

    // Store round history
    roundHistory.push({
        gameType: gameType,
        playingPlayer: playingPlayerIndex,
        useRadelc: useRadelc,
        radelcConsumed: radelcConsumed,
        outcome: currentOutcome,
        isHighGame: isHighGame,
        isNoPlayerGame: isNoPlayerGame
    });

    currentRound++;

    // Clear inputs
    for (let i = 0; i < playerCount; i++) {
        document.getElementById(`score-${i}`).value = '0';
    }

    updateRadelciDisplay();
    updateScoresTable();
}

function newGame() {
    document.getElementById('setupScreen').style.display = 'block';
    document.getElementById('gameScreen').style.display = 'none';

    // Reset setup screen
    document.querySelectorAll('.player-input').forEach((input, index) => {
        input.value = players[index] || '';
    });
}

// Initialize with 4 players
updatePlayerInputs();
