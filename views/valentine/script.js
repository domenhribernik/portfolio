// Game Configuration
const HER_NAME = "Iliana";
const ANNIVERSARY_DATE = "18";

// Rules Configuration
const rules = [
    {
        id: 1,
        text: "Password must be at least 8 characters",
        validate: (pwd) => pwd.length >= 8
    },
    {
        id: 2,
        text: "Password must contain a number",
        validate: (pwd) => /\d/.test(pwd)
    },
    {
        id: 3,
        text: `Password must include the word "love"`,
        validate: (pwd) => /love/i.test(pwd)
    },
    {
        id: 4,
        text: "Password must have a special character (!@#$%^&*)",
        validate: (pwd) => /[!@#$%^&*(),.?":{}|<>]/.test(pwd)
    },
    {
        id: 5,
        text: `Password must include our anniversary (${ANNIVERSARY_DATE})`,
        validate: (pwd) => pwd.includes(ANNIVERSARY_DATE)
    },
    {
        id: 6,
        text: `Password must contain your name "${HER_NAME}"`,
        validate: (pwd) => new RegExp(HER_NAME, 'i').test(pwd)
    },
    {
        id: 7,
        text: "Password must have an uppercase letter",
        validate: (pwd) => /[A-Z]/.test(pwd)
    },
    {
        id: 8,
        text: "Password must contain the number 67",
        validate: (pwd) => pwd.includes("67")
    },
    {
        id: 9,
        text: "Password must end with 'forever'",
        validate: (pwd) => /forever$/i.test(pwd)
    },
    {
        id: 10,
        text: "Password must include a space",
        validate: (pwd) => /\s/.test(pwd)
    },
    {
        id: 11,
        text: "Password must be exactly: i<3u",
        validate: (pwd) => pwd === "i<3u",
        isFinal: true
    }
];

let currentRule = 0;
let revealedRules = []; // Track which rules have been revealed

// DOM Elements
const passwordInput = document.getElementById('password');
const submitBtn = document.getElementById('submit');
const rulesList = document.getElementById('rulesList');
const finalScreen = document.getElementById('final-screen');
const yesBtn = document.getElementById('yesBtn');
const noBtn = document.getElementById('noBtn');

// Initialize Background Emojis
function createBackgroundEmojis() {
    const container = document.getElementById('heartsBg');
    const emojis = ['💕', '💖', '💗', '💓', '✨', '🌟', '💝', '♥️', '😍', '💘'];
    
    for (let i = 0; i < 20; i++) {
        const emoji = document.createElement('div');
        emoji.className = 'floating-emoji';
        emoji.style.left = Math.random() * 100 + '%';
        emoji.style.animationDuration = (10 + Math.random() * 8) + 's';
        emoji.style.animationDelay = Math.random() * 5 + 's';
        emoji.style.fontSize = (16 + Math.random() * 20) + 'px';
        emoji.innerHTML = emojis[Math.floor(Math.random() * emojis.length)];
        container.appendChild(emoji);
    }
}

// Render Rules - shows all revealed rules with their current status
function renderRules() {
    rulesList.innerHTML = '';
    
    for (let i = 0; i <= currentRule && i < rules.length; i++) {
        const rule = rules[i];
        const ruleEl = document.createElement('div');
        ruleEl.className = 'rule';
        ruleEl.style.animationDelay = (i * 0.05) + 's';
        
        // Check if this rule is currently satisfied
        const isValid = rule.validate(passwordInput.value);
        
        if (isValid && i < currentRule) {
            ruleEl.classList.add('completed');
        } else if (!isValid) {
            ruleEl.classList.add('active');
        } else if (i === currentRule && isValid) {
            // Current rule just passed
            ruleEl.classList.add('completed');
        }
        
        ruleEl.innerHTML = `
            <span class="rule-number">${isValid && i < currentRule ? '✓' : i + 1}</span>
            <span class="rule-text">${rule.text}</span>
        `;
        
        rulesList.appendChild(ruleEl);
    }
}

// Check Password - validates all revealed rules
function checkPassword() {
    const input = passwordInput.value;
    
    // Hardcoded Romantic Bypass
    if (input === "i<3u") {
        showFinalScreen();
        return;
    }
    
    // Check all revealed rules (0 to currentRule)
    let allPassed = true;
    
    for (let i = 0; i <= currentRule && i < rules.length; i++) {
        if (!rules[i].validate(input)) {
            allPassed = false;
            // If a previous rule failed, shake and stop
            if (i < currentRule) {
                passwordInput.classList.add('error');
                setTimeout(() => {
                    passwordInput.classList.remove('error');
                }, 500);
                renderRules(); // Update colors to show which one failed
                return;
            }
        }
    }
    
    if (allPassed) {
        // All current revealed rules passed, reveal next
        currentRule++;
        renderRules();
        passwordInput.value = '';
        passwordInput.focus();
    } else {
        // Current rule failed
        passwordInput.classList.add('error');
        setTimeout(() => {
            passwordInput.classList.remove('error');
        }, 500);
    }
}

// Live validation as typing
function validateLive() {
    const input = passwordInput.value;
    
    // If typing the secret code, don't interfere
    if (input === "i<3u") return;
    
    // Re-render to update colors based on current validity
    if (currentRule > 0 || passwordInput.value.length > 0) {
        renderRules();
    }
}

// Show Final Screen
function showFinalScreen() {
    finalScreen.classList.add('visible');
    // Confetti starts only on Yes click now
}

// Confetti Effect
function launchConfetti() {
    const canvas = document.getElementById('confetti-canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    
    const particles = [];
    const colors = ['#ffc2cc', '#ffb3c1', '#ff85a2', '#6bcf7f', '#ffd93d', '#ff6b9d', '#c44569'];
    
    for (let i = 0; i < 150; i++) {
        particles.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height - canvas.height,
            color: colors[Math.floor(Math.random() * colors.length)],
            size: Math.random() * 8 + 4,
            speed: Math.random() * 3 + 2,
            angle: Math.random() * 360,
            rotation: Math.random() * 0.2 - 0.1,
            wobble: Math.random() * Math.PI * 2
        });
    }
    
    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        particles.forEach((p, index) => {
            p.y += p.speed;
            p.wobble += 0.05;
            p.x += Math.sin(p.wobble) * 2;
            p.angle += p.rotation;
            
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.angle);
            ctx.fillStyle = p.color;
            
            // Draw heart shape or square
            if (index % 2 === 0) {
                // Heart
                const size = p.size;
                ctx.beginPath();
                ctx.moveTo(0, -size/2);
                ctx.bezierCurveTo(size/2, -size, size, -size/2, 0, size);
                ctx.bezierCurveTo(-size, -size/2, -size/2, -size, 0, -size/2);
                ctx.fill();
            } else {
                // Square/confetti
                ctx.fillRect(-p.size/2, -p.size/2, p.size, p.size);
            }
            ctx.restore();
            
            if (p.y > canvas.height) {
                p.y = -20;
                p.x = Math.random() * canvas.width;
            }
        });
        
        requestAnimationFrame(animate);
    }
    animate();
}

