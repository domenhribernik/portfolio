// Compass (views/compass): DOM glue for the private No More Mr. Nice Guy
// practice tracker. All decision logic lives in logic.js (unit-tested);
// this file only renders and talks to the admin-gated controller.
import { gatedFetch, loginUrl } from '../../components/auth-gate.js';
import {
    PRACTICES, PATTERNS, ACTIVITIES, CHAPTERS,
    dateKey, shiftKey, dayScore, GOAL,
    streak, lastNDays, practiceRates, catchCounts, activityProgress,
} from './logic.js';

const API = '../../app/controllers/compass-controller.php';
const TABS = ['today', 'catch', 'work', 'progress'];

const $ = (id) => document.getElementById(id);

let state = { checkins: [], catches: [], activities: [] };
let viewingYesterday = false;
let selectedPattern = null;

// ------------------------------------------------------------------
//  Boot: gated load of the whole state
// ------------------------------------------------------------------

function setBody(mode) {
    document.body.className = document.body.className
        .replace(/\b(loading|signin|noaccess|error|ready)\b/g, '').trim() + ' ' + mode;
}

async function load() {
    setBody('loading');
    await gatedFetch(API + '?resource=state', {}, {
        onSignedOut: () => {
            $('signinLink').href = loginUrl();
            setBody('signin');
        },
        onForbidden: () => setBody('noaccess'),
        onOk: (data) => {
            state = data;
            setBody('ready');
            renderWork();       // static list, built once
            renderPatterns();   // static grid, built once
            renderAll();
            initTabs();
        },
        onError: (message) => {
            $('errorMsg').textContent = message;
            setBody('error');
        },
    });
}

$('retryBtn').addEventListener('click', load);

/** POST a write and return the parsed body; throws on any failure. */
async function api(resource, body, method = 'POST', id = null) {
    const url = API + '?resource=' + resource + (id ? '&id=' + id : '');
    const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || 'Request failed (' + res.status + ')');
    return data;
}

// Everything derived from state that appears on more than one tab.
function renderAll() {
    renderToday();
    renderCatchList();
    renderWorkSummary();
    renderProgress();
    $('streakNum').textContent = streak(state.checkins, dateKey(new Date()));
}

// ------------------------------------------------------------------
//  Tabs (hash-routed)
// ------------------------------------------------------------------

function selectTab(name) {
    if (!TABS.includes(name)) name = 'today';
    for (const btn of document.querySelectorAll('.tab')) {
        btn.classList.toggle('active', btn.dataset.tab === name);
    }
    for (const tab of TABS) {
        $('tab-' + tab).classList.toggle('active', tab === name);
    }
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
}

function initTabs() {
    for (const btn of document.querySelectorAll('.tab')) {
        btn.addEventListener('click', () => selectTab(btn.dataset.tab));
    }
    window.addEventListener('hashchange', () => selectTab(location.hash.slice(1)));
    selectTab(location.hash.slice(1));
}

// ------------------------------------------------------------------
//  Today
// ------------------------------------------------------------------

function activeDayKey() {
    const today = dateKey(new Date());
    return viewingYesterday ? shiftKey(today, -1) : today;
}

function checkinFor(day) {
    return state.checkins.find(c => c.day === day) || { day, practices: {}, note: null };
}

function renderToday() {
    const day = activeDayKey();
    const entry = checkinFor(day);
    const [y, m, d] = day.split('-').map(Number);
    $('dayTitle').textContent = new Date(y, m - 1, d).toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long',
    });
    $('dayToday').classList.toggle('bg-ink', !viewingYesterday);
    $('dayToday').classList.toggle('text-paper', !viewingYesterday);
    $('dayYesterday').classList.toggle('bg-ink', viewingYesterday);
    $('dayYesterday').classList.toggle('text-paper', viewingYesterday);

    const list = $('practiceList');
    list.innerHTML = '';
    for (const p of PRACTICES) {
        const done = entry.practices[p.key] === true;
        const row = document.createElement('div');
        row.className = 'practice' + (done ? ' done' : '');
        row.setAttribute('role', 'checkbox');
        row.setAttribute('aria-checked', String(done));
        row.tabIndex = 0;
        row.innerHTML = `
            <div class="box" aria-hidden="true">✓</div>
            <div>
                <div class="p-label font-display font-semibold text-[1.05rem] leading-tight">${p.label}</div>
                <div class="text-[0.82rem] text-stone mt-0.5">${p.detail}</div>
                <button type="button" class="p-toggle font-mono text-[0.62rem] uppercase tracking-widest text-stone hover:text-ink mt-1.5">Why this matters</button>
                <div class="p-why text-[0.8rem] text-stone italic border-l-2 border-hairline pl-3 mt-1.5">${p.why}</div>
            </div>`;
        const toggle = () => togglePractice(p.key);
        row.addEventListener('click', toggle);
        row.addEventListener('keydown', (e) => {
            if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
        });
        row.querySelector('.p-toggle').addEventListener('click', (e) => {
            e.stopPropagation();
            row.classList.toggle('open');
        });
        list.appendChild(row);
    }

    const score = dayScore(entry.practices);
    $('dayMeter').textContent = score + ' / ' + PRACTICES.length;
    const kept = score >= GOAL;
    $('dayKept').textContent = kept ? 'day kept' : 'kept at ' + GOAL;
    $('dayKept').className = 'font-mono text-[0.65rem] uppercase tracking-[0.2em] '
        + (kept ? 'text-pine font-bold' : 'text-stone');

    $('dayNote').value = entry.note || '';
}

