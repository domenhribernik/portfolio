const API = '../../app/controllers/presence-controller.php';

const BEHAVIORS = [
    { key: 'good_morning',               label: 'Good morning message',          hint: 'First message of her day, unprompted.' },
    { key: 'good_night',                 label: 'Good night message',            hint: 'Closing the day with something specific.' },
    { key: 'voice_or_video',             label: 'Voice note or call',            hint: 'Richer than text — at least one today.' },
    { key: 'unprompted_thinking_of_you', label: 'Unprompted thinking-of-you',    hint: 'A photo, song, or thought tied to her.' },
    { key: 'present_when_we_talked',     label: 'Present when we talked',        hint: 'Phone down, eyes up. Skip if no contact today.' },
];

const NMMNG_PROMPTS = [
    'Where did I make her work to feel close to me today?',
    'What did I want from her today that I didn\'t ask for directly?',
    'When she reached out, did I receive her or manage her?',
    'Did I do the bare minimum and call it effort?',
    'What did I do today only because I\'d feel guilty otherwise?',
    'If she described today to a friend, what would she say about me?',
    'Whose approval was I chasing — hers, mine, or someone else\'s?',
    'Where did I abandon myself to keep the peace?',
    'What truth did I soften today that she deserved straight?',
    'Did I show up as a partner or as a project manager?',
];

// --- state ---

const state = {
    today: null,      // presence_daily row for today
    metrics: null,    // full metrics payload
    settings: {},
    mentioned: [],
    triggers: [],
};

// --- API ---

async function apiFetch(params, opts = {}) {
    const url = API + '?' + new URLSearchParams(params);
    const res = await fetch(url, opts);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
}

