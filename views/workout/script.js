// Workout tracker: list / player / history / library screens over
// app/controllers/workout-controller.php. Demo shape: signed-out visitors see
// the site owner's workouts and can run the player with in-memory state only;
// all mutations require sign-in. Decision logic lives in logic.js (tested).
import { loginUrl } from '../../components/auth-gate.js';
import {
    TYPE_LABELS, targetLabel, metricLabel, setKey, stepValue, initState,
    restoreState, progress, exerciseDone, buildSetPayload, summaryLines,
    countdownRemaining, validateWorkoutDraft, validateExerciseDraft,
    parsePace, formatPace, formatSeconds, formatDistance, formatWeight,
} from './logic.js';

const API = '../../app/controllers/workout-controller.php';
const LOCK_TITLE = 'Sign in to build your own workouts';
const ICON_PRESETS = [
    'fas fa-dumbbell', 'fas fa-person-running', 'fas fa-person-swimming',
    'fas fa-bicycle', 'fas fa-stopwatch', 'fas fa-fire', 'fas fa-heart-pulse',
    'fas fa-mountain', 'fas fa-arrows-up-to-line', 'fas fa-person-falling',
];

let isDemo = true;
let viewer = null;
let workouts = [];
let exercises = null;      // lazy-loaded library cache
let player = null;         // active run context
let editorDraft = null;    // workout modal state
let exerciseDraft = null;  // exercise modal state

const $ = (id) => document.getElementById(id);

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

// --- API ---

async function apiFetch(url, options = {}) {
    const res = await fetch(url, options);
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) {
        const err = new Error((data && data.error) || 'Request failed');
        err.status = res.status;
        throw err;
    }
    return data;
}

const post = (body, method = 'POST') => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

/** A mutation failed: 401 degrades the player to local-only, rest just toast. */
function handleWriteError(err) {
    if (err.status === 401) {
        if (player) player.localOnly = true;
        toast('Session expired. Progress is no longer being saved.');
        return;
    }
    toast(err.message);
}

// --- Small helpers ---

let toastTimer = null;
function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function parseDb(dt) {
    return dt ? new Date(dt.replace(' ', 'T')) : null;
}

function fmtDay(dt) {
    const d = parseDb(dt);
    return d ? d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
}

function fmtRelative(dt) {
    const d = parseDb(dt);
    if (!d) return 'never';
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return days + ' days ago';
    return fmtDay(dt);
}

function displayValue(field, value) {
    switch (field) {
        case 'weight_kg': return formatWeight(value);
        case 'seconds': return formatSeconds(value);
        case 'distance_m': return formatDistance(value);
        case 'pace_s_per_km': return value ? formatPace(value) : '-';
        default: return String(value);
    }
}

// --- Auth UI ---

function updateAuthUI() {
    const signin = $('signin-btn');
    const chip = $('account-chip');
    const banner = $('demo-banner');
    if (isDemo) {
        signin.href = loginUrl();
        $('demo-signin').href = loginUrl();
        signin.classList.remove('hidden');
        signin.classList.add('inline-flex');
        chip.classList.add('hidden');
        banner.classList.remove('hidden');
    } else {
        signin.classList.add('hidden');
        banner.classList.add('hidden');
        const name = (viewer && viewer.display_name) || 'Account';
        $('account-name').textContent = name.split(' ')[0];
        $('account-avatar').innerHTML = viewer && viewer.avatar_url
            ? `<img src="${esc(viewer.avatar_url)}" alt="" class="w-full h-full object-cover" referrerpolicy="no-referrer">`
            : '<i class="fas fa-user text-[10px]"></i>';
        chip.classList.remove('hidden');
        chip.classList.add('inline-flex');
    }
    for (const btn of [$('new-workout-btn'), $('new-exercise-btn')]) {
        btn.disabled = isDemo;
        btn.title = isDemo ? LOCK_TITLE : '';
    }
}

// --- Router ---