function upsertLocalCheckin(saved) {
    const i = state.checkins.findIndex(c => c.day === saved.day);
    if (i >= 0) state.checkins[i] = saved;
    else state.checkins.unshift(saved);
}

async function togglePractice(key) {
    const day = activeDayKey();
    const entry = checkinFor(day);
    const practices = { ...entry.practices, [key]: entry.practices[key] !== true };
    await saveCheckin({ day, practices, note: entry.note || '' });
}

async function saveCheckin(payload, flash = 'saved') {
    try {
        const saved = await api('checkin', payload);
        upsertLocalCheckin(saved);
        renderAll();
        flashSave(flash);
    } catch (err) {
        flashSave(err.message, true);
    }
}

function flashSave(text, isError = false) {
    const el = $('saveState');
    el.textContent = text;
    el.className = 'font-mono text-[0.65rem] ml-auto saved-flash ' + (isError ? 'text-terra' : 'text-pine');
    el.offsetWidth; // restart the animation
}

$('dayToday').addEventListener('click', () => { viewingYesterday = false; renderToday(); });
$('dayYesterday').addEventListener('click', () => { viewingYesterday = true; renderToday(); });
$('noteSave').addEventListener('click', () => {
    const day = activeDayKey();
    const entry = checkinFor(day);
    saveCheckin({ day, practices: entry.practices, note: $('dayNote').value }, 'note saved');
});

// ------------------------------------------------------------------
//  Catch log
// ------------------------------------------------------------------

function renderPatterns() {
    const grid = $('patternGrid');
    grid.innerHTML = '';
    for (const p of PATTERNS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pattern';
        btn.innerHTML = `
            <div class="font-display font-semibold text-[1rem] leading-tight">${p.label}</div>
            <div class="text-[0.78rem] text-stone mt-1">${p.hint}</div>`;
        btn.addEventListener('click', () => {
            selectedPattern = p;
            for (const b of grid.children) b.classList.toggle('selected', b === btn);
            $('catchPatternLabel').textContent = p.label;
            $('catchForm').classList.remove('hidden');
            $('catchNote').focus();
        });
        grid.appendChild(btn);
    }
}

function resetCatchForm() {
    selectedPattern = null;
    $('catchForm').classList.add('hidden');
    $('catchNote').value = '';
    $('catchInstead').value = '';
    for (const b of $('patternGrid').children) b.classList.remove('selected');
}

$('catchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedPattern) return;
    try {
        const row = await api('catch', {
            pattern: selectedPattern.key,
            note: $('catchNote').value,
            instead: $('catchInstead').value,
        });
        state.catches.unshift(row);
        resetCatchForm();
        renderAll();
    } catch (err) {
        alert(err.message);
    }
});
$('catchCancel').addEventListener('click', resetCatchForm);