async function saveDaily(patch) {
    const data = { entry_date: todayDate(), ...patch };
    const result = await apiFetch({ resource: 'daily' }, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    state.today = result;
    return result;
}

async function fetchMetrics() {
    state.metrics = await apiFetch({ resource: 'metrics' });
    state.settings = state.metrics.settings || {};
    return state.metrics;
}

async function fetchMentioned() {
    state.mentioned = await apiFetch({ resource: 'mentioned' });
    return state.mentioned;
}

async function fetchTriggers(date) {
    state.triggers = await apiFetch({ resource: 'triggers', date: date || todayDate() });
    return state.triggers;
}

// --- date helpers ---

function todayDate() {
    return new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD via Swedish locale
}

function promptForDate(dateStr) {
    const parts = dateStr.split('-');
    const n = (parseInt(parts[0]) * 366) + (parseInt(parts[1]) * 31) + parseInt(parts[2]);
    return NMMNG_PROMPTS[n % NMMNG_PROMPTS.length];
}

function daysBetween(dateStr1, dateStr2) {
    const a = new Date(dateStr1), b = new Date(dateStr2);
    return Math.round(Math.abs((b - a) / 86400000));
}

function daysFromNow(dateStr) {
    const today = new Date(); today.setHours(0,0,0,0);
    const d = new Date(dateStr); d.setHours(0,0,0,0);
    return Math.round((d - today) / 86400000);
}

// --- debounce ---

function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// --- save indicator ---

function showSaveIndicator(state) {
    const el = document.getElementById('save-indicator');
    if (!el) return;
    el.textContent = state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Error saving';
    el.className = 'text-xs text-right h-4 ' + (state === 'error' ? 'text-rose' : 'text-muted');
    if (state === 'saved') setTimeout(() => { el.textContent = ''; }, 2000);
}

// --- toast ---

function toast(message, type = 'info') {
    const existing = document.getElementById('toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.id = 'toast';
    el.textContent = message;
    const color = type === 'error' ? 'bg-bad' : type === 'success' ? 'bg-sage' : 'bg-panel';
    el.className = `fixed bottom-5 right-5 z-50 px-4 py-2 rounded-md text-sm text-text shadow-soft border border-edge ${color}`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
}

// =============================================================================
// TODAY SECTION
// =============================================================================

function renderBehaviors() {
    const root = document.getElementById('behaviors');
    if (!root) return;
    const today = state.today || {};
    root.innerHTML = BEHAVIORS.map(b => {
        const val = today[b.key];
        const label = val === 1 ? '✓' : val === 0 ? '✗' : '—';
        const cls = val === 1
            ? 'bg-sage/20 border-sage text-sage'
            : val === 0
            ? 'bg-bad/20 border-bad text-rose'
            : 'bg-panel border-edge text-muted';
        return `
            <div class="flex items-center justify-between gap-3 py-1.5">
                <div class="min-w-0">
                    <div class="text-text text-sm">${b.label}</div>
                    <div class="text-dim text-xs">${b.hint}</div>
                </div>
                <button class="toggle px-3 py-1.5 rounded-md border text-sm w-12 text-center transition ${cls}"
                        data-key="${b.key}" data-val="${val === null ? 'null' : val}">
                    ${label}
                </button>
            </div>`;
    }).join('');

    root.querySelectorAll('.toggle').forEach(btn => {
        btn.addEventListener('click', handleBehaviorToggle);
    });
}

function renderSilentLeaves() {
    const el = document.getElementById('silent-count');
    if (el) el.textContent = (state.today?.silent_leaves ?? 0).toString();
}

function renderReflections() {
    const today = state.today || {};
    const dateStr = todayDate();

    const reflEl = document.getElementById('reflection');
    if (reflEl) {
        reflEl.placeholder = promptForDate(dateStr);
        reflEl.value = today.reflection || '';
    }
    const covertEl = document.getElementById('covert');
    if (covertEl) covertEl.value = today.covert_contract_noticed || '';
    const showedEl = document.getElementById('showed-up');
    if (showedEl) showedEl.value = today.where_i_showed_up || '';
}

async function handleBehaviorToggle(e) {
    const btn = e.currentTarget;
    const key = btn.dataset.key;
    const current = btn.dataset.val === 'null' ? null : parseInt(btn.dataset.val);
    // Cycle: null → 1 → 0 → null
    const next = current === null ? 1 : current === 1 ? 0 : null;

    // Optimistic update
    if (!state.today) state.today = {};
    state.today[key] = next;
    renderBehaviors();
    showSaveIndicator('saving');

    try {
        await saveDaily({ [key]: next });
        showSaveIndicator('saved');
    } catch {
        state.today[key] = current; // rollback
        renderBehaviors();
        showSaveIndicator('error');
    }
}

const debouncedSaveText = debounce(async () => {
    showSaveIndicator('saving');
    try {
        await saveDaily({
            reflection:              document.getElementById('reflection')?.value  || '',
            covert_contract_noticed: document.getElementById('covert')?.value      || '',
            where_i_showed_up:       document.getElementById('showed-up')?.value   || '',
        });
        showSaveIndicator('saved');
    } catch {
        showSaveIndicator('error');
    }
}, 600);

function wireSilentLeaves() {
    document.getElementById('silent-minus')?.addEventListener('click', async () => {
        const cur = state.today?.silent_leaves ?? 0;
        if (cur <= 0) return;
        if (!state.today) state.today = {};
        state.today.silent_leaves = cur - 1;
        renderSilentLeaves();
        try { await saveDaily({ silent_leaves: cur - 1 }); } catch { state.today.silent_leaves = cur; renderSilentLeaves(); }
    });
    document.getElementById('silent-plus')?.addEventListener('click', async () => {
        const cur = state.today?.silent_leaves ?? 0;
        if (!state.today) state.today = {};
        state.today.silent_leaves = cur + 1;
        renderSilentLeaves();
        try { await saveDaily({ silent_leaves: cur + 1 }); } catch { state.today.silent_leaves = cur; renderSilentLeaves(); }
    });
}

function wireReflections() {
    ['reflection', 'covert', 'showed-up'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', debouncedSaveText);
    });
}

function initToday() {
    const el = document.getElementById('today-date');
    if (el) {
        const d = new Date();
        el.textContent = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    }
    renderBehaviors();
    renderSilentLeaves();
    renderReflections();
    wireSilentLeaves();
    wireReflections();
}

// =============================================================================
// SHE MENTIONED SECTION
// =============================================================================

function mentionedRowHtml(item) {
    const isOverdue = !item.followed_up && item.follow_up_by && item.follow_up_by < todayDate();
    const isDone = item.followed_up;
    const rowClass = isDone ? 'opacity-40' : isOverdue ? 'mentioned-row overdue' : 'mentioned-row';
    const followUp = item.follow_up_by
        ? `<span class="text-dim text-xs ml-2">follow up ${item.follow_up_by}</span>` : '';
    const detail = item.detail ? `<div class="text-dim text-xs mt-0.5">${item.detail}</div>` : '';
    const actions = isDone
        ? `<button class="text-dim text-xs hover:text-bad transition del-mentioned" data-id="${item.id}">remove</button>`
        : `<div class="flex gap-3">
            <button class="text-xs text-sage hover:text-amberHi transition followup-mentioned" data-id="${item.id}">✓ done</button>
            <button class="text-dim text-xs hover:text-bad transition del-mentioned" data-id="${item.id}">✕</button>
           </div>`;
    return `<div class="flex items-start justify-between gap-3 py-2 border-b border-edge last:border-0 ${rowClass}" data-id="${item.id}">
        <div class="min-w-0">
            <span class="text-sm text-text">${item.topic}</span>${followUp}
            ${detail}
        </div>
        ${actions}
    </div>`;
}

function renderMentioned() {
    const list = document.getElementById('mentioned-list');
    if (!list) return;
    if (!state.mentioned.length) {
        list.innerHTML = '<p class="text-dim text-sm italic">Nothing logged yet.</p>';
        return;
    }
    list.innerHTML = state.mentioned.map(mentionedRowHtml).join('');

    list.querySelectorAll('.followup-mentioned').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            try {
                await apiFetch({ resource: 'mentioned', action: 'followup', id }, { method: 'POST' });
                await fetchMentioned();
                renderMentioned();
            } catch { toast('Error marking as done', 'error'); }
        });
    });
    list.querySelectorAll('.del-mentioned').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            try {
                await apiFetch({ resource: 'mentioned', id }, { method: 'DELETE' });
                await fetchMentioned();
                renderMentioned();
            } catch { toast('Error deleting', 'error'); }
        });
    });
}

