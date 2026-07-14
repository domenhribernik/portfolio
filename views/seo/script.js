//? Page wiring for the SEO tool: tab routing, checklist rendering, in-memory
//? status editing with copy-out. All decisions live in logic.js (tested);
//? this file only touches the DOM.

import {
    TIER_VALUES,
    nextStatus,
    pageScore,
    overallScore,
    nextActions,
    filterPages,
    validateChecklist,
} from './logic.js';

const $ = (sel) => document.querySelector(sel);

//? ------------------------------------------------------------------ tabs

const TABS = ['playbook', 'checklist'];

function activeTab() {
    const hash = location.hash.replace('#', '');
    return TABS.includes(hash) ? hash : 'playbook';
}

function showTab() {
    const tab = activeTab();
    for (const name of TABS) {
        //? Inline display, not the `hidden` class: #panel-playbook also carries
        //? `lg:grid`, which wins over `.hidden` at lg+ and would keep it visible.
        $(`#panel-${name}`).style.display = name === tab ? '' : 'none';
        const btn = $(`#tab-${name}`);
        btn.classList.toggle('border-zinc-900', name === tab);
        btn.classList.toggle('text-zinc-900', name === tab);
        btn.classList.toggle('border-transparent', name !== tab);
        btn.classList.toggle('text-zinc-500', name !== tab);
    }
}

window.addEventListener('hashchange', showTab);
showTab();

//? ------------------------------------------------------------- checklist

const STATUS_STYLE = {
    done: 'bg-emerald-100 text-emerald-900 border-emerald-300',
    partial: 'bg-amber-100 text-amber-900 border-amber-300',
    todo: 'bg-red-100 text-red-900 border-red-300',
    na: 'bg-zinc-100 text-zinc-400 border-zinc-200',
    unknown: 'bg-white text-zinc-500 border-dashed border-zinc-300',
};
const STATUS_MARK = { done: 'ok', partial: 'half', todo: 'todo', na: 'n/a', unknown: '?' };

let doc = null;          // the loaded checklist, mutated in memory by cell clicks
let dirty = false;
let tierFilter = '';     // '' = all
let reqFilter = '';      // requirement id, '' = none

