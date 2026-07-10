import { CLASSES, QUESTIONS, scoreQuiz, toRoman } from './logic.js';

/* ══════════ The Oracle (quiz) ══════════ */

const quizEl = document.getElementById('quiz');
let answers = []; // chosen answer id per question index

function renderQuestion(index) {
    const q = QUESTIONS[index];
    const pips = QUESTIONS.map((_, i) =>
        `<span class="progress-pip ${i < index ? 'filled' : ''}"></span>`
    ).join('');

    quizEl.innerHTML = `
        <div class="quiz-screen">
            <div class="flex items-center justify-between gap-4">
                <p class="text-xs uppercase tracking-[0.28em] text-dim">
                    Question ${toRoman(index + 1)} of ${toRoman(QUESTIONS.length)}
                </p>
                <div class="flex gap-2">${pips}</div>
            </div>
            <h3 class="font-display text-3xl sm:text-4xl mt-5 text-parch">${q.prompt}</h3>
            <div class="mt-7 space-y-3">
                ${q.answers.map(a =>
                    `<button class="quiz-answer" data-answer="${a.id}">${a.text}</button>`
                ).join('')}
            </div>
            ${index > 0
                ? `<button data-back class="mt-6 bg-transparent border-0 cursor-pointer text-dim hover:text-gold transition-colors text-sm tracking-wide font-body">&larr; previous question</button>`
                : ''}
        </div>`;

    quizEl.querySelectorAll('[data-answer]').forEach(btn => {
        btn.addEventListener('click', () => {
            answers[index] = btn.dataset.answer;
            answers.length = index + 1;
            if (index + 1 < QUESTIONS.length) renderQuestion(index + 1);
            else renderResult();
        });
    });
    quizEl.querySelector('[data-back]')?.addEventListener('click', () => renderQuestion(index - 1));
}

function classChips(cls) {
    return `
        <div class="flex flex-wrap gap-2 text-xs uppercase tracking-wider">
            <span class="border border-gold/30 text-gold/90 px-2.5 py-1 rounded-sm">${cls.ability}</span>
            <span class="border border-gold/30 text-gold/90 px-2.5 py-1 rounded-sm">Hit die ${cls.hitDie}</span>
            <span class="border border-gold/30 text-gold/90 px-2.5 py-1 rounded-sm" title="How much there is to learn">
                ${'<i class="fas fa-fire"></i>'.repeat(cls.complexity)}${'<i class="fas fa-fire opacity-25"></i>'.repeat(3 - cls.complexity)}
            </span>
        </div>`;
}

function renderResult() {
    const ranked = scoreQuiz(answers);
    const top = CLASSES[ranked[0].id];
    const runners = [ranked[1], ranked[2]].map(r => CLASSES[r.id]);

    quizEl.innerHTML = `
        <div class="result-reveal text-center">
            <p class="text-xs uppercase tracking-[0.35em] text-gold/80">The dice have spoken</p>
            <i class="fas ${top.icon} text-5xl text-gold mt-6"></i>
            <h3 class="font-display text-6xl sm:text-7xl mt-3 text-transparent bg-clip-text bg-gradient-to-b from-parch via-gold to-[#8a5a1c]">${top.name}</h3>
            <p class="text-gold/90 italic text-lg mt-1">${top.epithet}</p>
            <p class="max-w-md mx-auto mt-5 text-parch/90">${top.blurb}</p>
            <div class="flex justify-center mt-6">${classChips(top)}</div>
            <div class="max-w-md mx-auto mt-6 text-left border border-gold/20 rounded-sm p-4 bg-ink/40">
                <p class="text-xs uppercase tracking-[0.28em] text-gold/80">First game tip</p>
                <p class="mt-2 text-parch/90 italic">${top.tip}</p>
            </div>
            <p class="mt-8 text-dim text-sm uppercase tracking-[0.2em]">Also calling to you</p>
            <div class="flex justify-center gap-3 mt-3 flex-wrap">
                ${runners.map(r => `
                    <button class="quiz-answer !w-auto !inline-flex items-center gap-2 !py-2" data-jump="${r.name}">
                        <i class="fas ${r.icon} text-gold"></i> ${r.name}
                    </button>`).join('')}
            </div>
            <div class="mt-9 flex flex-col sm:flex-row gap-3 justify-center">
                <a href="#classes" data-jump="${top.name}" class="no-underline bg-gold text-ink font-bold px-6 py-3 rounded-sm uppercase tracking-[0.15em] text-sm hover:bg-parch transition-colors">
                    Read the full entry
                </a>
                <button data-restart class="bg-transparent border border-gold/40 text-gold px-6 py-3 rounded-sm uppercase tracking-[0.15em] text-sm hover:border-gold hover:bg-gold/10 transition-colors cursor-pointer font-body">
                    Consult again
                </button>
            </div>
        </div>`;

    quizEl.querySelector('[data-restart]').addEventListener('click', () => {
        answers = [];
        renderQuestion(0);
    });
    quizEl.querySelectorAll('[data-jump]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.preventDefault();
            highlightClass(el.dataset.jump);
        });
    });
}

/* ══════════ The compendium ══════════ */

const compendiumEl = document.getElementById('compendium');