function wireMentionedForm() {
    document.getElementById('mentioned-form')?.addEventListener('submit', async e => {
        e.preventDefault();
        const topic = document.getElementById('mentioned-topic')?.value.trim();
        const detail = document.getElementById('mentioned-detail')?.value.trim();
        const followUpBy = document.getElementById('mentioned-followup')?.value;
        if (!topic) return;
        try {
            await apiFetch({ resource: 'mentioned' }, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ topic, detail, follow_up_by: followUpBy }),
            });
            document.getElementById('mentioned-topic').value = '';
            document.getElementById('mentioned-detail').value = '';
            document.getElementById('mentioned-followup').value = '';
            await fetchMentioned();
            renderMentioned();
        } catch { toast('Error adding item', 'error'); }
    });
}

// =============================================================================
// TRIGGERS SECTION
// =============================================================================

function triggerRowHtml(t) {
    const next = t.what_i_could_do_next_time
        ? `<div class="text-dim text-xs mt-0.5">Next time: ${t.what_i_could_do_next_time}</div>` : '';
    return `<div class="flex items-start justify-between gap-3 py-2 border-b border-edge last:border-0">
        <div class="min-w-0">
            <div class="text-sm text-text">${t.situation}</div>
            <div class="text-muted text-xs">→ ${t.what_i_did}</div>
            ${next}
        </div>
        <button class="text-dim text-xs hover:text-bad transition flex-shrink-0 del-trigger" data-id="${t.id}">✕</button>
    </div>`;
}