// Event Listeners
submitBtn.addEventListener('click', checkPassword);

passwordInput.addEventListener('input', validateLive);

passwordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') checkPassword();
});

// Valentine Button Logic
yesBtn.addEventListener('click', () => {
    yesBtn.textContent = "Yay! 💖🎉";
    yesBtn.style.transform = "scale(1.1)";
    yesBtn.style.background = "var(--success-green)";
    launchConfetti();
    
    // Create floating hearts from the button
    for (let i = 0; i < 5; i++) {
        setTimeout(() => {
            const heart = document.createElement('div');
            heart.textContent = '💖';
            heart.style.position = 'fixed';
            heart.style.left = (yesBtn.getBoundingClientRect().left + yesBtn.offsetWidth/2) + 'px';
            heart.style.top = (yesBtn.getBoundingClientRect().top) + 'px';
            heart.style.fontSize = '24px';
            heart.style.pointerEvents = 'none';
            heart.style.zIndex = '102';
            heart.style.animation = 'float-up 2s ease-out forwards';
            document.body.appendChild(heart);
            setTimeout(() => heart.remove(), 2000);
        }, i * 100);
    }
});

noBtn.addEventListener('click', () => {
    // Playful "No" button - moves away
    const x = Math.random() * 200 - 100;
    const y = Math.random() * 100 - 50;
    noBtn.style.transform = `translate(${x}px, ${y}px)`;
    noBtn.textContent = "Try again? 😉";
    
    // Make yes button bigger
    yesBtn.style.transform = "scale(1.2)";
    setTimeout(() => {
        yesBtn.style.transform = "scale(1)";
    }, 300);
});

// Initialize
createBackgroundEmojis();
renderRules();

// Focus input on load
setTimeout(() => passwordInput.focus(), 500);