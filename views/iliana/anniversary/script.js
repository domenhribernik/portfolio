// iliana/anniversary — a sealed envelope that unlocks at midnight as June 18 begins,
// then opens into an animated love letter with falling hearts. Mirrors the parent
// view's login + countdown patterns (see ../script.js).

const config = {
    passwords: {
        'cHJldHR5cGxlYXNl': 'Iliana',
        'c3RheXByZXNlbnQ=': 'Domen'
    },
    // Local midnight at the start of June 18, 2026.
    unlockDate: new Date('2026-06-18T00:00:00').getTime(),
};

// ?preview=1 force-unlocks the reveal so Domen can rehearse it before the day.
const isPreview = new URLSearchParams(location.search).get('preview') === '1';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let countdownTimer = null;
let hasOpened = false;

// === Login / Logout (same gate as the parent iliana page) ===

function login() {
    const password = document.getElementById('passwordInput').value;
    const encoded = btoa(password);

    if (config.passwords[encoded]) {
        sessionStorage.setItem('iliana_auth', config.passwords[encoded]);
        enterApp();
    } else {
        const err = document.getElementById('errorMessage');
        err.style.display = 'block';
        setTimeout(() => { err.style.display = 'none'; }, 3000);
    }
}

function enterApp() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('mainApp').classList.add('show');
    initReveal();
}

// === Reveal logic ===

const mainApp = () => document.getElementById('mainApp');

function setState(state) {
    const el = mainApp();
    el.classList.remove('is-locked', 'is-unlocked', 'is-opened');
    el.classList.add(state);
}

function isUnlocked() {
    return isPreview || Date.now() >= config.unlockDate;
}

function initReveal() {
    const envelope = document.getElementById('envelope');

    envelope.addEventListener('click', () => {
        if (hasOpened) return;
        if (isUnlocked()) {
            openEnvelope();
        } else {
            // Still sealed — a playful nudge, nothing more.
            envelope.classList.remove('shake');
            void envelope.offsetWidth; // restart the animation
            envelope.classList.add('shake');
        }
    });

    document.getElementById('readAgainBtn').addEventListener('click', replay);

    tick();
    countdownTimer = setInterval(tick, 1000);
}

// Runs every second: refreshes the countdown and flips locked -> unlocked.
function tick() {
    if (isUnlocked()) {
        setState('is-unlocked');
        if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
        }
        return;
    }

    setState('is-locked');

    const distance = config.unlockDate - Date.now();
    const days    = Math.floor(distance / (1000 * 60 * 60 * 24));
    const hours   = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((distance % (1000 * 60)) / 1000);

    document.getElementById('days').textContent    = days;
    document.getElementById('hours').textContent   = hours;
    document.getElementById('minutes').textContent = minutes;
    document.getElementById('seconds').textContent = seconds;
}

function openEnvelope() {
    hasOpened = true;
    setState('is-opened');
    spawnHearts();

    // After the flap swings open, bring the letter into view and reveal it.
    const flapDelay = reduceMotion ? 0 : 650;
    setTimeout(() => {
        const letter = document.getElementById('letter');
        letter.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
        revealLetter();
    }, flapDelay);
}

function revealLetter() {
    const blocks = document.querySelectorAll('#letterBody > *');
    const readAgain = document.getElementById('readAgainBtn');

    if (reduceMotion) {
        blocks.forEach(b => b.classList.add('reveal'));
        readAgain.classList.add('show');
        return;
    }

    blocks.forEach((block, i) => {
        setTimeout(() => block.classList.add('reveal'), 250 + i * 900);
    });
    setTimeout(() => readAgain.classList.add('show'), 250 + blocks.length * 900);
}

function replay() {
    // Reset the letter blocks, then re-run the open sequence.
    document.querySelectorAll('#letterBody > *').forEach(b => b.classList.remove('reveal'));
    document.getElementById('readAgainBtn').classList.remove('show');
    hasOpened = false;
    setState('is-unlocked');
    // Let the flap close visually for a beat before opening again.
    setTimeout(openEnvelope, reduceMotion ? 0 : 400);
}

// === Falling hearts ===

function spawnHearts() {
    if (reduceMotion) return;
    const field = document.getElementById('heartField');
    const glyphs = ['❤', '💕', '💖', '🤍', '💗'];
    const colors = ['#ff9fb0', '#ffb3c1', '#ff7a90', '#ffc2cc'];
    const count = 26;

    for (let i = 0; i < count; i++) {
        const heart = document.createElement('span');
        heart.className = 'falling-heart';
        heart.textContent = glyphs[Math.floor(Math.random() * glyphs.length)];
        heart.style.left = Math.random() * 100 + 'vw';
        heart.style.fontSize = (14 + Math.random() * 24) + 'px';
        heart.style.setProperty('--fall-duration', (5 + Math.random() * 4) + 's');
        heart.style.setProperty('--drift', (Math.random() * 160 - 80) + 'px');
        heart.style.setProperty('--heart-opacity', (0.6 + Math.random() * 0.4).toFixed(2));
        heart.style.setProperty('--heart-color', colors[Math.floor(Math.random() * colors.length)]);
        heart.style.animationDelay = (Math.random() * 1.5) + 's';
        heart.addEventListener('animationend', () => heart.remove());
        field.appendChild(heart);
    }
}

// === Boot ===

document.getElementById('passwordInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') login();
});

// Skip the login screen if already authed in this tab, or when previewing.
if (sessionStorage.getItem('iliana_auth') || isPreview) {
    enterApp();
}