function renderTriggers() {
    const list = document.getElementById('trigger-list');
    if (!list) return;
    if (!state.triggers.length) {
        list.innerHTML = '<p class="text-dim text-sm italic">No triggers logged today.</p>';
        return;
    }
    list.innerHTML = state.triggers.map(triggerRowHtml).join('');
    list.querySelectorAll('.del-trigger').forEach(btn => {
        btn.addEventListener('click', async () => {
            try {
                await apiFetch({ resource: 'triggers', id: btn.dataset.id }, { method: 'DELETE' });
                await fetchTriggers();
                renderTriggers();
            } catch { toast('Error deleting', 'error'); }
        });
    });
}

function wireTriggerForm() {
    document.getElementById('trigger-form')?.addEventListener('submit', async e => {
        e.preventDefault();
        const situation = document.getElementById('trigger-situation')?.value.trim();
        const whatIDid  = document.getElementById('trigger-did')?.value.trim();
        const next      = document.getElementById('trigger-next')?.value.trim();
        if (!situation || !whatIDid) return;
        try {
            await apiFetch({ resource: 'triggers' }, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ situation, what_i_did: whatIDid, what_i_could_do_next_time: next }),
            });
            document.getElementById('trigger-situation').value = '';
            document.getElementById('trigger-did').value = '';
            document.getElementById('trigger-next').value = '';
            await fetchTriggers();
            renderTriggers();
        } catch { toast('Error logging trigger', 'error'); }
    });
}

// =============================================================================
// WEEKLY REVIEW SECTION
// =============================================================================

function renderWeekly(weekly, editable) {
    const body = document.getElementById('weekly-body');
    const sub  = document.getElementById('weekly-subtitle');
    if (!body) return;
    if (sub) {
        sub.textContent = editable
            ? `Week ${weekly.year_week} — open for review today`
            : `Week ${weekly.year_week} — last saved review (read-only)`;
    }

    const scores = [
        { key: 'presence_score',     label: 'Presence' },
        { key: 'initiation_score',   label: 'Initiation' },
        { key: 'consistency_score',  label: 'Consistency' },
        { key: 'depth_score',        label: 'Depth' },
    ];
    const texts = [
        { key: 'what_she_said_she_needed',   label: 'What she said she needed', placeholder: 'One sentence — anchor yourself in her reality.' },
        { key: 'where_i_made_her_chase_me',  label: 'Where I made her chase me', placeholder: 'The honest one.' },
        { key: 'next_week_one_thing',         label: 'Next week — one thing',     placeholder: 'Single concrete commitment, reviewed next Sunday.' },
    ];

    if (editable) {
        body.innerHTML = `
            <div class="space-y-5">
                <div class="grid grid-cols-2 gap-4">
                    ${scores.map(s => `
                        <label class="block">
                            <span class="text-dim uppercase text-[10px] tracking-widest">${s.label}</span>
                            <div class="flex items-center gap-2 mt-1">
                                <input type="range" id="score-${s.key}" min="1" max="10"
                                       value="${weekly[s.key] || 5}"
                                       class="flex-1 accent-amber">
                                <span id="score-val-${s.key}" class="font-serif text-lg w-6 text-amber text-right">${weekly[s.key] || '—'}</span>
                            </div>
                        </label>`).join('')}
                </div>
                ${texts.map(t => `
                    <label class="block">
                        <span class="text-dim uppercase text-[10px] tracking-widest">${t.label}</span>
                        <textarea id="wtext-${t.key}" rows="2" class="mt-1 w-full bg-panel border border-edge rounded-md p-3 text-text placeholder-dim focus:border-amber focus:outline-none transition resize-none"
                                  placeholder="${t.placeholder}">${weekly[t.key] || ''}</textarea>
                    </label>`).join('')}
                <button id="weekly-save" class="bg-amber text-ink font-medium rounded-md px-5 py-2 hover:bg-amberHi transition">Save review</button>
            </div>`;

        scores.forEach(s => {
            const slider = document.getElementById(`score-${s.key}`);
            const val    = document.getElementById(`score-val-${s.key}`);
            if (slider && val) {
                slider.addEventListener('input', () => { val.textContent = slider.value; });
            }
        });

        document.getElementById('weekly-save')?.addEventListener('click', async () => {
            const patch = { year_week: weekly.year_week };
            scores.forEach(s => {
                patch[s.key] = parseInt(document.getElementById(`score-${s.key}`)?.value);
            });
            texts.forEach(t => {
                patch[t.key] = document.getElementById(`wtext-${t.key}`)?.value || '';
            });
            try {
                await apiFetch({ resource: 'weekly' }, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(patch),
                });
                toast('Weekly review saved', 'success');
            } catch { toast('Error saving review', 'error'); }
        });
    } else {
        const scoreHtml = scores.map(s => {
            const v = weekly[s.key];
            return `<div class="flex items-center gap-2">
                <span class="text-dim text-xs w-24">${s.label}</span>
                <div class="flex-1 h-1.5 bg-edge rounded-full overflow-hidden">
                    <div class="h-full bg-amber rounded-full" style="width:${v ? v*10 : 0}%"></div>
                </div>
                <span class="font-serif text-sm text-amber w-4">${v ?? '—'}</span>
            </div>`;
        }).join('');
        const textHtml = texts.filter(t => weekly[t.key]).map(t =>
            `<div><div class="text-dim uppercase text-[10px] tracking-widest">${t.label}</div>
             <div class="text-text text-sm mt-1">${weekly[t.key]}</div></div>`
        ).join('');
        body.innerHTML = `<div class="space-y-3">${scoreHtml}${textHtml ? '<div class="border-t border-edge pt-3 space-y-3">' + textHtml + '</div>' : ''}</div>`;
    }
}

