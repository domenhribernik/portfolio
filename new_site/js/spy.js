let gameState = {
    playerCount: 3,
    currentLocation: '',
    spyIndex: -1,
    revealedCards: 0,
    viewedCards: 0,
    gameTimer: null,
    timeRemaining: 0
};

const locations = [
    'Airport', 'Bank', 'Beach', 'Casino', 'Circus', 'Embassy',
    'Hospital', 'Hotel', 'Movie Theater', 'Museum', 'Restaurant',
    'School', 'Space Station', 'Submarine', 'Supermarket', 'Theater',
    'University', 'Zoo', 'Pirate Ship', 'Polar Station', 'Oil Rig',
    'Carnival', 'Day Spa', 'Forest', 'Passenger Train', 'Art Gallery'
];

function showPlayerSelection() {
    document.getElementById('titleScreen').style.display = 'none';
    document.getElementById('playerSelection').style.display = 'block';
    updatePlayerCountDisplay();
}

function scrollToTop() {
  window.scrollTo({
    top: 0,
    behavior: 'smooth'
  });
}

function changePlayerCount(change) {
    const newCount = gameState.playerCount + change;
    if (newCount >= 3 && newCount <= 20) {
        gameState.playerCount = newCount;
        updatePlayerCountDisplay();
    }
}

function updatePlayerCountDisplay() {
    document.getElementById('playerCountDisplay').textContent = gameState.playerCount;

    // Update button states
    document.getElementById('decreaseBtn').disabled = gameState.playerCount <= 3;
    document.getElementById('increaseBtn').disabled = gameState.playerCount >= 20;
}

function setupRoles() {
    // Hide player selection
    document.getElementById('playerSelection').style.display = 'none';
    document.getElementById('roleCards').style.display = 'block';

    // Choose random location and spy
    gameState.currentLocation = locations[Math.floor(Math.random() * locations.length)];
    gameState.spyIndex = Math.floor(Math.random() * gameState.playerCount);
    gameState.revealedCards = 0;
    gameState.viewedCards = 0;

    // Create player cards
    const container = document.getElementById('playerCardsContainer');
    container.innerHTML = '';

    for (let i = 0; i < gameState.playerCount; i++) {
        const card = document.createElement('div');
        card.className = 'player-card';
        card.innerHTML = `
                    <div class="player-name">Player ${i + 1}</div>
                    <div class="role-content" id="role-${i}">
                        ${i === gameState.spyIndex ?
                `<div class="role-title spy-role">🕵️ YOU ARE THE SPY!</div>
                                <p>You don't know the location. Ask questions to figure it out without revealing yourself!</p>` :
                `<div class="role-title location-role">🏛️ CITIZEN</div>
                                <div class="location-name">${gameState.currentLocation}</div>
                                <p>You know the location. Find the spy who doesn't!</p>`
            }
                    </div>
                    <p id="reveal-text-${i}">👀 Tap to reveal your role</p>
                    <button class="close-btn" onclick="closeRole(${i})">×</button>
                `;

        card.onclick = (e) => {
            if (!e.target.classList.contains('close-btn')) {
                revealRole(i);
            }
        };
        container.appendChild(card);
    }
}

function revealRole(playerIndex) {
    const card = document.querySelector(`#playerCardsContainer .player-card:nth-child(${playerIndex + 1})`);
    const roleContent = document.getElementById(`role-${playerIndex}`);
    const revealText = document.getElementById(`reveal-text-${playerIndex}`);

    if (!card.classList.contains('revealed') && !card.classList.contains('viewed')) {
        roleContent.classList.add('visible');
        revealText.style.display = 'none';
        card.classList.add('revealed');
        card.onclick = null;

        gameState.revealedCards++;
        gameState.viewedCards++;

        // Check if all players have viewed their roles (not necessarily currently open)
        if (gameState.viewedCards === gameState.playerCount) {
            setTimeout(() => {
                document.getElementById('startGameBtn').classList.remove('hidden');
            }, 500);
        }
    }
}

function closeRole(playerIndex) {
    const card = document.querySelector(`#playerCardsContainer .player-card:nth-child(${playerIndex + 1})`);
    const roleContent = document.getElementById(`role-${playerIndex}`);
    const revealText = document.getElementById(`reveal-text-${playerIndex}`);

    if (card.classList.contains('revealed')) {
        roleContent.classList.remove('visible');
        revealText.style.display = 'block';
        revealText.textContent = '🔒 Role already viewed';
        revealText.style.opacity = '0.6';
        card.classList.remove('revealed');
        card.classList.add('viewed');
        // Remove click functionality - card can't be opened again
        card.onclick = null;
    }
}

function startGame() {
    document.getElementById('roleCards').style.display = 'none';
    document.getElementById('gameScreen').style.display = 'block';
    document.getElementById('gamePlayerCount').textContent = gameState.playerCount;

    // Start timer (1 minute per player)
    gameState.timeRemaining = gameState.playerCount * 60;
    updateTimerDisplay();

    gameState.gameTimer = setInterval(() => {
        gameState.timeRemaining--;
        updateTimerDisplay();
        updateTimerBar();

        if (gameState.timeRemaining <= 0) {
            endGame();
        }
    }, 1000);
}

function updateTimerDisplay() {
    const minutes = Math.floor(gameState.timeRemaining / 60);
    const seconds = gameState.timeRemaining % 60;
    const display = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    document.getElementById('timerDisplay').textContent = display;

    // Add pulse effect when time is running low
    if (gameState.timeRemaining <= 30) {
        document.getElementById('timerDisplay').classList.add('pulse');
        document.getElementById('timerDisplay').style.color = '#ef4444';
    }
}

function updateTimerBar() {
    const totalTime = gameState.playerCount * 60;
    const progress = ((totalTime - gameState.timeRemaining) / totalTime) * 100;
    document.getElementById('timerProgress').style.width = progress + '%';
}

function endGame() {
    if (gameState.gameTimer) {
        clearInterval(gameState.gameTimer);
        gameState.gameTimer = null;
    }

    document.getElementById('gameScreen').style.display = 'none';
    document.getElementById('gameOverScreen').classList.remove('hidden');
    document.getElementById('gameOverScreen').style.display = 'block';
}

function restartGame() {
    gameState = {
        playerCount: 3,
        currentLocation: '',
        spyIndex: -1,
        revealedCards: 0,
        viewedCards: 0,
        gameTimer: null,
        timeRemaining: 0
    };

    // Reset UI
    document.getElementById('gameOverScreen').style.display = 'none';
    document.getElementById('titleScreen').style.display = 'block';

    // Reset timer display
    document.getElementById('timerDisplay').classList.remove('pulse');
    document.getElementById('timerDisplay').style.color = '#06b6d4';
    document.getElementById('timerProgress').style.width = '0%';

    // Clear player cards
    document.getElementById('playerCardsContainer').innerHTML = '';
    document.getElementById('startGameBtn').classList.add('hidden');
}