(() => {
    'use strict';

    const API = '../../app/controllers/sourdough-controller.php';

    // --- Phase constants ---
    const PHASE_ORDER = ['bulk_fermentation', 'cold_proof', 'bench_rest', 'bake_lid', 'bake_no_lid', 'finished'];
    const BAKE_LID_SECONDS    = 35 * 60;
    const BAKE_NO_LID_SECONDS = 15 * 60;
    const FIRST_FOLD_MS = 60 * 60 * 1000;   // 1h after mix
    const FOLD_GAP_MS   = 40 * 60 * 1000;   // 40m between subsequent folds
    const BULK_WINDOW_MIN_MS = 4 * 60 * 60 * 1000;
    const BULK_WINDOW_MAX_MS = 8 * 60 * 60 * 1000;

    // --- State ---
    let starter = null;
    let breads = [];
    let deleteTargetId = null;
    let tickInterval = null;
    let audioCtx = null;
    let audioUnlocked = false;
    const bellsFired = new Set(); // keys: `${breadId}:${event}` so we ring once per due moment

    // --- DOM refs ---
    const starterCard       = document.getElementById('starterCard');
    const breadsGrid        = document.getElementById('breadsGrid');
    const breadsLoading     = document.getElementById('breadsLoading');
    const breadsEmpty       = document.getElementById('breadsEmpty');
    const breadsError       = document.getElementById('breadsError');
    const breadsErrorMsg    = document.getElementById('breadsErrorMsg');
    const newBreadBtn       = document.getElementById('newBreadBtn');
    const newBreadModal     = document.getElementById('newBreadModal');
    const newBreadForm      = document.getElementById('newBreadForm');
    const newBreadError     = document.getElementById('newBreadError');
    const breadNameInput    = document.getElementById('breadName');
    const deleteModal       = document.getElementById('deleteModal');
    const deleteBreadName   = document.getElementById('deleteBreadName');
    const toastContainer    = document.getElementById('toastContainer');

    // --- Utilities ---
    function esc(s) {
        if (s === null || s === undefined) return '';
        const div = document.createElement('div');
        div.textContent = String(s);
        return div.innerHTML;
    }

    function parseSqlDate(s) {
        if (!s) return null;
        // MySQL DATETIME is 'YYYY-MM-DD HH:MM:SS' — treat as local time (server == user for self-hosted).
        return new Date(s.replace(' ', 'T'));
    }

    function fmtDuration(ms, { signed = false } = {}) {
        const sign = ms < 0 ? '-' : (signed && ms > 0 ? '+' : '');
        const abs = Math.abs(ms);
        const totalSec = Math.floor(abs / 1000);
        const d = Math.floor(totalSec / 86400);
        const h = Math.floor((totalSec % 86400) / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        if (d > 0) return `${sign}${d}d ${h}h ${m}m`;
        if (h > 0) return `${sign}${h}h ${m}m ${s.toString().padStart(2, '0')}s`;
        if (m > 0) return `${sign}${m}m ${s.toString().padStart(2, '0')}s`;
        return `${sign}${s}s`;
    }

    function fmtTimer(seconds) {
        const s = Math.max(0, Math.floor(seconds));
        const m = Math.floor(s / 60);
        const r = s % 60;
        return `${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`;
    }

    // --- API ---
    async function api(url, options = {}) {
        const res = await fetch(url, options);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        return data;
    }

    const StarterAPI = {
        get:      () => api(`${API}?resource=starter`),
        feed:     () => api(`${API}?resource=starter&action=feed`,     { method: 'POST' }),
        fridge:   () => api(`${API}?resource=starter&action=fridge`,   { method: 'POST' }),
        unfridge: () => api(`${API}?resource=starter&action=unfridge`, { method: 'POST' }),
    };

    const BreadAPI = {
        list:      ()   => api(`${API}?resource=bread`),
        create:    (name) => api(`${API}?resource=bread`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        }),
        fold:      (id) => api(`${API}?resource=bread&id=${id}&action=fold`,       { method: 'POST' }),
        foldsDone: (id) => api(`${API}?resource=bread&id=${id}&action=folds_done`, { method: 'POST' }),
        advance:   (id) => api(`${API}?resource=bread&id=${id}&action=advance`,    { method: 'POST' }),
        back:      (id) => api(`${API}?resource=bread&id=${id}&action=back`,       { method: 'POST' }),
        remove:    (id) => api(`${API}?resource=bread&id=${id}`,                   { method: 'DELETE' }),
    };

    // --- Audio (bell synthesized on the fly, no asset needed) ---
    function unlockAudio() {
        if (audioUnlocked) return;
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            audioUnlocked = true;
        } catch { /* audio disabled — just skip bells */ }
    }

    function ringBell({ celebratory = false } = {}) {
        if (!audioCtx) return;
        const now = audioCtx.currentTime;
        const notes = celebratory
            ? [880, 1108.73, 1318.51, 1760]   // A5, C#6, E6, A6 — major arpeggio
            : [880, 1318.51];                  // A5 → E6 short ding
        notes.forEach((freq, i) => {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            const start = now + i * 0.12;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.32, start + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.7);
            osc.connect(gain).connect(audioCtx.destination);
            osc.start(start);
            osc.stop(start + 0.75);
        });
    }

    // Soft, low-volume tone pair — used for phase changes and back. Doesn't compete with the alarm bell.
    function playTone(freqs, { duration = 0.35, gap = 0.08, volume = 0.10 } = {}) {
        if (!audioCtx) return;
        const now = audioCtx.currentTime;
        freqs.forEach((freq, i) => {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            const start = now + i * gap;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
            osc.connect(gain).connect(audioCtx.destination);
            osc.start(start);
            osc.stop(start + duration + 0.05);
        });
    }

    const PHASE_TONES = {
        cold_proof:  [880,    1108.73],  // A5 → C#6,  airy/cool (into fridge)
        bench_rest:  [659.25, 783.99],   // E5 → G5,   warm middle (out of fridge)
        bake_lid:    [349.23, 440],      // F4 → A4,   low warm (into oven)
        bake_no_lid: [523.25, 659.25],   // C5 → E5,   lighter (lid off)
    };

    function phaseTransitionSound(phase) {
        const tones = PHASE_TONES[phase];
        if (tones) playTone(tones);
    }

    function backSound() {
        // D5 → G4 descending — feels like "undo"
        playTone([587.33, 392], { gap: 0.07, duration: 0.3 });
    }

    // Soft action sounds for everything that isn't a phase advance.
    const ACTION_TONES = {
        'starter-feed':     { freqs: [523.25, 659.25] },                          // C5 → E5, satisfying
        'starter-fridge':   { freqs: [880, 1108.73] },                            // A5 → C#6, airy (matches cold_proof)
        'starter-unfridge': { freqs: [659.25, 783.99] },                          // E5 → G5, warm (matches bench_rest)
        'bread-create':     { freqs: [587.33, 880] },                             // D5 → A5, ascending start
        'bread-fold':       { freqs: [698.46], duration: 0.18, volume: 0.08 },    // F5 single soft tick
        'bread-folds-done': { freqs: [783.99, 1046.50] },                         // G5 → C6, resolve
        'bread-delete':     { freqs: [440, 293.66], duration: 0.4, gap: 0.10 },   // A4 → D4, soft farewell
    };

    function actionSound(key) {
        const cfg = ACTION_TONES[key];
        if (cfg) playTone(cfg.freqs, cfg);
    }

    // --- Starter render ---
    function renderStarter() {
        if (!starter) {
            starterCard.innerHTML = `<p class="text-rye text-sm">Could not load the starter. Has the table been seeded?</p>`;
            return;
        }
        const lastFed = parseSqlDate(starter.last_fed_at);
        const elapsedMs = lastFed ? (Date.now() - lastFed.getTime()) : null;

        const elapsedText = lastFed ? fmtDuration(elapsedMs) : 'never fed';
        const stateBadge = starter.in_fridge
            ? '<span class="phase-stamp stamp-fridge">in fridge</span>'
            : '<span class="phase-stamp stamp-bulk">out & active</span>';

        const tone = !lastFed
            ? 'text-rye'
            : (starter.in_fridge ? 'text-fridge' : (elapsedMs > 24 * 60 * 60 * 1000 ? 'text-rye' : 'text-char'));

        const fridgeBtn = starter.in_fridge
            ? `<button data-action="starter-unfridge"
                       class="bg-crust text-flour font-display text-sm px-3 py-1.5 border-2 border-char shadow-stamp-sm hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none transition-all tracking-wider">
                   <i class="fas fa-mug-hot mr-1"></i> TAKE OUT OF FRIDGE
               </button>`
            : `<button data-action="starter-fridge"
                       class="bg-fridge text-flour font-display text-sm px-3 py-1.5 border-2 border-char shadow-stamp-sm hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none transition-all tracking-wider">
                   <i class="fas fa-snowflake mr-1"></i> PUT IN FRIDGE
               </button>`;

        starterCard.innerHTML = `
            <div class="flex items-start justify-between gap-4 mb-4 flex-wrap">
                <div>
                    <div class="text-xs uppercase tracking-widest text-yeast font-semibold mb-1">Time since last feed</div>
                    <div id="starterTimer" class="font-display text-2xl md:text-3xl ${tone} leading-none" data-timer="starter">${esc(elapsedText)}</div>
                </div>
                <div>${stateBadge}</div>
            </div>

            <div class="flex gap-2 flex-wrap">
                <button data-action="starter-feed"
                        class="bg-crust text-flour font-display text-sm px-3 py-1.5 border-2 border-char shadow-stamp-sm hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none transition-all tracking-wider">
                    <i class="fas fa-utensils mr-1"></i> FEED
                </button>
                ${fridgeBtn}
            </div>
        `;
    }

    // --- Bread phase logic ---

    function nextFoldDueAt(bread) {
        if (bread.phase !== 'bulk_fermentation') return null;
        if (bread.folds_done_at) return null;

        const folds = bread.folds || [];
        if (folds.length === 0) {
            return parseSqlDate(bread.mixed_at).getTime() + FIRST_FOLD_MS;
        }
        const lastFold = parseSqlDate(folds[folds.length - 1]);
        return lastFold.getTime() + FOLD_GAP_MS;
    }

    function bakeEndAt(bread) {
        if (bread.phase === 'bake_lid' && bread.bake_lid_at) {
            return parseSqlDate(bread.bake_lid_at).getTime() + BAKE_LID_SECONDS * 1000;
        }
        if (bread.phase === 'bake_no_lid' && bread.bake_no_lid_at) {
            return parseSqlDate(bread.bake_no_lid_at).getTime() + BAKE_NO_LID_SECONDS * 1000;
        }
        return null;
    }

    function phaseStampHtml(phase) {
        const map = {
            bulk_fermentation: { cls: 'stamp-bulk',     label: 'bulk ferment' },
            cold_proof:        { cls: 'stamp-fridge',   label: 'cold proofing' },
            bench_rest:        { cls: 'stamp-bench',    label: 'bench rest' },
            bake_lid:          { cls: 'stamp-bake1',    label: 'baking · lid on' },
            bake_no_lid:       { cls: 'stamp-bake2',    label: 'baking · lid off' },
            finished:          { cls: 'stamp-finished', label: 'finished' },
        };
        const p = map[phase] || { cls: 'stamp-bulk', label: phase };
        return `<span class="phase-stamp ${p.cls}">${p.label}</span>`;
    }

    // Big focal block for the bulk-fermentation card — label on top, time below.
    function foldBlockHtml(bread, now) {
        if (bread.folds_done_at) {
            return `
                <div class="text-xs uppercase tracking-widest text-yeast font-semibold mb-1">Folds done</div>
                <div class="font-display text-3xl text-yeast leading-none"><i class="fas fa-check mr-2"></i>resting</div>
            `;
        }
        const nextFold = nextFoldDueAt(bread);
        if (nextFold === null) return '';
        const foldsCount = (bread.folds || []).length;
        const dueIn = nextFold - now;
        if (dueIn <= 0) {
            return `
                <div class="text-xs uppercase tracking-widest text-crust font-semibold mb-1">Fold #${foldsCount + 1}</div>
                <div class="font-display text-3xl text-crust leading-none">due now!</div>
            `;
        }
        return `
            <div class="text-xs uppercase tracking-widest text-yeast font-semibold mb-1">Next fold #${foldsCount + 1} in</div>
            <div class="font-display text-3xl text-char leading-none">${esc(fmtDuration(dueIn))}</div>
        `;
    }

    function phaseBody(bread, backBtn = '') {
        const now = Date.now();
        const backSlot = backBtn ? `<div class="ml-auto">${backBtn}</div>` : '';
        const actionBtn = 'border-2 border-char font-display text-sm px-3 py-1.5 shadow-stamp-sm hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none transition-all tracking-wider';

        if (bread.phase === 'bulk_fermentation') {
            const mixedAt = parseSqlDate(bread.mixed_at).getTime();
            const elapsedMs = now - mixedAt;
            const minLeft   = BULK_WINDOW_MIN_MS - elapsedMs;
            const maxLeft   = BULK_WINDOW_MAX_MS - elapsedMs;

            const windowHint = (() => {
                if (maxLeft <= 0) return `<span class="text-rye font-semibold">Past 8h — fridge it now!</span>`;
                if (minLeft <= 0) return `In the 4–8h window. <span class="text-yeast">${fmtDuration(maxLeft)} until 8h.</span>`;
                return `<span class="text-yeast">${fmtDuration(minLeft)} until earliest fridge time (4h).</span>`;
            })();

            return `
                <div class="mb-3" data-fold-block="${bread.id}">${foldBlockHtml(bread, now)}</div>
                <p class="text-sm mb-3" data-window="${bread.id}">${windowHint}</p>
                <p class="text-xs text-yeast mb-3"><i class="fas fa-hand-rock mr-1"></i> ${(bread.folds || []).length} fold(s) logged</p>

                <div class="flex flex-wrap gap-2 items-center">
                    ${bread.folds_done_at ? '' : `
                        <button data-action="bread-fold" data-id="${bread.id}" class="bg-crust text-flour ${actionBtn}">
                            <i class="fas fa-hand-rock mr-1"></i> FOLD
                        </button>
                        <button data-action="bread-folds-done" data-id="${bread.id}" class="bg-crumb text-char ${actionBtn}">
                            DONE WITH FOLDS
                        </button>
                    `}
                    <button data-action="bread-advance" data-id="${bread.id}" class="bg-fridge text-flour ${actionBtn}">
                        <i class="fas fa-snowflake mr-1"></i> INTO FRIDGE
                    </button>
                    ${backSlot}
                </div>
            `;
        }

        if (bread.phase === 'cold_proof') {
            const since = parseSqlDate(bread.cold_proof_at).getTime();
            const elapsedMs = now - since;
            return `
                <div class="text-xs uppercase tracking-widest text-yeast font-semibold mb-1">In the fridge for</div>
                <div class="font-display text-2xl text-fridge leading-none mb-3" data-timer="cold" data-since="${bread.cold_proof_at}">${esc(fmtDuration(elapsedMs))}</div>
                <p class="text-sm text-yeast mb-3">Cold-proof as long as you like — overnight is classic.</p>

                <div class="flex flex-wrap gap-2 items-center">
                    <button data-action="bread-advance" data-id="${bread.id}" class="bg-crust text-flour ${actionBtn}">
                        <i class="fas fa-mug-hot mr-1"></i> PREPARE TO BAKE
                    </button>
                    ${backSlot}
                </div>
            `;
        }

        if (bread.phase === 'bench_rest') {
            const since = parseSqlDate(bread.bench_rest_at).getTime();
            const elapsedMs = now - since;
            return `
                <div class="text-xs uppercase tracking-widest text-yeast font-semibold mb-1">Out of the fridge for</div>
                <div class="font-display text-2xl text-crust leading-none mb-3" data-timer="bench" data-since="${bread.bench_rest_at}">${esc(fmtDuration(elapsedMs))}</div>
                <p class="text-sm text-yeast mb-3">Score, preheat the rest of the way, take your time. Bake when you're ready.</p>

                <div class="flex flex-wrap gap-2 items-center">
                    <button data-action="bread-advance" data-id="${bread.id}" class="bg-rye text-flour ${actionBtn}">
                        <i class="fas fa-fire mr-1"></i> INTO THE OVEN
                    </button>
                    ${backSlot}
                </div>
            `;
        }

        if (bread.phase === 'bake_lid') {
            const endAt   = bakeEndAt(bread);
            const leftSec = (endAt - now) / 1000;
            const overdue = leftSec < 0;
            return `
                <div class="text-xs uppercase tracking-widest text-yeast font-semibold mb-1">Bake · lid on · 240°C</div>
                <div class="font-display text-4xl ${overdue ? 'text-rye' : 'text-char'} leading-none mb-3" data-timer="bake-lid" data-end="${endAt}">${esc(overdue ? `+${fmtTimer(-leftSec)}` : fmtTimer(leftSec))}</div>
                <p class="text-sm text-yeast mb-3">${overdue ? 'Past 35 min — take the lid off!' : '35 minutes covered.'}</p>

                <div class="flex flex-wrap gap-2 items-center">
                    <button data-action="bread-advance" data-id="${bread.id}" class="bg-crust text-flour ${actionBtn}">
                        <i class="fas fa-fire mr-1"></i> LID OFF · 200°C
                    </button>
                    ${backSlot}
                </div>
            `;
        }

        if (bread.phase === 'bake_no_lid') {
            const endAt   = bakeEndAt(bread);
            const leftSec = (endAt - now) / 1000;
            const overdue = leftSec < 0;
            return `
                <div class="text-xs uppercase tracking-widest text-yeast font-semibold mb-1">Bake · lid off · 200°C</div>
                <div class="font-display text-4xl ${overdue ? 'text-rye' : 'text-char'} leading-none mb-3" data-timer="bake-no-lid" data-end="${endAt}">${esc(overdue ? `+${fmtTimer(-leftSec)}` : fmtTimer(leftSec))}</div>
                <p class="text-sm text-yeast mb-3">${overdue ? 'Past 15 min — pull it out!' : '15 minutes uncovered.'}</p>

                <div class="flex flex-wrap gap-2 items-center">
                    <button data-action="bread-advance" data-id="${bread.id}" class="bg-rye text-flour ${actionBtn}">
                        <i class="fas fa-bell mr-1"></i> FINISH BREAD
                    </button>
                    ${backSlot}
                </div>
            `;
        }

        // finished — centered body (stamp lives in the top-right header, back lives in bottom-right row, both rendered by breadCardHtml)
        return `
            <div class="text-center">
                <div class="text-5xl mb-3 select-none">🎉</div>
                <h3 class="font-display text-lg tracking-wider text-char break-words mb-2">${esc(bread.name)}</h3>
                <p class="font-display text-lg tracking-wider text-rye">your loaf is done!</p>
                <p class="text-sm text-yeast mt-1 mb-4">Forget it from the list whenever you're ready.</p>
                <div class="flex justify-center">
                    <button data-action="bread-delete" data-id="${bread.id}" class="bg-char text-flour ${actionBtn}">
                        <i class="fas fa-trash mr-1"></i> FORGET THIS LOAF
                    </button>
                </div>
            </div>
        `;
    }

    function needsAttention(bread) {
        const now = Date.now();
        if (bread.phase === 'bulk_fermentation') {
            const nextFold = nextFoldDueAt(bread);
            if (nextFold !== null && nextFold <= now) return true;
            const elapsed = now - parseSqlDate(bread.mixed_at).getTime();
            if (elapsed > BULK_WINDOW_MAX_MS) return true;
        }
        if (bread.phase === 'bake_lid' || bread.phase === 'bake_no_lid') {
            const end = bakeEndAt(bread);
            if (end !== null && end <= now) return true;
        }
        return false;
    }

    function streamersHtml() {
        const colors = ['#c8741a', '#f3e3c3', '#7c3b0d', '#d4a04c', '#5a8da5'];
        let out = '';
        for (let i = 0; i < 12; i++) {
            const left  = Math.random() * 100;
            const dur   = 2.5 + Math.random() * 2;
            const delay = Math.random() * 3;
            const color = colors[i % colors.length];
            out += `<span class="streamer" style="left:${left}%; background:${color}; animation-duration:${dur}s; animation-delay:${delay}s;"></span>`;
        }
        return out;
    }

    function breadCardHtml(bread) {
        const isFinished = bread.phase === 'finished';
        const attentionCls = needsAttention(bread) ? ' attention' : '';
        const celebrateCls = isFinished ? ' celebrate' : '';
        const streamers = isFinished ? streamersHtml() : '';

        const backBtn = bread.phase !== 'bulk_fermentation'
            ? `<button data-action="bread-back" data-id="${bread.id}" title="Step back to previous phase"
                       class="bg-flour text-char border-2 border-char w-7 h-7 text-xs flex items-center justify-center shadow-stamp-sm hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none transition-all rounded-full">
                   <i class="fas fa-undo"></i>
               </button>`
            : '';

        const header = isFinished
            ? `<div class="flex justify-end mb-3 relative">${phaseStampHtml(bread.phase)}</div>`
            : `
                <div class="flex items-start justify-between gap-3 mb-3 relative">
                    <h3 class="font-display text-lg tracking-wider text-char break-words flex-1 min-w-0">${esc(bread.name)}</h3>
                    <div class="shrink-0">${phaseStampHtml(bread.phase)}</div>
                </div>
            `;

        // On finished cards, the back button doesn't live inside the action row — it sits in the bottom-right of the card.
        const phaseBodyBackBtn = isFinished ? '' : backBtn;
        const bottomBack = (isFinished && backBtn) ? `<div class="flex justify-end mt-4">${backBtn}</div>` : '';

        return `
            <article class="relative bg-crumb border-4 border-char rounded-xl p-5 shadow-stamp${attentionCls}${celebrateCls}" data-bread-id="${bread.id}">
                ${streamers}
                ${header}
                ${phaseBody(bread, phaseBodyBackBtn)}
                ${bottomBack}
            </article>
        `;
    }

    // --- Render orchestration ---

    function renderBreads() {
        breadsLoading.classList.add('hidden');
        breadsError.classList.add('hidden');
        if (breads.length === 0) {
            breadsGrid.classList.add('hidden');
            breadsEmpty.classList.remove('hidden');
            return;
        }
        breadsEmpty.classList.add('hidden');
        breadsGrid.classList.remove('hidden');
        breadsGrid.innerHTML = breads.map(breadCardHtml).join('');
    }

    function showBreadsError(msg) {
        breadsLoading.classList.add('hidden');
        breadsGrid.classList.add('hidden');
        breadsEmpty.classList.add('hidden');
        breadsError.classList.remove('hidden');
        breadsErrorMsg.textContent = msg;
    }

    // --- Live tick (updates timers + checks for bells, no full re-render) ---

    function tick() {
        const now = Date.now();

        // Starter timer
        if (starter) {
            const lastFed = parseSqlDate(starter.last_fed_at);
            const el = starterCard.querySelector('[data-timer="starter"]');
            if (el && lastFed) el.textContent = fmtDuration(now - lastFed.getTime());
        }

        // Bread timers + attention checks
        breads.forEach(bread => {
            const card = breadsGrid.querySelector(`[data-bread-id="${bread.id}"]`);
            if (!card) return;

            if (bread.phase === 'bulk_fermentation') {
                const mixedAt = parseSqlDate(bread.mixed_at).getTime();
                const elapsedMs = now - mixedAt;

                const minLeft = BULK_WINDOW_MIN_MS - elapsedMs;
                const maxLeft = BULK_WINDOW_MAX_MS - elapsedMs;
                const w = card.querySelector(`[data-window="${bread.id}"]`);
                if (w) {
                    if (maxLeft <= 0)         w.innerHTML = `<span class="text-rye font-semibold">Past 8h — fridge it now!</span>`;
                    else if (minLeft <= 0)    w.innerHTML = `In the 4–8h window. <span class="text-yeast">${fmtDuration(maxLeft)} until 8h.</span>`;
                    else                      w.innerHTML = `<span class="text-yeast">${fmtDuration(minLeft)} until earliest fridge time (4h).</span>`;
                }

                const fb = card.querySelector(`[data-fold-block="${bread.id}"]`);
                if (fb) fb.innerHTML = foldBlockHtml(bread, now);

                if (!bread.folds_done_at) {
                    const nextFold = nextFoldDueAt(bread);
                    if (nextFold !== null && nextFold - now <= 0) {
                        const foldsCount = (bread.folds || []).length;
                        ringOnce(`${bread.id}:fold:${foldsCount}`);
                    }
                }
            }

            if (bread.phase === 'cold_proof') {
                const since = parseSqlDate(bread.cold_proof_at).getTime();
                const t = card.querySelector('[data-timer="cold"]');
                if (t) t.textContent = fmtDuration(now - since);
            }

            if (bread.phase === 'bench_rest') {
                const since = parseSqlDate(bread.bench_rest_at).getTime();
                const t = card.querySelector('[data-timer="bench"]');
                if (t) t.textContent = fmtDuration(now - since);
            }

            if (bread.phase === 'bake_lid' || bread.phase === 'bake_no_lid') {
                const endAt = bakeEndAt(bread);
                const leftSec = (endAt - now) / 1000;
                const overdue = leftSec < 0;
                const key = bread.phase === 'bake_lid' ? 'bake-lid' : 'bake-no-lid';
                const t = card.querySelector(`[data-timer="${key}"]`);
                if (t) {
                    t.textContent = overdue ? `+${fmtTimer(-leftSec)}` : fmtTimer(leftSec);
                    t.classList.toggle('text-rye', overdue);
                    t.classList.toggle('text-char', !overdue);
                }
                if (overdue) {
                    ringOnce(`${bread.id}:${bread.phase}:done`);
                }
            }

            // Update attention glow
            card.classList.toggle('attention', needsAttention(bread));
        });
    }

    function ringOnce(key) {
        if (bellsFired.has(key)) return;
        bellsFired.add(key);
        ringBell();
    }

    function startTicker() {
        if (tickInterval) return;
        tickInterval = setInterval(tick, 1000);
    }

    // --- Loading ---

    async function loadAll() {
        try {
            const [s, b] = await Promise.all([
                StarterAPI.get().catch(err => { throw new Error('Starter: ' + err.message); }),
                BreadAPI.list(),
            ]);
            starter = s;
            breads  = b;
            renderStarter();
            renderBreads();
            startTicker();
        } catch (err) {
            showBreadsError(err.message);
        }
    }

    async function refreshStarter() {
        try {
            starter = await StarterAPI.get();
            renderStarter();
        } catch (err) {
            toast(err.message, true);
        }
    }

    async function refreshBreads() {
        try {
            breads = await BreadAPI.list();
            renderBreads();
        } catch (err) {
            toast(err.message, true);
        }
    }

    // --- Modal helpers ---
    function openModal(m)  { m.classList.add('active');    document.body.style.overflow = 'hidden'; }
    function closeModal(m) {
        m.classList.remove('active');
        if (!document.querySelector('.modal-overlay.active')) document.body.style.overflow = '';
    }

    // --- Toast ---
    function toast(msg, isError = false) {
        const t = document.createElement('div');
        t.className = `toast ${isError ? 'bg-rye' : 'bg-char'} text-flour font-display tracking-wider text-sm px-3 py-1.5 border-2 border-char shadow-stamp-sm inline-flex items-center gap-2`;
        t.innerHTML = `<i class="fas fa-${isError ? 'exclamation-circle' : 'check-circle'}"></i> ${esc(msg)}`;
        toastContainer.appendChild(t);
        setTimeout(() => {
            t.classList.add('out');
            t.addEventListener('animationend', () => t.remove());
        }, 3000);
    }

    // --- Event handlers ---

    // Starter buttons (event delegation, card re-renders fully on each action)
    starterCard.addEventListener('click', async e => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        unlockAudio();
        try {
            if (btn.dataset.action === 'starter-feed')     { actionSound('starter-feed');     starter = await StarterAPI.feed();     renderStarter(); toast('Starter fed'); }
            if (btn.dataset.action === 'starter-fridge')   { actionSound('starter-fridge');   starter = await StarterAPI.fridge();   renderStarter(); toast('Starter in fridge'); }
            if (btn.dataset.action === 'starter-unfridge') { actionSound('starter-unfridge'); starter = await StarterAPI.unfridge(); renderStarter(); toast('Starter out of fridge'); }
        } catch (err) { toast(err.message, true); }
    });

    // Bread card buttons (delegation)
    breadsGrid.addEventListener('click', async e => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        unlockAudio();
        const id = parseInt(btn.dataset.id, 10);
        const action = btn.dataset.action;

        try {
            if (action === 'bread-fold') {
                actionSound('bread-fold');
                await BreadAPI.fold(id);
                // Clear bell-fired keys for this bread's pending fold so the next one can ring
                const bread = breads.find(b => b.id === id);
                if (bread) {
                    const foldsCount = (bread.folds || []).length;
                    bellsFired.delete(`${id}:fold:${foldsCount}`);
                }
                await refreshBreads();
                toast('Fold logged');
            }
            else if (action === 'bread-folds-done') {
                actionSound('bread-folds-done');
                await BreadAPI.foldsDone(id);
                await refreshBreads();
                toast('Folds done — resting');
            }
            else if (action === 'bread-advance') {
                const bread = breads.find(b => b.id === id);
                const currentPhase = bread ? bread.phase : null;
                const wasBakeNoLid = currentPhase === 'bake_no_lid';
                await BreadAPI.advance(id);
                if (wasBakeNoLid) {
                    ringBell({ celebratory: true });
                } else if (currentPhase) {
                    const nextIdx = PHASE_ORDER.indexOf(currentPhase) + 1;
                    phaseTransitionSound(PHASE_ORDER[nextIdx]);
                }
                await refreshBreads();
                if (wasBakeNoLid) toast('Bread finished! 🎉');
            }
            else if (action === 'bread-back') {
                await BreadAPI.back(id);
                for (const key of Array.from(bellsFired)) {
                    if (key.startsWith(`${id}:`)) bellsFired.delete(key);
                }
                backSound();
                await refreshBreads();
                toast('Stepped back one phase');
            }
            else if (action === 'bread-delete') {
                const bread = breads.find(b => b.id === id);
                deleteTargetId = id;
                deleteBreadName.textContent = bread ? bread.name : '';
                openModal(deleteModal);
            }
        } catch (err) {
            toast(err.message, true);
        }
    });

    // New bread modal
    newBreadBtn.addEventListener('click', () => {
        unlockAudio();
        newBreadForm.reset();
        newBreadError.classList.add('hidden');
        openModal(newBreadModal);
        setTimeout(() => breadNameInput.focus(), 50);
    });
    document.getElementById('newBreadClose').addEventListener('click', () => closeModal(newBreadModal));
    document.getElementById('newBreadCancel').addEventListener('click', () => closeModal(newBreadModal));
    newBreadForm.addEventListener('submit', async e => {
        e.preventDefault();
        const name = breadNameInput.value.trim();
        if (!name) {
            newBreadError.textContent = 'Give your loaf a name first.';
            newBreadError.classList.remove('hidden');
            return;
        }
        const submitBtn = newBreadForm.querySelector('button[type="submit"]');
        submitBtn.querySelector('.btn-text').classList.add('hidden');
        submitBtn.querySelector('.btn-loading').classList.remove('hidden');
        submitBtn.disabled = true;
        try {
            actionSound('bread-create');
            await BreadAPI.create(name);
            closeModal(newBreadModal);
            await refreshBreads();
            toast('Dough mixed — timer started');
        } catch (err) {
            newBreadError.textContent = err.message;
            newBreadError.classList.remove('hidden');
        } finally {
            submitBtn.querySelector('.btn-text').classList.remove('hidden');
            submitBtn.querySelector('.btn-loading').classList.add('hidden');
            submitBtn.disabled = false;
        }
    });

    // Delete modal
    document.getElementById('deleteCancelBtn').addEventListener('click', () => {
        deleteTargetId = null;
        closeModal(deleteModal);
    });
    document.getElementById('deleteConfirmBtn').addEventListener('click', async () => {
        if (!deleteTargetId) return;
        try {
            actionSound('bread-delete');
            await BreadAPI.remove(deleteTargetId);
            closeModal(deleteModal);
            await refreshBreads();
            toast('Loaf forgotten');
        } catch (err) {
            toast(err.message, true);
        }
        deleteTargetId = null;
    });

    // Close modals on overlay click
    [newBreadModal, deleteModal].forEach(m => {
        m.addEventListener('click', e => { if (e.target === m) closeModal(m); });
    });

    // Esc closes top modal
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            const open = document.querySelector('.modal-overlay.active');
            if (open) closeModal(open);
        }
    });

    document.getElementById('retryBtn').addEventListener('click', loadAll);

    // First user interaction anywhere unlocks audio (for autoplay policy)
    document.addEventListener('click', unlockAudio, { once: true });

    // --- Init ---
    loadAll();
})();