async function initWeekly() {
    const dow = new Date().getDay(); // 0=Sun,1=Mon..6=Sat
    const editable = dow === 0 || dow === 1;
    const yw = state.metrics?.iso_year_week;
    try {
        const weekly = await apiFetch({ resource: 'weekly', year_week: yw });
        renderWeekly(weekly, editable);
    } catch { document.getElementById('weekly-body').textContent = 'Could not load weekly review.'; }
}

// =============================================================================
// HER RIGHT NOW STRIP
// =============================================================================

function renderHerRightNow() {
    const s = state.settings;
    const tz = s.her_timezone || 'Europe/Ljubljana';

    const herTime = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());
    const el = document.getElementById('her-time');
    if (el) el.textContent = herTime;

    const today = todayDate();
    const nextVisit = s.next_visit_date;
    const lastVisit = s.last_visit_date;

    const nextEl = document.getElementById('next-visit');
    if (nextEl) {
        if (nextVisit) {
            const diff = daysFromNow(nextVisit);
            nextEl.textContent = diff === 0 ? 'today' : diff > 0 ? `in ${diff}d` : 'past';
        } else {
            nextEl.textContent = 'not set';
            nextEl.className = nextEl.className.replace('text-text', 'text-muted');
        }
    }

    const lastEl = document.getElementById('last-visit');
    if (lastEl) {
        if (lastVisit) {
            const diff = daysBetween(lastVisit, today);
            lastEl.textContent = diff === 0 ? 'today' : `${diff}d ago`;
        } else {
            lastEl.textContent = '—';
        }
    }

    const m = state.metrics;
    const contactEl = document.getElementById('last-contact');
    if (contactEl && m?.last_contact_date) {
        const diff = daysBetween(m.last_contact_date, today);
        contactEl.textContent = diff === 0 ? 'today' : `${diff}d ago`;
    } else if (contactEl) {
        contactEl.textContent = '—';
    }

    const callEl = document.getElementById('last-call');
    if (callEl && m?.last_call_date) {
        const diff = daysBetween(m.last_call_date, today);
        callEl.textContent = `Last call: ${diff === 0 ? 'today' : diff + 'd ago'}`;
    } else if (callEl) {
        callEl.textContent = '';
    }
}