async function loadChecklist() {
    const res = await fetch('checklist.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`checklist.json: HTTP ${res.status}`);
    const parsed = await res.json();
    const errors = validateChecklist(parsed);
    if (errors.length) throw new Error(`checklist.json invalid: ${errors.join('; ')}`);
    return parsed;
}

function pct(x) {
    return x === null ? 'n/a' : `${Math.round(x * 100)}%`;
}

function renderStats() {
    const statsEl = $('#stats');
    statsEl.innerHTML = '';
    const blocks = [['Overall', overallScore(doc.pages, doc.requirements)]];
    for (const tier of TIER_VALUES) {
        const pages = doc.pages.filter(p => p.tier === tier);
        blocks.push([tier[0].toUpperCase() + tier.slice(1), overallScore(pages, doc.requirements)]);
    }
    for (const [label, score] of blocks) {
        const div = document.createElement('div');
        div.className = 'border border-zinc-300 bg-white px-4 py-3';
        div.innerHTML = `<p class="text-2xl font-semibold tabular-nums">${pct(score)}</p>
            <p class="text-xs uppercase tracking-wide text-zinc-500"></p>`;
        div.querySelector('p:last-child').textContent = label;
        statsEl.appendChild(div);
    }
}

function renderActions() {
    const listEl = $('#actions');
    listEl.innerHTML = '';
    const actions = nextActions(doc.pages, doc.requirements, 10);
    if (!actions.length) {
        listEl.innerHTML = '<li class="text-zinc-500">Nothing owed. Go write a blog post instead.</li>';
        return;
    }
    for (const a of actions) {
        const li = document.createElement('li');
        li.className = 'flex items-baseline gap-2 py-1';
        const note = a.note ? ` <span class="text-zinc-500">(${a.note})</span>` : '';
        li.innerHTML = `<span class="text-xs tabular-nums text-zinc-400 w-8">${a.urgency.toFixed(1)}</span>
            <span><strong></strong> needs <em class="not-italic underline decoration-zinc-300"></em>${note}</span>`;
        li.querySelector('strong').textContent = a.name;
        li.querySelector('em').textContent = a.label.toLowerCase();
        listEl.appendChild(li);
    }
}

function renderFilters() {
    const el = $('#tier-filters');
    el.innerHTML = '';
    for (const tier of ['', ...TIER_VALUES]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const on = tierFilter === tier;
        btn.className = `px-3 py-1 border text-sm ${on ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-600 border-zinc-300 hover:border-zinc-500'}`;
        btn.textContent = tier || 'all';
        btn.addEventListener('click', () => { tierFilter = tier; renderMatrix(); renderFilters(); });
        el.appendChild(btn);
    }
    const hint = document.createElement('span');
    hint.className = 'text-xs text-zinc-500 self-center';
    hint.textContent = reqFilter
        ? `column filter: pages still owing "${reqFilter}" (click the column header again to clear)`
        : 'click a column header to see only pages still owing it';
    el.appendChild(hint);
}

function renderMatrix() {
    const table = $('#matrix');
    table.innerHTML = '';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.innerHTML = '<th class="sticky left-0 bg-zinc-50 text-left px-3 py-2 border-b border-zinc-300">Page</th>';
    for (const req of doc.requirements) {
        const th = document.createElement('th');
        const on = reqFilter === req.id;
        th.className = `px-2 py-2 border-b border-zinc-300 text-xs font-medium cursor-pointer select-none align-bottom ${on ? 'bg-zinc-900 text-white' : 'hover:bg-zinc-200'}`;
        th.title = `${req.label} (weight ${req.weight}); click to filter`;
        th.textContent = req.id;
        th.addEventListener('click', () => {
            reqFilter = on ? '' : req.id;
            renderMatrix();
            renderFilters();
        });
        headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const visible = filterPages(doc.pages, {
        tier: tierFilter || undefined,
        requirement: reqFilter || undefined,
    });
    for (const page of visible) {
        const tr = document.createElement('tr');
        tr.className = 'border-b border-zinc-200';
        const score = pageScore(page, doc.requirements);
        const th = document.createElement('th');
        th.className = 'sticky left-0 bg-white text-left px-3 py-1.5 font-normal whitespace-nowrap';
        th.innerHTML = `<span class="font-medium"></span>
            <span class="ml-1 text-xs text-zinc-400 tabular-nums">${pct(score)}</span><br>
            <code class="text-xs text-zinc-500"></code>`;
        th.querySelector('span').textContent = page.name;
        th.querySelector('code').textContent = page.path;
        tr.appendChild(th);

        for (const req of doc.requirements) {
            const td = document.createElement('td');
            td.className = 'px-1 py-1 text-center';
            const status = page.status[req.id] ?? 'unknown';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `w-14 border px-1 py-0.5 text-xs ${STATUS_STYLE[status]}`;
            btn.textContent = STATUS_MARK[status];
            const note = page.notes?.[req.id];
            btn.title = note ? `${req.label}: ${status}. ${note}` : `${req.label}: ${status}. Click to cycle.`;
            btn.addEventListener('click', () => {
                page.status[req.id] = nextStatus(status);
                dirty = true;
                $('#copy-json').classList.remove('hidden');
                renderAll();
            });
            td.appendChild(btn);
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
}

function renderAll() {
    renderStats();
    renderActions();
    renderFilters();
    renderMatrix();
    $('#updated').textContent = doc.updated + (dirty ? ' (edited in memory, copy JSON to persist)' : '');
}

$('#copy-json').addEventListener('click', async () => {
    const out = { ...doc, updated: new Date().toISOString().slice(0, 10) };
    await navigator.clipboard.writeText(JSON.stringify(out, null, 4) + '\n');
    $('#copy-json').textContent = 'Copied. Paste into views/seo/checklist.json';
});

loadChecklist()
    .then((parsed) => { doc = parsed; renderAll(); })
    .catch((err) => {
        $('#panel-checklist').innerHTML =
            `<p class="text-red-700 border border-red-300 bg-red-50 px-4 py-3"></p>`;
        $('#panel-checklist p').textContent = err.message;
    });