function renderCatchList() {
    const list = $('catchList');
    list.innerHTML = '';
    if (state.catches.length === 0) {
        list.innerHTML = '<p class="text-sm text-stone italic">Nothing logged yet. The first catch is the first win.</p>';
        return;
    }
    const labels = Object.fromEntries(PATTERNS.map(p => [p.key, p.label]));
    for (const c of state.catches.slice(0, 30)) {
        const item = document.createElement('div');
        item.className = 'bg-card border border-hairline rounded-[4px] p-3.5';
        const when = String(c.caught_at).slice(0, 16).replace('T', ' ');
        item.innerHTML = `
            <div class="flex items-baseline justify-between gap-3">
                <div class="font-mono font-bold text-[0.7rem] uppercase tracking-[0.15em] text-terra">${labels[c.pattern] || c.pattern}</div>
                <div class="flex items-center gap-3 shrink-0">
                    <span class="font-mono text-[0.62rem] text-stone">${when}</span>
                    <button type="button" class="c-del font-mono text-[0.62rem] uppercase text-stone hover:text-terra" aria-label="delete">✕</button>
                </div>
            </div>
            ${c.note ? `<div class="text-[0.85rem] mt-1.5">${escapeHtml(c.note)}</div>` : ''}
            ${c.instead ? `<div class="text-[0.82rem] text-pine mt-1"><span class="font-mono text-[0.62rem] uppercase tracking-widest">instead →</span> ${escapeHtml(c.instead)}</div>` : ''}`;
        item.querySelector('.c-del').addEventListener('click', async () => {
            if (!confirm('Delete this catch?')) return;
            try {
                await api('catch', null, 'DELETE', c.id);
                state.catches = state.catches.filter(x => x.id !== c.id);
                renderAll();
            } catch (err) {
                alert(err.message);
            }
        });
        list.appendChild(item);
    }
}

function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

// ------------------------------------------------------------------
//  The work (Breaking Free activities)
// ------------------------------------------------------------------

const STATUS_FLOW = { todo: 'doing', doing: 'done', done: 'todo' };
const STATUS_LABEL = { todo: 'todo', doing: 'doing', done: 'done' };

function activityState(num) {
    return state.activities.find(a => a.num === num) || { num, status: 'todo', note: null };
}

function renderWork() {
    const wrap = $('workList');
    wrap.innerHTML = '';
    let currentChapter = 0;
    for (const a of ACTIVITIES) {
        if (a.chapter !== currentChapter) {
            currentChapter = a.chapter;
            const h = document.createElement('h3');
            h.className = 'font-mono text-[0.65rem] uppercase tracking-[0.2em] text-stone mt-6 mb-2';
            h.textContent = 'Ch. ' + a.chapter + ' · ' + CHAPTERS[a.chapter];
            wrap.appendChild(h);
        }
        const st = activityState(a.num);
        const item = document.createElement('details');
        item.className = 'work-item st-' + st.status + ' bg-card border border-hairline rounded-[4px] px-4 py-3 mb-2';
        item.innerHTML = `
            <summary class="flex items-center gap-3">
                <span class="w-num font-mono font-bold text-[0.68rem] tabular-nums border border-hairline rounded-[3px] px-1.5 py-0.5">${a.num}</span>
                <span class="w-title font-display font-semibold text-[1rem] leading-tight flex-1">${a.title}</span>
                <button type="button" class="w-status btn-press font-mono font-bold text-[0.62rem] uppercase tracking-widest border border-hairline rounded-[3px] px-2.5 py-1">${STATUS_LABEL[st.status]}</button>
            </summary>
            <div class="pt-3 mt-3 border-t border-hairline">
                <p class="text-[0.85rem] text-stone">${a.prompt}</p>
                <textarea rows="2" maxlength="2000" placeholder="Notes: what came up, what I found…"
                    class="w-note w-full bg-paper border border-hairline rounded-[3px] p-2.5 text-sm mt-3 focus:outline-none focus:border-ink/50 resize-y">${st.note ? escapeHtml(st.note) : ''}</textarea>
                <button type="button" class="w-save btn-press font-mono font-bold text-[0.62rem] uppercase tracking-widest bg-ink text-paper rounded-[3px] px-3 py-1.5 mt-2 hover:bg-black transition">Save note</button>
            </div>`;

        const statusBtn = item.querySelector('.w-status');
        statusBtn.addEventListener('click', async (e) => {
            e.preventDefault(); // don't toggle the <details>
            e.stopPropagation();
            const current = activityState(a.num);
            await saveActivity(a.num, STATUS_FLOW[current.status], current.note, item, statusBtn);
        });
        item.querySelector('.w-save').addEventListener('click', async () => {
            const current = activityState(a.num);
            await saveActivity(a.num, current.status, item.querySelector('.w-note').value, item, statusBtn);
        });
        wrap.appendChild(item);
    }
}

