const EXERCISES = [
    {
        id: 'muscle-ups',
        name: 'Muscle-ups',
        icon: 'fas fa-arrows-up-to-line',
        sets: 3,
        repHint: '3–5+ clean reps',
        note: 'Band is fine — quality over quantity. Rest ~2–3 min between sets.',
        defaultReps: 4,
        minReps: 1,
    },
    {
        id: 'push-ups',
        name: 'Push-ups',
        icon: 'fas fa-person-falling',
        sets: 3,
        repHint: '15–25+ reps',
        note: 'Push close to failure. Control the descent.',
        defaultReps: 15,
        minReps: 1,
    },
    {
        id: 'chin-ups',
        name: 'Chin-ups',
        icon: 'fas fa-person-rays',
        sets: 3,
        repHint: '6–12 reps',
        note: 'Close to failure. Full hang at the bottom, chin over bar.',
        defaultReps: 8,
        minReps: 1,
    },
    {
        id: 'dips',
        name: 'Dips',
        icon: 'fas fa-arrow-down',
        sets: 3,
        repHint: '10–15 reps',
        note: '2–3 sets. Slight forward lean for chest emphasis.',
        defaultReps: 5,
        minReps: 1,
    },
];

// State: { exerciseId: { setIndex: { reps, done } } }
const state = {};

function initState() {
    EXERCISES.forEach(ex => {
        state[ex.id] = {};
        for (let i = 0; i < ex.sets; i++) {
            state[ex.id][i] = { reps: ex.defaultReps, done: false };
        }
    });
}

function totalSets() {
    return EXERCISES.reduce((sum, ex) => sum + ex.sets, 0);
}

function doneSets() {
    let count = 0;
    EXERCISES.forEach(ex => {
        for (let i = 0; i < ex.sets; i++) {
            if (state[ex.id][i].done) count++;
        }
    });
    return count;
}

function updateGlobalProgress() {
    const done = doneSets();
    const total = totalSets();
    const pct = total ? (done / total) * 100 : 0;
    document.getElementById('global-progress-bar').style.width = pct + '%';
    document.getElementById('overall-progress').textContent = `${done} / ${total} sets`;

    const banner = document.getElementById('done-banner');
    if (done === total) {
        banner.classList.remove('hidden');
        renderSummary();
    } else {
        banner.classList.add('hidden');
    }
}

function renderSummary() {
    const container = document.getElementById('session-summary');
    container.innerHTML = EXERCISES.map(ex => {
        const sets = Object.values(state[ex.id]);
        const repsStr = sets.map((s, i) => `Set ${i + 1}: ${s.reps} reps`).join(' · ');
        return `<div class="flex gap-2"><span class="text-label font-medium w-28 flex-shrink-0">${ex.name}</span><span>${repsStr}</span></div>`;
    }).join('');
}

function setReps(exId, setIdx, delta) {
    const ex = EXERCISES.find(e => e.id === exId);
    const s = state[exId][setIdx];
    if (s.done) return;
    s.reps = Math.max(ex.minReps, s.reps + delta);
    document.getElementById(`reps-${exId}-${setIdx}`).textContent = s.reps;
}

function toggleDone(exId, setIdx) {
    const s = state[exId][setIdx];
    s.done = !s.done;
    renderSetRow(exId, setIdx);
    updateExerciseCard(exId);
    updateGlobalProgress();
}

