let playerCount = 4;
let players = [];
let scores = [];
let currentRound = 1;
let gameEnded = false;

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
        input.placeholder = `Player ${i + 1} Name`;
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
            alert(`Please enter a name for Player ${i + 1}`);
            return;
        }
        players.push(name);
    }

    // Check for duplicate names
    const uniqueNames = [...new Set(players)];
    if (uniqueNames.length !== players.length) {
        alert('Please use unique names for all players');
        return;
    }

    initializeGame();
}

function initializeGame() {
    scores = players.map(() => []);
    currentRound = 1;
    gameEnded = false;

    setupGameScreen();

    document.getElementById('setupScreen').style.display = 'none';
    document.getElementById('gameScreen').style.display = 'block';
    document.getElementById('winnerAnnouncement').style.display = 'none';
}

function setupGameScreen() {
    // Setup table header
    const header = document.getElementById('tableHeader');
    header.innerHTML = '<th>Round</th>';
    players.forEach(player => {
        const th = document.createElement('th');
        th.textContent = player;
        header.appendChild(th);
    });

    // Setup round input
    const roundInput = document.getElementById('roundInput');
    roundInput.innerHTML = `
        <div style="width: 100%; text-align: center; margin-bottom: 1rem;">
            <strong>Enter scores for Round <span id="currentRound">1</span>:</strong>
        </div>
    `;

    players.forEach((player, index) => {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'score-input';
        input.placeholder = player;
        input.id = `score-${index}`;
        roundInput.appendChild(input);
    });

    updateScoresTable();
}

function updateScoresTable() {
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '';

    // Add all completed rounds
    for (let round = 0; round < Math.max(...scores.map(s => s.length)); round++) {
        const row = document.createElement('tr');

        const roundCell = document.createElement('td');
        roundCell.textContent = round + 1;
        row.appendChild(roundCell);

        players.forEach((player, playerIndex) => {
            const cell = document.createElement('td');
            cell.textContent = scores[playerIndex][round] || '-';
            row.appendChild(cell);
        });

        tbody.appendChild(row);
    }

    // Add total row
    const totalRow = document.createElement('tr');
    totalRow.className = 'total-row';

    const totalLabel = document.createElement('td');
    totalLabel.innerHTML = '<strong>Total</strong>';
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

    const roundScores = [];

    for (let i = 0; i < playerCount; i++) {
        const input = document.getElementById(`score-${i}`);
        const value = parseInt(input.value) || 0;
        roundScores.push(value);
    }

    // Add scores to each player
    players.forEach((player, index) => {
        scores[index].push(roundScores[index]);
    });

    currentRound++;

    // Clear inputs
    for (let i = 0; i < playerCount; i++) {
        document.getElementById(`score-${i}`).value = '';
    }

    updateScoresTable();

    // // Check for winner (game typically ends at 500 points)
    // checkForWinner();
}

// function checkForWinner() {
//     const totals = scores.map(playerScores =>
//         playerScores.reduce((sum, score) => sum + score, 0)
//     );

//     const maxScore = Math.max(...totals);

//     if (maxScore >= 500) {
//         gameEnded = true;
//         const winnerIndex = totals.indexOf(maxScore);
//         const winner = players[winnerIndex];

//         document.getElementById('winnerText').textContent =
//             `${winner} wins with ${maxScore} points!`;
//         document.getElementById('winnerAnnouncement').style.display = 'block';

//         // Hide round input
//         document.getElementById('roundInput').style.display = 'none';
//     }
// }

function newGame() {
    document.getElementById('setupScreen').style.display = 'block';
    document.getElementById('gameScreen').style.display = 'none';
    document.getElementById('roundInput').style.display = 'flex';

    // Reset setup screen
    document.querySelectorAll('.player-input').forEach((input, index) => {
        input.value = players[index] || '';
    });
}

// Initialize with 4 players
updatePlayerInputs();