async function saveActivity(num, status, note, item, statusBtn) {
    try {
        const saved = await api('activity', { num, status, note: note || '' });
        const i = state.activities.findIndex(x => x.num === num);
        if (i >= 0) state.activities[i] = saved;
        else state.activities.push(saved);
        item.className = item.className.replace(/st-\w+/, 'st-' + saved.status);
        statusBtn.textContent = STATUS_LABEL[saved.status];
        renderWorkSummary();
        renderProgress();
    } catch (err) {
        alert(err.message);
    }
}

function renderWorkSummary() {
    const p = activityProgress(state.activities);
    $('workSummary').textContent = p.done + ' / ' + p.total + ' done' + (p.doing ? ' · ' + p.doing + ' in motion' : '');
}

// ------------------------------------------------------------------
//  Progress
// ------------------------------------------------------------------

function tile(value, label, accent = 'text-ink') {
    return `<div class="bg-card border border-hairline rounded-[4px] p-3.5 text-center">
        <div class="font-display font-bold text-[1.9rem] leading-none tabular-nums ${accent}">${value}</div>
        <div class="font-mono text-[0.6rem] tracking-[0.15em] uppercase text-stone mt-1.5">${label}</div>
    </div>`;
}

function renderProgress() {
    const today = dateKey(new Date());

    const run = streak(state.checkins, today);
    const days30 = lastNDays(state.checkins, today, 30);
    const kept30 = days30.filter(d => d.score !== null && d.score >= GOAL).length;
    const work = activityProgress(state.activities);
    const caught7 = catchCounts(state.catches, today, 7).reduce((sum, c) => sum + c.count, 0);

    $('statTiles').innerHTML =
        tile(run, 'day streak', 'text-pine')
        + tile(kept30 + '<span class="text-stone text-[1.1rem]">/30</span>', 'days kept')
        + tile(work.done + '<span class="text-stone text-[1.1rem]">/46</span>', 'exercises done')
        + tile(caught7, 'catches · 7d', 'text-terra');

    renderWall(today);
    renderBars($('practiceBars'), practiceRates(state.checkins, today, 30)
        .map(r => ({ label: r.label, num: r.done, den: r.days, text: r.done + '/' + r.days })), '#2f5b53');
    renderBars($('patternCounts'), catchCounts(state.catches, today, 30)
        .map(c => ({ label: c.label, num: c.count, den: null, text: String(c.count) })), '#8a4a32');
}

function renderWall(today) {
    const series = lastNDays(state.checkins, today, 70);
    const wall = $('wall');
    const grid = document.createElement('div');
    grid.className = 'wall-grid';

    // Align rows Mon..Sun: pad before the first real day.
    const [y, m, d] = series[0].day.split('-').map(Number);
    const lead = (new Date(y, m - 1, d).getDay() + 6) % 7;
    for (let i = 0; i < lead; i++) {
        const pad = document.createElement('span');
        pad.className = 'wall-cell';
        pad.style.visibility = 'hidden';
        grid.appendChild(pad);
    }

    for (const dot of series) {
        const cell = document.createElement('span');
        cell.className = 'wall-cell' + (dot.score !== null ? ' wall-s' + dot.score : '') + (dot.day === today ? ' today' : '');
        cell.title = dot.day + (dot.score === null ? ' · no entry' : ' · ' + dot.score + '/' + PRACTICES.length + (dot.score >= GOAL ? ' · kept' : ''));
        grid.appendChild(cell);
    }
    wall.innerHTML = '';
    wall.appendChild(grid);
}

/** Label + thin bar + value rows; single hue per chart, text in ink tokens. */
function renderBars(container, rows, color) {
    const max = Math.max(1, ...rows.map(r => (r.den === null ? r.num : 0)));
    container.innerHTML = '';
    for (const r of rows) {
        const frac = r.den === null
            ? r.num / max
            : (r.den > 0 ? r.num / r.den : 0);
        const row = document.createElement('div');
        row.className = 'grid grid-cols-[9.5rem_1fr_auto] sm:grid-cols-[12rem_1fr_auto] items-center gap-3';
        row.innerHTML = `
            <div class="text-[0.8rem] leading-tight">${r.label}</div>
            <div class="bar-track"><div class="bar-fill" style="background:${color}"></div></div>
            <div class="font-mono text-[0.68rem] tabular-nums text-stone">${r.text}</div>`;
        container.appendChild(row);
        const fill = row.querySelector('.bar-fill');
        requestAnimationFrame(() => { fill.style.transform = 'scaleX(' + Math.min(1, frac) + ')'; });
    }
}

// ------------------------------------------------------------------

load();