function renderCompendium() {
    compendiumEl.innerHTML = Object.values(CLASSES).map(cls => `
        <article class="class-card ornate bg-card border border-gold/20 rounded-sm p-6 cursor-pointer reveal" data-name="${cls.name}">
            <div class="flex items-start justify-between gap-3">
                <div>
                    <i class="fas ${cls.icon} text-2xl text-gold"></i>
                    <h3 class="font-display text-3xl mt-2 text-parch">${cls.name}</h3>
                    <p class="text-gold/80 italic text-sm">${cls.epithet} &middot; ${cls.role}</p>
                </div>
                <i class="fas fa-chevron-down card-chevron text-dim mt-1 transition-transform"></i>
            </div>
            <p class="mt-3 text-[0.95rem] text-parch/85">${cls.blurb}</p>
            <div class="mt-4">${classChips(cls)}</div>
            <div class="card-more mt-4 border-t border-gold/15 pt-4">
                <p class="text-xs uppercase tracking-[0.28em] text-gold/80">Pick this if</p>
                <ul class="mt-2 space-y-1.5 list-none text-[0.92rem] text-parch/85">
                    ${cls.goodIf.map(g => `<li class="flex gap-2"><span class="text-gold">&#10070;</span>${g}</li>`).join('')}
                </ul>
                <p class="mt-3 text-sm text-dim italic"><span class="text-gold/90 not-italic font-bold">First game tip:</span> ${cls.tip}</p>
            </div>
        </article>`).join('');

    compendiumEl.querySelectorAll('.class-card').forEach(card => {
        card.addEventListener('click', () => card.classList.toggle('open'));
    });
}

function highlightClass(name) {
    const card = compendiumEl.querySelector(`[data-name="${name}"]`);
    if (!card) return;
    compendiumEl.querySelectorAll('.highlighted').forEach(c => c.classList.remove('highlighted'));
    card.classList.add('open', 'highlighted');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ══════════ Checklist (persists locally) ══════════ */

const CHECKLIST_KEY = 'dnd-checklist';
const CHECKLIST_ITEMS = [
    { id: 'dice', label: 'A set of dice, or a dice app on your phone' },
    { id: 'sheet', label: 'Your character sheet (your DM can help make one)' },
    { id: 'pencil', label: 'Pencil and eraser. Numbers change constantly' },
    { id: 'notebook', label: 'A notebook for names you will otherwise forget' },
    { id: 'snacks', label: 'Snacks to share with the table' },
    { id: 'backstory', label: 'One sentence about who your character is' },
];

function renderChecklist() {
    const listEl = document.getElementById('checklist');
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(CHECKLIST_KEY)) || {}; } catch { /* fresh start */ }

    listEl.innerHTML = CHECKLIST_ITEMS.map(item => `
        <li>
            <label class="check-item">
                <input type="checkbox" data-id="${item.id}" ${saved[item.id] ? 'checked' : ''}>
                <span class="check-box"><i class="fas fa-check"></i></span>
                <span class="check-label">${item.label}</span>
            </label>
        </li>`).join('');

    listEl.querySelectorAll('input').forEach(input => {
        input.addEventListener('change', () => {
            saved[input.dataset.id] = input.checked;
            localStorage.setItem(CHECKLIST_KEY, JSON.stringify(saved));
        });
    });
}

/* ══════════ Dice shrine ══════════ */

const ROLL_FLAVOR = {
    1: 'Natural 1. Your sword is now somehow in a tree. The table loves you anyway.',
    20: 'NATURAL 20! The tavern erupts. Remember this feeling.',
};

function setupRoller() {
    const btn = document.getElementById('roll-btn');
    const valueEl = document.getElementById('roll-value');
    const flavorEl = document.getElementById('roll-flavor');
    let rolling = false;

    btn.addEventListener('click', () => {
        if (rolling) return;
        rolling = true;
        btn.classList.add('rolling');
        flavorEl.textContent = 'The die tumbles...';
        flavorEl.className = 'mt-4 text-dim italic min-h-[1.5rem]';

        const spin = setInterval(() => {
            valueEl.textContent = 1 + Math.floor(Math.random() * 20);
        }, 70);

        setTimeout(() => {
            clearInterval(spin);
            btn.classList.remove('rolling');
            const roll = 1 + Math.floor(Math.random() * 20);
            valueEl.textContent = roll;
            if (roll === 20) {
                flavorEl.textContent = ROLL_FLAVOR[20];
                flavorEl.classList.add('roll-crit');
            } else if (roll === 1) {
                flavorEl.textContent = ROLL_FLAVOR[1];
                flavorEl.classList.add('roll-fumble');
            } else {
                flavorEl.textContent = `You rolled a ${roll}. ${roll >= 15 ? 'The DM raises an eyebrow. Not bad.' : roll >= 8 ? 'A solid, honest roll.' : 'The dice are just warming up.'}`;
            }
            rolling = false;
        }, 650);
    });
}

/* ══════════ Scroll reveal ══════════ */

function setupReveal() {
    const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('revealed');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.12 });
    document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
}

/* ══════════ Boot ══════════ */

renderQuestion(0);
renderCompendium();
renderChecklist();
setupRoller();
setupReveal();