function route() {
    stopAllCountdowns();
    const hash = location.hash || '#/';
    const play = hash.match(/^#\/play\/(\d+)$/);
    let screen = 'list';
    if (play) screen = 'player';
    else if (hash === '#/history') screen = 'history';
    else if (hash === '#/library') screen = 'library';

    for (const name of ['list', 'player', 'history', 'library']) {
        $('screen-' + name).classList.toggle('active', name === screen);
    }
    document.querySelectorAll('.tab-link').forEach((tab) => {
        tab.classList.toggle('active', tab.dataset.tab === screen);
    });

    if (screen === 'list') renderList();
    else if (screen === 'player') startPlayer(parseInt(play[1], 10));
    else if (screen === 'history') loadHistory();
    else if (screen === 'library') ensureExercises().then(renderLibrary).catch((e) => toast(e.message));
}

// --- Workout list ---

async function loadWorkouts() {
    const data = await apiFetch(API + '?resource=workouts');
    isDemo = !!data.demo;
    viewer = data.viewer || null;
    workouts = data.workouts || [];
}

function renderList() {
    const rows = $('workout-rows');
    $('list-empty').classList.toggle('hidden', workouts.length > 0);
    const lock = isDemo ? `disabled title="${LOCK_TITLE}"` : '';
    rows.innerHTML = workouts.map((w, i) => `
        <article class="reveal py-5 flex items-center gap-4" style="animation-delay:${i * 60}ms">
            <div class="flex-1 min-w-0">
                <h3 class="font-display font-black text-3xl md:text-4xl uppercase tracking-wide leading-none">${esc(w.name)}</h3>
                ${w.description ? `<p class="text-steel text-sm mt-1.5">${esc(w.description)}</p>` : ''}
                <p class="text-steel text-xs uppercase tracking-widest mt-1.5">
                    ${w.items.length} exercise${w.items.length === 1 ? '' : 's'} &middot; ${w.rounds} round${w.rounds === 1 ? '' : 's'} &middot; last done ${fmtRelative(w.last_session_at)}
                </p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
                <button data-action="start" data-id="${w.id}" class="font-display font-bold uppercase tracking-widest bg-ember hover:bg-ember-dim text-iron px-5 py-2 transition-colors">Start</button>
                <button data-action="edit-workout" data-id="${w.id}" ${lock} class="w-9 h-9 border border-seam text-steel hover:text-chalk hover:border-steel transition-colors disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Edit"><i class="fas fa-pen text-xs"></i></button>
                <button data-action="delete-workout" data-id="${w.id}" ${lock} class="w-9 h-9 border border-seam text-steel hover:text-ember hover:border-ember transition-colors disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Delete"><i class="fas fa-trash text-xs"></i></button>
            </div>
        </article>
    `).join('');
}

async function deleteWorkout(id) {
    const workout = workouts.find((w) => w.id === id);
    if (!workout) return;
    if (!confirm(`Delete "${workout.name}"? Its past sessions stay in the log.`)) return;
    try {
        await apiFetch(`${API}?resource=workout&id=${id}`, { method: 'DELETE' });
        await loadWorkouts();
        renderList();
        toast('Workout deleted');
    } catch (err) { handleWriteError(err); }
}

// --- Player ---

function startPlayer(id) {
    const workout = workouts.find((w) => w.id === id);
    if (!workout || workout.items.length === 0) {
        location.hash = '#/';
        return;
    }
    player = {
        workout,
        items: workout.items,
        rounds: workout.rounds,
        state: initState(workout.items, workout.rounds),
        session: null,
        pendingSession: null,
        localOnly: isDemo,
        finished: false,
        countdowns: new Map(),
    };
    renderPlayer(true);
    if (!isDemo) resumeOpenSession();
}

async function resumeOpenSession() {
    try {
        const data = await apiFetch(`${API}?resource=sessions&open=1&workout_id=${player.workout.id}`);
        if (!data.session || !player) return;
        player.session = data.session;
        player.rounds = data.session.rounds;
        player.state = restoreState(data.session, player.items);
        renderPlayer(false);
        toast('Resumed your open session');
    } catch { /* resume is best effort */ }
}

function renderPlayer(withReveal) {
    const w = player.workout;
    $('player-title').textContent = w.name;
    $('player-meta').textContent =
        `${player.items.length} exercises · ${player.rounds} rounds · ` +
        new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    $('player-cards').innerHTML = player.items.map((item, i) => `
        <article class="exercise-card ${withReveal ? 'reveal' : ''} border border-seam bg-plate" data-ex="${item.exercise_id}" style="animation-delay:${i * 60}ms">
            <header class="px-4 py-3 flex items-center gap-3 border-b border-seam">
                <i class="${esc(item.icon || 'fas fa-dumbbell')} text-ember text-lg w-6 text-center"></i>
                <div class="min-w-0">
                    <h3 class="font-display font-bold text-2xl uppercase tracking-wide leading-none">${esc(item.name)}</h3>
                    <p class="text-xs text-steel mt-1">Target ${esc(targetLabel(item))}${item.note ? ' &middot; ' + esc(item.note) : (item.exercise_note ? ' &middot; ' + esc(item.exercise_note) : '')}</p>
                </div>
                <span class="done-badge ml-auto hidden shrink-0 text-[10px] font-bold uppercase tracking-widest text-ember border border-ember px-2 py-0.5">Done</span>
            </header>
            <div class="divide-y divide-seam">
                ${roundRows(item).join('')}
            </div>
        </article>
    `).join('');
    for (const item of player.items) updateCardDone(item.exercise_id);
    updateProgress();
}

function roundRows(item) {
    const rows = [];
    for (let round = 1; round <= player.rounds; round++) {
        const key = setKey(item.exercise_id, round);
        const entry = player.state[key];
        rows.push(`
            <div class="set-row px-4 py-2.5 flex items-center gap-3 ${entry.done ? 'done' : ''}" data-key="${key}">
                <span class="font-display font-bold text-sm text-steel w-7 shrink-0">R${round}</span>
                <div class="flex-1 flex flex-wrap items-center gap-x-4 gap-y-1">${rowControls(item, key)}</div>
                ${item.type === 'time' ? `
                    <button data-action="countdown" data-key="${key}" class="count-btn w-9 h-9 shrink-0 border border-seam text-steel hover:text-ember hover:border-ember transition-colors" aria-label="Countdown"><i class="fas fa-play text-xs"></i></button>` : ''}
                <button data-action="toggle" data-key="${key}" class="done-toggle w-10 h-10 shrink-0 border flex items-center justify-center transition-colors ${entry.done ? 'bg-ember border-ember text-iron' : 'border-seam text-steel/40 hover:border-ember hover:text-ember'}" aria-label="Mark done">
                    <i class="fas fa-check"></i>
                </button>
            </div>
        `);
    }
    return rows;
}

function stepperGroup(key, field, value, unit, extraClass = '') {
    return `
        <span class="inline-flex items-center gap-1.5">
            <button data-action="step" data-key="${key}" data-field="${field}" data-dir="-1" class="w-7 h-7 border border-seam text-steel hover:text-ember hover:border-ember transition-colors" aria-label="Decrease">&minus;</button>
            <span class="font-display font-bold text-2xl tabular-nums min-w-[3rem] text-center ${extraClass}" data-val="${field}">${displayValue(field, value)}</span>
            <button data-action="step" data-key="${key}" data-field="${field}" data-dir="1" class="w-7 h-7 border border-seam text-steel hover:text-ember hover:border-ember transition-colors" aria-label="Increase">+</button>
            <span class="text-[10px] uppercase tracking-widest text-steel">${unit}</span>
        </span>
    `;
}

function rowControls(item, key) {
    const a = player.state[key].actuals;
    switch (item.type) {
        case 'reps':
            return stepperGroup(key, 'reps', a.reps, 'reps');
        case 'weighted':
            return stepperGroup(key, 'reps', a.reps, 'reps') + stepperGroup(key, 'weight_kg', a.weight_kg, 'kg');
        case 'time':
            return stepperGroup(key, 'seconds', a.seconds, 'hold', 'count-value');
        case 'distance':
            return stepperGroup(key, 'distance_m', a.distance_m, 'dist') + stepperGroup(key, 'pace_s_per_km', a.pace_s_per_km, '/km');
        default:
            return '';
    }
}

function rowEl(key) {
    return document.querySelector(`.set-row[data-key="${key}"]`);
}

function patchRow(key) {
    const row = rowEl(key);
    if (!row) return;
    const entry = player.state[key];
    row.classList.toggle('done', entry.done);
    const toggle = row.querySelector('.done-toggle');
    toggle.className = 'done-toggle w-10 h-10 shrink-0 border flex items-center justify-center transition-colors '
        + (entry.done ? 'bg-ember border-ember text-iron' : 'border-seam text-steel/40 hover:border-ember hover:text-ember');
}

function updateCardDone(exerciseId) {
    const card = document.querySelector(`.exercise-card[data-ex="${exerciseId}"]`);
    if (!card) return;
    const allDone = exerciseDone(player.state, exerciseId, player.rounds);
    card.classList.toggle('all-done', allDone);
    card.querySelector('.done-badge').classList.toggle('hidden', !allDone);
}

function updateProgress() {
    const { done, total, pct } = progress(player.state, player.items, player.rounds);
    const bar = $('player-progress-bar');
    bar.style.width = pct + '%';
    bar.classList.toggle('full', done === total && total > 0);
    $('player-progress-label').textContent = `${done} / ${total}`;

    const complete = total > 0 && done === total;
    $('done-banner').classList.toggle('hidden', !complete);
    if (complete) {
        $('summary').innerHTML = summaryLines(player.items, player.state, player.rounds).map((line) => `
            <p class="flex gap-3"><span class="font-display font-bold uppercase tracking-wide w-36 shrink-0">${esc(line.name)}</span><span class="text-steel">${esc(line.detail)}</span></p>
        `).join('');
        $('finish-btn').classList.toggle('hidden', player.finished);
        $('done-home').classList.toggle('hidden', !player.finished);
    }
}

/** The lazily created server session for this run (signed-in only). */
async function ensureSession() {
    if (player.session) return player.session;
    if (!player.pendingSession) {
        player.pendingSession = apiFetch(API + '?resource=sessions', post({ workout_id: player.workout.id }))
            .then((session) => { player.session = session; return session; })
            .finally(() => { player.pendingSession = null; });
    }
    return player.pendingSession;
}

async function onToggle(key) {
    if (player.finished) return;
    stopCountdown(key);
    const [exId, round] = key.split(':').map(Number);
    const entry = player.state[key];
    const item = player.items.find((i) => i.exercise_id === exId);
    entry.done = !entry.done;
    patchRow(key);
    updateCardDone(exId);
    updateProgress();

    if (player.localOnly) return;
    try {
        if (entry.done) {
            await ensureSession();
            await apiFetch(`${API}?resource=sessions&id=${player.session.id}&action=log`,
                post(buildSetPayload(item, round, entry.actuals)));
        } else if (player.session) {
            await apiFetch(`${API}?resource=sessions&id=${player.session.id}&action=unlog`,
                post({ exercise_id: exId, round_number: round }));
        }
    } catch (err) { handleWriteError(err); }
}

function onStep(key, field, dir) {
    const entry = player.state[key];
    if (entry.done || player.finished) return;
    entry.actuals[field] = stepValue(field, entry.actuals[field], dir);
    const span = rowEl(key)?.querySelector(`[data-val="${field}"]`);
    if (span) span.textContent = displayValue(field, entry.actuals[field]);
}

function onCountdown(key) {
    if (player.countdowns.has(key)) {
        stopCountdown(key);
        return;
    }
    const entry = player.state[key];
    if (entry.done || player.finished) return;
    const row = rowEl(key);
    const from = entry.actuals.seconds;
    const startedMs = Date.now();
    row.classList.add('counting');
    row.querySelector('.count-btn i').className = 'fas fa-stop text-xs';
    const timer = setInterval(() => {
        const remaining = countdownRemaining(startedMs, from, Date.now());
        const span = row.querySelector('[data-val="seconds"]');
        if (span) span.textContent = formatSeconds(remaining);
        if (remaining <= 0) {
            stopCountdown(key);
            if (!entry.done) onToggle(key);
        }
    }, 250);
    player.countdowns.set(key, timer);
}

function stopCountdown(key) {
    const timer = player?.countdowns.get(key);
    if (timer === undefined) return;
    clearInterval(timer);
    player.countdowns.delete(key);
    const row = rowEl(key);
    if (row) {
        row.classList.remove('counting');
        const icon = row.querySelector('.count-btn i');
        if (icon) icon.className = 'fas fa-play text-xs';
        const span = row.querySelector('[data-val="seconds"]');
        if (span) span.textContent = formatSeconds(player.state[key].actuals.seconds);
    }
}

function stopAllCountdowns() {
    if (!player) return;
    for (const key of [...player.countdowns.keys()]) stopCountdown(key);
}

async function onPlayerReset() {
    const { done } = progress(player.state, player.items, player.rounds);
    if (done > 0 && !confirm('Clear this session? Logged sets will be discarded.')) return;
    stopAllCountdowns();
    if (player.session && !player.localOnly) {
        try {
            await apiFetch(`${API}?resource=sessions&id=${player.session.id}`, { method: 'DELETE' });
        } catch (err) { handleWriteError(err); }
    }
    player.session = null;
    player.finished = false;
    player.localOnly = isDemo;
    player.rounds = player.workout.rounds;
    player.state = initState(player.items, player.rounds);
    renderPlayer(false);
}

async function onFinish() {
    if (player.finished) return;
    if (player.localOnly) {
        player.finished = true;
        updateProgress();
        toast(isDemo ? 'Demo run done. Sign in to save your sessions.' : 'Run done. It was not saved.');
        return;
    }
    try {
        await ensureSession();
        const session = await apiFetch(`${API}?resource=sessions&id=${player.session.id}&action=finish`, post({}));
        player.session = session;
        player.finished = true;
        player.workout.last_session_at = session.finished_at;
        updateProgress();
        toast('Session saved to the log');
    } catch (err) { handleWriteError(err); }
}

// --- History ---

async function loadHistory() {
    const rows = $('session-rows');
    rows.innerHTML = '';
    try {
        const data = await apiFetch(API + '?resource=sessions');
        const sessions = data.sessions || [];
        $('history-empty').classList.toggle('hidden', sessions.length > 0);
        const lock = isDemo ? `disabled title="${LOCK_TITLE}"` : '';
        rows.innerHTML = sessions.map((s, i) => {
            const started = parseDb(s.started_at);
            const finished = parseDb(s.finished_at);
            const duration = started && finished ? Math.max(1, Math.round((finished - started) / 60000)) + ' min' : null;
            return `
            <div class="reveal py-4" style="animation-delay:${i * 40}ms">
                <div class="flex items-center gap-3">
                    <button data-action="expand-session" data-id="${s.id}" class="flex-1 min-w-0 flex items-center gap-4 text-left group">
                        <div class="min-w-0">
                            <p class="font-display font-bold text-2xl uppercase tracking-wide leading-none truncate">${esc(s.workout_name)}</p>
                            <p class="text-xs text-steel uppercase tracking-widest mt-1.5">
                                ${fmtDay(s.started_at)} &middot; ${s.set_count} set${s.set_count === 1 ? '' : 's'}
                                ${duration ? '&middot; ' + duration : ''}
                                ${!finished ? '&middot; <span class="text-ember">incomplete</span>' : ''}
                            </p>
                        </div>
                        <i class="fas fa-chevron-down ml-auto text-steel text-xs transition-transform group-[.open]:rotate-180"></i>
                    </button>
                    <button data-action="delete-session" data-id="${s.id}" ${lock} class="w-9 h-9 shrink-0 border border-seam text-steel hover:text-ember hover:border-ember transition-colors disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Delete"><i class="fas fa-trash text-xs"></i></button>
                </div>
                <div class="session-detail hidden mt-3 pl-1 text-sm space-y-1" data-detail="${s.id}"></div>
            </div>`;
        }).join('');
    } catch (err) {
        toast(err.message);
    }
}

async function expandSession(id, trigger) {
    const detail = document.querySelector(`[data-detail="${id}"]`);
    if (!detail) return;
    const isOpen = !detail.classList.contains('hidden');
    detail.classList.toggle('hidden', isOpen);
    trigger.classList.toggle('open', !isOpen);
    if (isOpen || detail.dataset.loaded) return;
    detail.innerHTML = '<p class="text-steel text-xs uppercase tracking-widest">Loading...</p>';
    try {
        const data = await apiFetch(`${API}?resource=sessions&id=${id}`);
        detail.dataset.loaded = '1';
        const sets = data.session.sets || [];
        detail.innerHTML = sets.length === 0
            ? '<p class="text-steel">No sets logged.</p>'
            : sets.map((set) => `
                <p class="flex gap-3">
                    <span class="font-display font-bold text-steel w-8 shrink-0">R${set.round_number}</span>
                    <span class="font-display font-bold uppercase tracking-wide w-36 shrink-0 truncate">${esc(set.exercise_name)}</span>
                    <span class="text-steel">${esc(metricLabel(set.type, set, 'actual_'))}</span>
                </p>
            `).join('');
    } catch (err) {
        detail.innerHTML = `<p class="text-ember">${esc(err.message)}</p>`;
    }
}

async function deleteSession(id) {
    if (!confirm('Remove this session from the log? This cannot be undone.')) return;
    try {
        await apiFetch(`${API}?resource=sessions&id=${id}`, { method: 'DELETE' });
        loadHistory();
        toast('Session removed');
    } catch (err) { handleWriteError(err); }
}

// --- Exercise library ---

async function ensureExercises() {
    if (exercises !== null) return exercises;
    const data = await apiFetch(API + '?resource=exercises');
    exercises = data.exercises || [];
    return exercises;
}

function renderLibrary() {
    const rows = $('exercise-rows');
    $('library-empty').classList.toggle('hidden', exercises.length > 0);
    rows.innerHTML = exercises.map((ex, i) => {
        const inUse = ex.used_by_workouts > 0;
        const deleteLock = isDemo ? `disabled title="${LOCK_TITLE}"`
            : inUse ? 'disabled title="Used by a workout. Remove it from your workouts first."' : '';
        return `
        <div class="reveal py-4 flex items-center gap-4" style="animation-delay:${i * 40}ms">
            <i class="${esc(ex.icon || 'fas fa-dumbbell')} text-ember text-lg w-7 text-center shrink-0"></i>
            <div class="flex-1 min-w-0">
                <p class="font-display font-bold text-2xl uppercase tracking-wide leading-none truncate">${esc(ex.name)}</p>
                <p class="text-xs text-steel uppercase tracking-widest mt-1.5">
                    ${TYPE_LABELS[ex.type] || ex.type}
                    ${inUse ? `&middot; in ${ex.used_by_workouts} workout${ex.used_by_workouts === 1 ? '' : 's'}` : ''}
                    ${ex.note ? '&middot; <span class="normal-case tracking-normal">' + esc(ex.note) + '</span>' : ''}
                </p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
                <button data-action="edit-exercise" data-id="${ex.id}" ${isDemo ? `disabled title="${LOCK_TITLE}"` : ''} class="w-9 h-9 border border-seam text-steel hover:text-chalk hover:border-steel transition-colors disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Edit"><i class="fas fa-pen text-xs"></i></button>
                <button data-action="delete-exercise" data-id="${ex.id}" ${deleteLock} class="w-9 h-9 border border-seam text-steel hover:text-ember hover:border-ember transition-colors disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Delete"><i class="fas fa-trash text-xs"></i></button>
            </div>
        </div>`;
    }).join('');
}

async function deleteExercise(id) {
    const exercise = exercises.find((e) => e.id === id);
    if (!exercise || !confirm(`Delete "${exercise.name}" from your library?`)) return;
    try {
        await apiFetch(`${API}?resource=exercise&id=${id}`, { method: 'DELETE' });
        exercises = null;
        await ensureExercises();
        renderLibrary();
        toast('Exercise deleted');
    } catch (err) { handleWriteError(err); }
}

// --- Exercise modal ---

function openExerciseModal(exercise, origin) {
    exerciseDraft = { id: exercise ? exercise.id : null, origin, type: exercise ? exercise.type : null };
    $('e-title').textContent = exercise ? 'Edit exercise' : 'New exercise';
    $('e-name').value = exercise ? exercise.name : '';
    $('e-type').value = exercise ? exercise.type : 'reps';
    $('e-type').disabled = !!exercise;
    $('e-type-hint').classList.toggle('hidden', !exercise);
    $('e-icon').value = exercise ? (exercise.icon || '') : '';
    $('e-note').value = exercise ? (exercise.note || '') : '';
    $('e-errors').classList.add('hidden');
    $('e-icon-presets').innerHTML = ICON_PRESETS.map((icon) => `
        <button data-action="icon-preset" data-icon="${icon}" class="w-8 h-8 border border-seam text-steel hover:text-ember hover:border-ember transition-colors" title="${icon}"><i class="${icon} text-xs pointer-events-none"></i></button>
    `).join('');
    $('exercise-modal').classList.add('open');
    $('e-name').focus();
}

async function saveExercise() {
    const draft = {
        name: $('e-name').value,
        type: exerciseDraft.id ? exerciseDraft.type : $('e-type').value,
        icon: $('e-icon').value,
        note: $('e-note').value,
    };
    const errors = validateExerciseDraft(draft);
    if (errors.length > 0) {
        showErrors('e-errors', errors);
        return;
    }
    try {
        const url = exerciseDraft.id ? `${API}?resource=exercise&id=${exerciseDraft.id}` : `${API}?resource=exercise`;
        const saved = await apiFetch(url, post(draft, exerciseDraft.id ? 'PUT' : 'POST'));
        const origin = exerciseDraft.origin;
        $('exercise-modal').classList.remove('open');
        exercises = null;
        await ensureExercises();
        if (origin === 'editor' && editorDraft) {
            if (!editorDraft.items.some((it) => it.exercise_id === saved.id)) {
                editorDraft.items.push(newDraftItem(saved));
            }
            renderEditorItems();
            renderEditorPicker();
        }
        if ($('screen-library').classList.contains('active')) renderLibrary();
        toast('Exercise saved');
    } catch (err) { handleWriteError(err); }
}

// --- Workout editor modal ---

function newDraftItem(exercise) {
    return {
        exercise_id: exercise.id,
        name: exercise.name,
        type: exercise.type,
        icon: exercise.icon,
        target_reps: 10,
        target_weight_kg: 20,
        target_seconds: 30,
        target_distance_m: 1000,
        paceText: '',
    };
}

async function openWorkoutEditor(workout) {
    try { await ensureExercises(); } catch (err) { toast(err.message); return; }
    editorDraft = workout ? {
        id: workout.id,
        name: workout.name,
        description: workout.description || '',
        rounds: workout.rounds,
        items: workout.items.map((item) => ({
            exercise_id: item.exercise_id,
            name: item.name,
            type: item.type,
            icon: item.icon,
            target_reps: item.target_reps ?? 10,
            target_weight_kg: item.target_weight_kg ?? 20,
            target_seconds: item.target_seconds ?? 30,
            target_distance_m: item.target_distance_m ?? 1000,
            paceText: item.target_pace_s_per_km ? formatPace(item.target_pace_s_per_km) : '',
        })),
    } : { id: null, name: '', description: '', rounds: 3, items: [] };

    $('w-title').textContent = workout ? 'Edit workout' : 'New workout';
    $('w-name').value = editorDraft.name;
    $('w-desc').value = editorDraft.description;
    $('w-rounds').textContent = editorDraft.rounds;
    $('w-errors').classList.add('hidden');
    renderEditorItems();
    renderEditorPicker();
    $('workout-modal').classList.add('open');
    $('w-name').focus();
}

function editorItemInputs(item, index) {
    const num = (field, label, value, step = 1, width = 'w-20') => `
        <label class="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-steel">${label}
            <input type="number" data-idx="${index}" data-field="${field}" value="${value ?? ''}" step="${step}" min="0" class="${width} bg-plate border border-seam focus:border-ember outline-none px-2 py-1 text-sm text-chalk">
        </label>`;
    switch (item.type) {
        case 'reps':
            return num('target_reps', 'Reps', item.target_reps);
        case 'weighted':
            return num('target_reps', 'Reps', item.target_reps) + num('target_weight_kg', 'Kg', item.target_weight_kg, 2.5);
        case 'time':
            return num('target_seconds', 'Seconds', item.target_seconds, 5);
        case 'distance':
            return num('target_distance_m', 'Meters', item.target_distance_m, 50, 'w-24') + `
                <label class="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-steel">Pace /km
                    <input type="text" data-idx="${index}" data-field="paceText" value="${esc(item.paceText)}" placeholder="4:35" class="w-20 bg-plate border border-seam focus:border-ember outline-none px-2 py-1 text-sm text-chalk">
                </label>`;
        default:
            return '';
    }
}

function renderEditorItems() {
    $('w-items').innerHTML = editorDraft.items.map((item, index) => `
        <div class="border border-seam bg-iron px-3 py-2.5">
            <div class="flex items-center gap-2.5">
                <i class="${esc(item.icon || 'fas fa-dumbbell')} text-steel text-sm w-5 text-center"></i>
                <span class="font-display font-bold uppercase tracking-wide truncate">${esc(item.name)}</span>
                <span class="text-[10px] uppercase tracking-widest border border-seam px-1.5 py-0.5 text-steel shrink-0">${TYPE_LABELS[item.type] || item.type}</span>
                <span class="ml-auto flex gap-1 shrink-0">
                    <button data-action="item-up" data-idx="${index}" ${index === 0 ? 'disabled' : ''} class="w-7 h-7 border border-seam text-steel hover:text-chalk transition-colors disabled:opacity-30" aria-label="Move up"><i class="fas fa-chevron-up text-[10px]"></i></button>
                    <button data-action="item-down" data-idx="${index}" ${index === editorDraft.items.length - 1 ? 'disabled' : ''} class="w-7 h-7 border border-seam text-steel hover:text-chalk transition-colors disabled:opacity-30" aria-label="Move down"><i class="fas fa-chevron-down text-[10px]"></i></button>
                    <button data-action="item-remove" data-idx="${index}" class="w-7 h-7 border border-seam text-steel hover:text-ember hover:border-ember transition-colors" aria-label="Remove"><i class="fas fa-xmark text-[10px]"></i></button>
                </span>
            </div>
            <div class="mt-2 flex flex-wrap gap-3">${editorItemInputs(item, index)}</div>
        </div>
    `).join('') || '<p class="text-steel text-sm">No exercises yet. Pick one below.</p>';
}

function renderEditorPicker() {
    const used = new Set(editorDraft.items.map((item) => item.exercise_id));
    const available = exercises.filter((ex) => !used.has(ex.id));
    $('w-add-select').innerHTML = available.length > 0
        ? available.map((ex) => `<option value="${ex.id}">${esc(ex.name)} (${TYPE_LABELS[ex.type] || ex.type})</option>`).join('')
        : '<option value="">All your exercises are in this workout</option>';
}

function showErrors(listId, errors) {
    const list = $(listId);
    list.innerHTML = errors.map((e) => `<li><i class="fas fa-triangle-exclamation mr-1.5"></i>${esc(e)}</li>`).join('');
    list.classList.remove('hidden');
}

async function saveWorkoutDraft() {
    editorDraft.name = $('w-name').value;
    editorDraft.description = $('w-desc').value;

    const errors = [];
    const items = editorDraft.items.map((item) => {
        const out = { exercise_id: item.exercise_id, name: item.name, type: item.type };
        if (item.type === 'reps' || item.type === 'weighted') out.target_reps = item.target_reps;
        if (item.type === 'weighted') out.target_weight_kg = item.target_weight_kg;
        if (item.type === 'time') out.target_seconds = item.target_seconds;
        if (item.type === 'distance') {
            out.target_distance_m = item.target_distance_m;
            const paceText = (item.paceText || '').trim();
            out.target_pace_s_per_km = paceText === '' ? null : parsePace(paceText);
            if (paceText !== '' && out.target_pace_s_per_km === null) {
                errors.push(`${item.name}: pace must look like 4:35`);
            }
        }
        return out;
    });
    errors.push(...validateWorkoutDraft({ ...editorDraft, items }));
    if (errors.length > 0) {
        showErrors('w-errors', errors);
        return;
    }

    const payload = {
        name: editorDraft.name.trim(),
        description: editorDraft.description.trim(),
        rounds: editorDraft.rounds,
        items: items.map(({ name, type, ...rest }) => rest),
    };
    try {
        $('w-save').disabled = true;
        const url = editorDraft.id ? `${API}?resource=workout&id=${editorDraft.id}` : `${API}?resource=workout`;
        await apiFetch(url, post(payload, editorDraft.id ? 'PUT' : 'POST'));
        $('workout-modal').classList.remove('open');
        await loadWorkouts();
        renderList();
        exercises = null; // used_by_workouts counts changed
        toast('Workout saved');
    } catch (err) {
        handleWriteError(err);
    } finally {
        $('w-save').disabled = false;
    }
}

// --- Event wiring ---

document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const { action, id, key, field, dir, idx, icon } = btn.dataset;
    switch (action) {
        // list
        case 'start': location.hash = '#/play/' + id; break;
        case 'new-workout': openWorkoutEditor(null); break;
        case 'edit-workout': openWorkoutEditor(workouts.find((w) => w.id === Number(id))); break;
        case 'delete-workout': deleteWorkout(Number(id)); break;
        // player
        case 'toggle': onToggle(key); break;
        case 'step': onStep(key, field, Number(dir)); break;
        case 'countdown': onCountdown(key); break;
        case 'player-reset': onPlayerReset(); break;
        case 'finish': onFinish(); break;
        // history
        case 'expand-session': expandSession(Number(id), btn); break;
        case 'delete-session': deleteSession(Number(id)); break;
        // library
        case 'new-exercise': openExerciseModal(null, 'library'); break;
        case 'edit-exercise': openExerciseModal(exercises.find((e) => e.id === Number(id)), 'library'); break;
        case 'delete-exercise': deleteExercise(Number(id)); break;
        // workout editor modal
        case 'rounds-step': {
            editorDraft.rounds = Math.min(10, Math.max(1, editorDraft.rounds + Number(dir)));
            $('w-rounds').textContent = editorDraft.rounds;
            break;
        }
        case 'add-item': {
            const selected = Number($('w-add-select').value);
            const exercise = exercises.find((e) => e.id === selected);
            if (exercise) {
                editorDraft.items.push(newDraftItem(exercise));
                renderEditorItems();
                renderEditorPicker();
            }
            break;
        }
        case 'new-exercise-inline': openExerciseModal(null, 'editor'); break;
        case 'item-up':
        case 'item-down': {
            const i = Number(idx);
            const j = action === 'item-up' ? i - 1 : i + 1;
            [editorDraft.items[i], editorDraft.items[j]] = [editorDraft.items[j], editorDraft.items[i]];
            renderEditorItems();
            break;
        }
        case 'item-remove':
            editorDraft.items.splice(Number(idx), 1);
            renderEditorItems();
            renderEditorPicker();
            break;
        case 'save-workout': saveWorkoutDraft(); break;
        case 'close-workout-modal': $('workout-modal').classList.remove('open'); break;
        // exercise modal
        case 'icon-preset': $('e-icon').value = icon; break;
        case 'save-exercise': saveExercise(); break;
        case 'close-exercise-modal': $('exercise-modal').classList.remove('open'); break;
    }
});

// Editor target inputs write straight into the draft.
$('w-items').addEventListener('input', (event) => {
    const input = event.target.closest('[data-field]');
    if (!input || !editorDraft) return;
    const item = editorDraft.items[Number(input.dataset.idx)];
    if (!item) return;
    if (input.dataset.field === 'paceText') {
        item.paceText = input.value;
    } else {
        const value = parseFloat(input.value);
        item[input.dataset.field] = Number.isFinite(value) ? value : null;
    }
});

document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    $('workout-modal').classList.remove('open');
    $('exercise-modal').classList.remove('open');
});

window.addEventListener('hashchange', route);

// --- Boot ---

(async function boot() {
    try {
        await loadWorkouts();
    } catch {
        toast('Could not load workouts');
    }
    updateAuthUI();
    route();
})();