// =============================================================================
// METRICS SECTION
// =============================================================================

function renderWPI() {
    const m = state.metrics;
    if (!m) return;
    const el = document.getElementById('wpi');
    if (el) el.textContent = m.weekly_presence_index ?? '0';
    const bd = document.getElementById('wpi-breakdown');
    if (bd && m.wpi_breakdown) {
        const b = m.wpi_breakdown;
        bd.textContent = `Behaviors +${b.behavior_total}  ·  Silent leaves −${b.silent_leaves}  ·  Follow-throughs +${b.followups_bonus}`;
    }
}

function renderHeatmap() {
    const m = state.metrics;
    const root = document.getElementById('heatmap');
    if (!m || !root) return;

    const labels = ['Morning', 'Night', 'Voice/Vid', 'Thinking', 'Present'];
    const keys   = ['good_morning','good_night','voice_or_video','unprompted_thinking_of_you','present_when_we_talked'];

    let html = '';
    keys.forEach((key, i) => {
        html += `<div class="hm-label">${labels[i]}</div>`;
        m.last_30_days.forEach(day => {
            const v = day[key];
            const cls = !day.has_entry ? 'miss' : v === 1 ? 'on' : v === 0 ? 'off' : 'na';
            const title = `${day.entry_date}: ${v === 1 ? 'yes' : v === 0 ? 'no' : '—'}`;
            html += `<div class="hm-cell ${cls}" title="${title}"></div>`;
        });
    });
    root.innerHTML = html;
}

function renderStreaks() {
    const m = state.metrics;
    const grid = document.getElementById('streak-grid');
    if (!m || !grid) return;

    const items = [
        { key: 'good_morning',               label: 'Morning' },
        { key: 'good_night',                 label: 'Night' },
        { key: 'voice_or_video',             label: 'Voice/Call' },
        { key: 'unprompted_thinking_of_you', label: 'Thinking of her' },
        { key: 'present_when_we_talked',     label: 'Present' },
        { key: 'no_silent_leave',            label: 'No silent leave' },
    ];

    grid.innerHTML = items.map(item => {
        const n = m.streaks?.[item.key] ?? 0;
        return `<div class="bg-card border border-edge rounded-lg p-4 shadow-soft text-center">
            <div class="font-serif text-3xl text-amber">${n}</div>
            <div class="text-dim text-xs mt-1">${item.label}</div>
            <div class="text-dim text-[10px]">day streak</div>
        </div>`;
    }).join('');
}

let weeklyChart = null;
let triggerChart = null;