function renderSetRow(exId, setIdx) {
    const s = state[exId][setIdx];
    const row = document.getElementById(`set-row-${exId}-${setIdx}`);
    if (!row) return;

    const doneBtn = row.querySelector('.done-btn');
    const minusBtn = row.querySelector('.rep-btn.minus');
    const plusBtn = row.querySelector('.rep-btn.plus');

    if (s.done) {
        row.classList.add('done');
        doneBtn.innerHTML = '<i class="fas fa-check text-success"></i>';
        doneBtn.classList.add('border-success/40', 'text-success');
        doneBtn.classList.remove('border-surface-border', 'text-muted', 'hover:border-muted', 'hover:text-label');
        minusBtn.disabled = true;
        plusBtn.disabled = true;
    } else {
        row.classList.remove('done');
        doneBtn.innerHTML = '<i class="far fa-circle text-muted"></i>';
        doneBtn.classList.remove('border-success/40', 'text-success');
        doneBtn.classList.add('border-surface-border', 'text-muted', 'hover:border-muted', 'hover:text-label');
        minusBtn.disabled = false;
        plusBtn.disabled = false;
    }
}

function updateExerciseCard(exId) {
    const ex = EXERCISES.find(e => e.id === exId);
    const allDone = Object.values(state[exId]).every(s => s.done);
    const card = document.getElementById(`card-${exId}`);
    if (allDone) {
        card.classList.add('all-done');
        card.querySelector('.exercise-done-badge').classList.remove('hidden');
    } else {
        card.classList.remove('all-done');
        card.querySelector('.exercise-done-badge').classList.add('hidden');
    }
}

function renderExercises() {
    const list = document.getElementById('exercise-list');
    list.innerHTML = EXERCISES.map(ex => {
        const setsHtml = Array.from({ length: ex.sets }, (_, i) => `
            <div class="set-row flex items-center gap-3 py-2.5 border-t border-surface-border/50"
                 id="set-row-${ex.id}-${i}">
                <span class="text-xs text-muted w-12 flex-shrink-0">Set ${i + 1}</span>

                <!-- Rep stepper -->
                <div class="flex items-center gap-2 flex-1">
                    <button class="rep-btn minus w-7 h-7 rounded flex items-center justify-center border border-surface-border text-muted hover:border-muted hover:text-label transition-colors text-sm"
                            onclick="setReps('${ex.id}', ${i}, -1)">−</button>
                    <span class="text-label font-semibold text-sm w-6 text-center tabular-nums"
                          id="reps-${ex.id}-${i}">${state[ex.id][i].reps}</span>
                    <button class="rep-btn plus w-7 h-7 rounded flex items-center justify-center border border-surface-border text-muted hover:border-muted hover:text-label transition-colors text-sm"
                            onclick="setReps('${ex.id}', ${i}, 1)">+</button>
                    <span class="text-xs text-muted ml-1">reps</span>
                </div>

                <!-- Done toggle -->
                <button class="done-btn w-8 h-8 rounded-full border border-surface-border text-muted hover:border-muted hover:text-label transition-colors flex items-center justify-center flex-shrink-0"
                        onclick="toggleDone('${ex.id}', ${i})">
                    <i class="far fa-circle text-muted"></i>
                </button>
            </div>
        `).join('');

        return `
            <div class="exercise-card rounded-xl border border-surface-border bg-surface-raised px-5 py-4"
                 id="card-${ex.id}">
                <div class="flex items-start justify-between mb-1">
                    <div>
                        <h2 class="font-semibold text-label">${ex.name}</h2>
                        <p class="text-xs text-accent mt-0.5">${ex.sets} sets · ${ex.repHint}</p>
                    </div>
                    <span class="exercise-done-badge hidden text-xs text-success bg-success/10 border border-success/20 rounded-full px-2.5 py-0.5 mt-0.5">
                        done
                    </span>
                </div>
                <p class="text-xs text-muted mb-3">${ex.note}</p>
                ${setsHtml}
            </div>
        `;
    }).join('');
}

function setSessionDate() {
    const now = new Date();
    document.getElementById('session-date').textContent = now.toLocaleDateString('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
    });
}

function resetSession() {
    initState();
    renderExercises();
    updateGlobalProgress();
}

document.getElementById('reset-btn').addEventListener('click', () => {
    if (doneSets() === 0 || confirm('Reset this session?')) resetSession();
});

initState();
setSessionDate();
renderExercises();
updateGlobalProgress();