function renderCharts() {
    const m = state.metrics;
    if (!m) return;

    // Weekly scores chart
    const wCtx = document.getElementById('weeklyChart');
    if (wCtx) {
        if (weeklyChart) weeklyChart.destroy();
        const labels = m.last_12_weeks.map(w => w.year_week.replace(/^\d{4}-/, ''));
        const chartColor = { presence: '#d4a574', initiation: '#7a9b7a', consistency: '#b87a7a', depth: '#8a8780' };
        weeklyChart = new Chart(wCtx, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    { label: 'Presence',    data: m.last_12_weeks.map(w => w.presence_score),    borderColor: chartColor.presence,    tension: 0.3, pointRadius: 3 },
                    { label: 'Initiation',  data: m.last_12_weeks.map(w => w.initiation_score),  borderColor: chartColor.initiation,  tension: 0.3, pointRadius: 3 },
                    { label: 'Consistency', data: m.last_12_weeks.map(w => w.consistency_score), borderColor: chartColor.consistency, tension: 0.3, pointRadius: 3 },
                    { label: 'Depth',       data: m.last_12_weeks.map(w => w.depth_score),       borderColor: chartColor.depth,       tension: 0.3, pointRadius: 3 },
                ].map(d => ({ ...d, fill: false, borderWidth: 2, backgroundColor: d.borderColor })),
            },
            options: {
                responsive: true,
                plugins: { legend: { labels: { color: '#8a8780', boxWidth: 12 } } },
                scales: {
                    x: { ticks: { color: '#5a5852' }, grid: { color: '#2a2e38' } },
                    y: { min: 0, max: 10, ticks: { color: '#5a5852', stepSize: 2 }, grid: { color: '#2a2e38' } },
                },
            },
        });
    }

    // Trigger count bar chart
    const tCtx = document.getElementById('triggerChart');
    if (tCtx) {
        if (triggerChart) triggerChart.destroy();
        const tData = m.triggers_last_14_days || [];
        triggerChart = new Chart(tCtx, {
            type: 'bar',
            data: {
                labels: tData.map(d => d.entry_date.slice(5)),
                datasets: [{
                    label: 'Triggers',
                    data: tData.map(d => d.count),
                    backgroundColor: '#d4a57466',
                    borderColor: '#d4a574',
                    borderWidth: 1,
                }],
            },
            options: {
                responsive: true,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: '#5a5852', maxTicksLimit: 7 }, grid: { color: '#2a2e38' } },
                    y: { min: 0, ticks: { color: '#5a5852', stepSize: 1, precision: 0 }, grid: { color: '#2a2e38' } },
                },
            },
        });
    }
}

function renderMetrics() {
    renderWPI();
    renderHeatmap();
    renderStreaks();
    renderCharts();
}

// =============================================================================
// SETTINGS
// =============================================================================

function renderSettings() {
    const s = state.settings;
    const tz   = document.getElementById('set-tz');
    const next = document.getElementById('set-next');
    const last = document.getElementById('set-last');
    if (tz)   tz.value   = s.her_timezone     || '';
    if (next) next.value = s.next_visit_date   || '';
    if (last) last.value = s.last_visit_date   || '';
}

function wireSettings() {
    document.getElementById('settings-toggle')?.addEventListener('click', () => {
        document.getElementById('settings-body')?.classList.toggle('hidden');
    });

    document.getElementById('settings-save')?.addEventListener('click', async () => {
        const tz   = document.getElementById('set-tz')?.value.trim();
        const next = document.getElementById('set-next')?.value;
        const last = document.getElementById('set-last')?.value;
        try {
            if (tz)          await apiFetch({ resource: 'settings' }, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ key: 'her_timezone',    value: tz }) });
            if (next !== undefined) await apiFetch({ resource: 'settings' }, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ key: 'next_visit_date', value: next }) });
            if (last !== undefined) await apiFetch({ resource: 'settings' }, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ key: 'last_visit_date', value: last }) });

            state.settings = { her_timezone: tz, next_visit_date: next, last_visit_date: last };
            renderHerRightNow();
            renderSettings();
            toast('Settings saved', 'success');
            document.getElementById('settings-body')?.classList.add('hidden');
        } catch { toast('Error saving settings', 'error'); }
    });
}

// =============================================================================
// INIT
// =============================================================================

async function init() {
    try {
        const [metricsData, mentionedData, triggersData] = await Promise.all([
            fetchMetrics(),
            fetchMentioned(),
            fetchTriggers(),
        ]);
        state.today = metricsData.today;

        // Render all sections
        initToday();
        renderMentioned();
        renderTriggers();
        await initWeekly();
        renderHerRightNow();
        renderMetrics();
        renderSettings();

        // Wire forms
        wireMentionedForm();
        wireTriggerForm();
        wireSettings();

        // Live clock tick
        setInterval(renderHerRightNow, 30000);
    } catch (err) {
        console.error('Presence init error:', err);
        toast('Could not load data — is XAMPP running?', 'error');
    }
}

document.addEventListener('DOMContentLoaded', init);
