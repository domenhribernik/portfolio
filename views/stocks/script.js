// Tečajnica (views/stocks): DOM orchestration. All math, formatting and
// chart geometry lives in logic.js (tested); this file only fetches, wires
// and renders. Slovenian throughout, matching the page.

import {
    fmtNum, fmtEur, fmtPct, fmtQty, fmtDateSl, parseSlNum,
    computeHoldings, enrichHoldings, taxReport,
    changePct, weekPos52, evaluateAlerts,
    sparklinePath, niceTicks, seriesToPath,
    groupBySegment, portfolioTimeline,
} from './logic.js';
import { gatedFetch, loginUrl } from '../../components/auth-gate.js';

const API = '../../app/controllers/stocks-controller.php';

// Validated chart palette (dataviz check: order is fixed, never cycled).
const ALLOC_COLORS = ['#177d5b', '#d4451f', '#2b62c4', '#a06a00', '#8a4fa8'];
const OTHER_COLOR = '#6b6256';

const SL_DAYS = ['nedelja', 'ponedeljek', 'torek', 'sreda', 'četrtek', 'petek', 'sobota'];
const SL_MONTHS = ['januar', 'februar', 'marec', 'april', 'maj', 'junij',
    'julij', 'avgust', 'september', 'oktober', 'november', 'december'];

const $ = (id) => document.getElementById(id);

// Unsigned percent for shares/rates (fmtPct signs its value for moves).
const pct = (value, decimals = 1) => fmtNum(value, decimals) + '\u00a0%';

const state = {
    overview: null,     // { instruments, syncedAt }
    transactions: [],
    alerts: [],
    dividends: [],
    historyCache: {},   // instrumentId -> [{date, close, ...}]
    portfolioRange: '1L',
    openDrawer: null,   // instrument id with the expanded board row
};

// ------------------------------------------------------------------
//  Boot
// ------------------------------------------------------------------

init();

async function init() {
    $('signinLink').href = loginUrl();
    await gatedFetch(API + '?resource=overview', {}, {
        onSignedOut: () => showWall('wallSignin'),
        onForbidden: () => showWall('wallForbidden'),
        onError: (msg) => { showWall('wallSignin'); showError(msg); },
        onOk: boot,
    });
}

function showWall(id) {
    $('loading').classList.add('hidden');
    $(id).classList.remove('hidden');
}

async function boot(overview) {
    state.overview = overview;
    $('loading').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('dateline').classList.remove('hidden');
    $('dateline').classList.add('flex');

    renderDateline();
    renderBoard();
    fillInstrumentSelects();
    watchSections();
    wireForms();
    $('refreshBtn').addEventListener('click', () => refresh(true));

    await Promise.all([loadTransactions(), loadAlerts(), loadDividends()]);
    renderAll();

    refresh(false); // background freshness pass; re-renders when new data lands
}

async function refresh(manual) {
    const btn = $('refreshBtn');
    btn.disabled = true;
    try {
        const res = await fetch(API + '?action=refresh', { method: 'POST' });
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.refreshed) {
            const fresh = await fetch(API + '?resource=overview');
            if (fresh.ok) {
                state.overview = await fresh.json();
                state.historyCache = {};
                renderDateline();
                renderBoard();
                renderPortfolio();
                renderTax();
            }
        } else if (manual && data && data.error) {
            showError('Osvežitev ni uspela: ' + data.error);
        }
    } catch {
        if (manual) showError('Osvežitev ni uspela. Preveri povezavo.');
    } finally {
        btn.disabled = false;
    }
}

async function loadTransactions() {
    const res = await fetch(API + '?resource=transactions');
    if (res.ok) state.transactions = await res.json();
}

async function loadAlerts() {
    const res = await fetch(API + '?resource=alerts');
    if (res.ok) state.alerts = await res.json();
}

async function loadDividends() {
    const res = await fetch(API + '?resource=dividends');
    if (res.ok) state.dividends = await res.json();
}

function renderAll() {
    renderPortfolio();
    renderTransactions();
    renderDividends();
    renderAlerts();
    renderTax();
}

// ------------------------------------------------------------------
//  Shared lookups
// ------------------------------------------------------------------

function instruments() {
    return state.overview ? state.overview.instruments : [];
}

function instrumentById(id) {
    return instruments().find((i) => i.id === Number(id)) || null;
}

function quotes() {
    return instruments().map((i) => ({
        instrument_id: i.id, symbol: i.symbol, last: i.last, prevClose: i.prevClose,
    }));
}

function holdings() {
    return computeHoldings(state.transactions);
}

function marketDate() {
    let max = null;
    for (const i of instruments()) {
        if (i.lastDate && (max === null || i.lastDate > max)) max = i.lastDate;
    }
    return max;
}

function slLongDate(iso) {
    const d = new Date(iso + 'T12:00:00');
    return `${SL_DAYS[d.getDay()]}, ${d.getDate()}. ${SL_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function signClass(value) {
    if (value === null || value === undefined || Math.abs(value) < 1e-9) return 'text-stone';
    return value > 0 ? 'text-gain' : 'text-loss';
}

function showError(msg) {
    const el = $('errorMsg');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(showError.timer);
    showError.timer = setTimeout(() => el.classList.add('hidden'), 5000);
}

// ------------------------------------------------------------------
//  Dateline
// ------------------------------------------------------------------

function renderDateline() {
    const md = marketDate();
    $('datelineText').textContent = md
        ? 'Zadnji trgovalni dan: ' + slLongDate(md)
        : 'Podatki z borze še niso naloženi.';
    const synced = state.overview && state.overview.syncedAt;
    $('syncStamp').textContent = synced
        ? 'osveženo ' + new Date(synced).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })
        : '';
    $('boardStamp').textContent = md ? fmtDateSl(md) : '';
}

// ------------------------------------------------------------------
//  Portfolio
// ------------------------------------------------------------------

function renderPortfolio() {
    const rows = enrichHoldings(holdings(), quotes())
        .sort((a, b) => (b.value || 0) - (a.value || 0));

    const hasAnything = state.transactions.length > 0;
    $('portfolioEmpty').classList.toggle('hidden', hasAnything);
    $('portfolioBody').classList.toggle('hidden', !hasAnything);
    $('portfolioCount').textContent = rows.length
        ? rows.length + (rows.length === 1 ? ' naložba' : rows.length === 2 ? ' naložbi' : ' naložb')
        : '';
    if (!hasAnything) return;

    const t = enrichHoldings.totals(rows);
    const totalReturn = t.unrealized + t.realized + t.dividends;
    $('portfolioTiles').innerHTML = [
        tile('Vrednost', fmtEur(t.value), ''),
        tile('Danes', fmtEur(t.dayChange), signClass(t.dayChange), true),
        tile('Nerealizirano', fmtEur(t.unrealized), signClass(t.unrealized), true),
        tile('Realizirano', fmtEur(t.realized), signClass(t.realized), true),
        tile('Dividende', fmtEur(t.dividends), t.dividends > 0 ? 'text-gain' : 'text-stone', true),
        tile('Skupni donos', fmtEur(totalReturn), signClass(totalReturn), true),
    ].join('');

    renderAllocation(rows, t.value);
    renderHoldingsTable(rows);
    renderPortfolioChart();
}

function tile(label, value, cls, signed = false) {
    const shown = signed && !value.startsWith('-') && value !== '–' && !value.startsWith('0,00')
        ? '+' + value : value;
    return `<div class="bg-card border border-hairline rounded-[3px] px-3 py-3">
        <div class="font-mono text-[0.6rem] tracking-[0.18em] uppercase text-stone mb-1">${label}</div>
        <div class="font-display font-semibold text-lg sm:text-xl leading-tight ${cls}">${shown}</div>
    </div>`;
}

function renderAllocation(rows, totalValue) {
    const bar = $('allocationBar');
    const legend = $('allocationLegend');
    if (!totalValue) { bar.innerHTML = ''; legend.innerHTML = ''; return; }

    const top = rows.slice(0, ALLOC_COLORS.length);
    const rest = rows.slice(ALLOC_COLORS.length);
    const parts = top.map((r, i) => ({ label: r.symbol, value: r.value || 0, color: ALLOC_COLORS[i] }));
    const restValue = rest.reduce((sum, r) => sum + (r.value || 0), 0);
    if (restValue > 0) parts.push({ label: 'Ostalo', value: restValue, color: OTHER_COLOR });

    // A 2px paper gap between segments (mark spec), done with a border.
    bar.innerHTML = parts.map((p, i) => `<span style="width:${(p.value / totalValue * 100).toFixed(2)}%;
        background:${p.color};${i > 0 ? 'border-left:2px solid #fffdf8;' : ''}"></span>`).join('');
    legend.innerHTML = parts.map((p) => `<div class="flex items-baseline gap-2 font-mono text-[0.72rem]">
        <span class="inline-block w-2.5 h-2.5 rounded-[2px] shrink-0 self-center" style="background:${p.color}"></span>
        <span class="text-ink">${escapeHtml(p.label)}</span>
        <span class="flex-1 border-b border-dotted border-ink/20"></span>
        <span class="text-stone">${pct(p.value / totalValue * 100)}&nbsp;·&nbsp;${fmtEur(p.value)}</span>
    </div>`).join('');
}

function renderHoldingsTable(rows) {
    const cells = rows.map((r) => {
        const inst = instrumentById(r.instrument_id);
        const totalPct = r.costBasis > 0 && r.unrealized !== null ? r.unrealized / r.costBasis * 100 : null;
        const day = r.last !== null && inst && inst.prevClose ? changePct(r.last, inst.prevClose) : null;
        return `<tr class="clickable" data-goto="${r.instrument_id}">
            <td><b>${escapeHtml(r.symbol || '?')}</b><span class="paper-name">${escapeHtml(inst ? inst.name : '')}</span></td>
            <td class="max-md:hidden">${fmtQty(r.qty)}</td>
            <td class="max-md:hidden">${fmtEur(r.avgCost)}</td>
            <td class="max-md:hidden">${fmtEur(r.last)}</td>
            <td><b>${fmtEur(r.value)}</b></td>
            <td class="${signClass(day)}">${fmtPct(day)}</td>
            <td class="${signClass(r.unrealized)}">${fmtEur(r.unrealized)}<br>
                <span class="${signClass(totalPct)} opacity-80">${fmtPct(totalPct)}</span></td>
            <td class="max-md:hidden">${pct(r.weightPct)}</td>
        </tr>`;
    }).join('');

    $('holdingsTable').innerHTML = `<table class="ledger">
        <thead><tr><th>Papir</th><th class="max-md:hidden">Količina</th><th class="max-md:hidden">Nabavna</th><th class="max-md:hidden">Zadnja</th>
        <th>Vrednost</th><th>Danes</th><th>Skupaj</th><th class="max-md:hidden">Delež</th></tr></thead>
        <tbody>${cells}</tbody></table>`;

    $('holdingsTable').querySelectorAll('tr.clickable').forEach((tr) => {
        tr.addEventListener('click', () => {
            openDrawer(Number(tr.dataset.goto));
            document.querySelector(`#board [data-row="${tr.dataset.goto}"]`)
                ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
    });
}

async function renderPortfolioChart() {
    const host = $('portfolioChart');
    const held = enrichHoldings(holdings(), quotes());
    if (!held.length) { host.innerHTML = emptyChartNote('Ko portfelj zaživi, se tu nariše njegova pot.'); return; }

    const ids = held.map((r) => r.instrument_id);
    await Promise.all(ids.map(ensureHistory));

    const closes = {};
    for (const id of ids) {
        closes[id] = (state.historyCache[id] || []).map((p) => ({ date: p.date, close: p.close }));
    }
    let series = portfolioTimeline(state.transactions, closes);
    series = clipRange(series, state.portfolioRange);
    if (series.length < 2) { host.innerHTML = emptyChartNote('Premalo podatkov za graf.'); return; }

    renderRangeButtons();
    drawLineChart(host, [
        { points: series.map((p) => ({ date: p.date, value: p.value })), color: '#1c1a17', width: 2 },
        { points: series.map((p) => ({ date: p.date, value: p.invested })), color: '#6b6256', width: 1.5, dash: '5 4' },
    ], {
        tip: (i) => {
            const p = series[i];
            return `${fmtDateSl(p.date)}<br>vrednost ${fmtEur(p.value)}<br>vloženo ${fmtEur(p.invested)}`;
        },
    });
}

function renderRangeButtons() {
    const ranges = ['3M', '1L', 'Vse'];
    $('portfolioChartRanges').innerHTML = ranges.map((r) =>
        `<button type="button" data-range="${r}" class="${r === state.portfolioRange
            ? 'text-ink underline decoration-clay decoration-2 underline-offset-4'
            : 'text-stone hover:text-ink'}">${r}</button>`).join('');
    $('portfolioChartRanges').querySelectorAll('button').forEach((b) => {
        b.addEventListener('click', () => {
            state.portfolioRange = b.dataset.range;
            renderPortfolioChart();
        });
    });
}

function clipRange(series, range) {
    if (range === 'Vse' || !series.length) return series;
    const days = range === '3M' ? 92 : 365;
    const last = series[series.length - 1].date;
    const floor = new Date(new Date(last + 'T12:00:00').getTime() - days * 86400000)
        .toISOString().slice(0, 10);
    return series.filter((p) => p.date >= floor);
}

async function ensureHistory(instrumentId) {
    if (state.historyCache[instrumentId]) return;
    const res = await fetch(`${API}?resource=history&id=${instrumentId}`);
    state.historyCache[instrumentId] = res.ok ? await res.json() : [];
}

// ------------------------------------------------------------------
//  Board (the tečajnica itself)
// ------------------------------------------------------------------

function renderBoard() {
    const held = holdings();
    const groups = groupBySegment(instruments());
    $('board').innerHTML = groups.map((g) => {
        const rows = g.instruments.map((i) => boardRow(i, held[i.id])).join('');
        return `<div>
            <div class="flex items-baseline gap-3 mb-2">
                <h3 class="font-display italic text-lg">${g.label}</h3>
                <span class="font-mono text-[0.62rem] tracking-[0.18em] uppercase text-stone">${g.instruments.length} papirjev</span>
            </div>
            <div class="bg-card border border-hairline rounded-[3px] overflow-x-auto">
            <table class="ledger"><thead><tr>
                <th>Papir</th><th>Zadnja</th><th>Danes</th>
                <th class="max-md:hidden">52 tednov</th><th class="max-md:hidden">Promet</th><th>Gibanje</th>
            </tr></thead><tbody>${rows}</tbody></table></div></div>`;
    }).join('');

    $('board').querySelectorAll('tr[data-row]').forEach((tr) => {
        tr.addEventListener('click', () => toggleDrawer(Number(tr.dataset.row)));
    });
}

function boardRow(i, holding) {
    const day = changePct(i.last, i.prevClose);
    const pos = i.last !== null && i.high52 !== null ? weekPos52(i.last, i.low52, i.high52) : null;
    const spark = i.closes && i.closes.length > 1
        ? `<svg viewBox="0 0 90 26" width="90" height="26" aria-hidden="true">
             <path d="${sparklinePath(i.closes, 90, 26)}" fill="none" stroke="#1c1a17" stroke-width="1.3"/>
           </svg>`
        : '<span class="text-stone">–</span>';
    const heldMark = holding && holding.qty > 0
        ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-clay ml-1.5 align-middle" title="v portfelju"></span>' : '';

    return `<tr class="clickable" data-row="${i.id}">
        <td><b>${escapeHtml(i.symbol)}</b>${heldMark}<span class="paper-name">${escapeHtml(i.name)}</span></td>
        <td><b>${fmtEur(i.last)}</b></td>
        <td class="${signClass(day)}">${fmtPct(day)}</td>
        <td class="max-md:hidden">${pos === null ? '–'
            : `<span class="range52"><i style="left:${(pos * 100).toFixed(0)}%"></i></span>`}</td>
        <td class="max-md:hidden">${i.turnover === null ? '–' : fmtEur(i.turnover, 0)}</td>
        <td>${spark}</td>
    </tr>`;
}

function toggleDrawer(instrumentId) {
    if (state.openDrawer === instrumentId) {
        state.openDrawer = null;
        document.querySelectorAll('#board .drawer').forEach((el) => el.remove());
        document.querySelectorAll('#board .drawer-open').forEach((el) => el.classList.remove('drawer-open'));
        return;
    }
    openDrawer(instrumentId);
}

async function openDrawer(instrumentId) {
    state.openDrawer = instrumentId;
    document.querySelectorAll('#board .drawer').forEach((el) => el.remove());
    document.querySelectorAll('#board .drawer-open').forEach((el) => el.classList.remove('drawer-open'));

    const row = document.querySelector(`#board [data-row="${instrumentId}"]`);
    if (!row) return;
    row.classList.add('drawer-open');

    const drawer = document.createElement('tr');
    drawer.className = 'drawer';
    drawer.innerHTML = `<td colspan="6"><div class="py-2"><div class="skeleton h-40 w-full"></div></div></td>`;
    row.after(drawer);

    await ensureHistory(instrumentId);
    if (state.openDrawer !== instrumentId) return; // closed while loading

    const i = instrumentById(instrumentId);
    const history = state.historyCache[instrumentId] || [];
    const held = holdings()[instrumentId];

    const stats = [
        ['52-tedenski vrh', fmtEur(i.high52)],
        ['52-tedensko dno', fmtEur(i.low52)],
        ['ISIN', i.isin],
    ];
    if (held && held.qty > 0) {
        stats.push(['Tvoja pozicija', `${fmtQty(held.qty)} × ${fmtEur(held.avgCost)}`]);
    }

    drawer.innerHTML = `<td colspan="6"><div class="py-3 px-1 sm:px-3">
        <div class="flex flex-wrap items-baseline justify-between gap-2 mb-3">
            <span class="font-display italic text-lg">${escapeHtml(i.name)} <span class="font-mono not-italic text-sm text-stone">${escapeHtml(i.symbol)}</span></span>
            <span class="font-mono text-[0.68rem] uppercase tracking-[0.15em] flex gap-3" data-ranges></span>
        </div>
        <div class="chart-host" data-detail-chart></div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 mb-4">
            ${stats.map(([k, v]) => `<div>
                <div class="font-mono text-[0.6rem] tracking-[0.18em] uppercase text-stone">${k}</div>
                <div class="font-mono text-sm">${v}</div></div>`).join('')}
        </div>
        <div class="flex flex-wrap gap-3">
            <button type="button" data-act="buy" class="btn-press font-mono font-bold text-[0.68rem] uppercase tracking-widest bg-ink text-paper rounded-[3px] px-4 py-2 hover:bg-clay transition">+ transakcija</button>
            <button type="button" data-act="alert" class="btn-press font-mono font-bold text-[0.68rem] uppercase tracking-widest bg-transparent text-ink border border-ink/60 rounded-[3px] px-4 py-2 hover:bg-ink hover:text-paper transition">+ opozorilo</button>
        </div>
    </div></td>`;

    const chartHost = drawer.querySelector('[data-detail-chart]');
    const rangesHost = drawer.querySelector('[data-ranges]');
    let range = '1L';

    const draw = () => {
        rangesHost.innerHTML = ['1M', '3M', '1L'].map((r) =>
            `<button type="button" data-range="${r}" class="${r === range
                ? 'text-ink underline decoration-clay decoration-2 underline-offset-4'
                : 'text-stone hover:text-ink'}">${r}</button>`).join('');
        rangesHost.querySelectorAll('button').forEach((b) => {
            b.addEventListener('click', () => { range = b.dataset.range; draw(); });
        });

        const days = range === '1M' ? 31 : range === '3M' ? 92 : 365;
        const points = history.slice(-Math.max(2, countBack(history, days)))
            .map((p) => ({ date: p.date, value: p.close }));
        if (points.length < 2) {
            chartHost.innerHTML = emptyChartNote('Premalo podatkov za graf.');
            return;
        }
        drawLineChart(chartHost, [{ points, color: '#1c1a17', width: 2 }], {
            tip: (idx) => `${fmtDateSl(points[idx].date)}<br>${fmtEur(points[idx].value)}`,
            accentLast: true,
        });
    };
    draw();

    drawer.querySelector('[data-act="buy"]').addEventListener('click', () => {
        $('txInstrument').value = String(instrumentId);
        if (i.last !== null) $('txPrice').value = fmtNum(i.last).replace(/ /g, '');
        $('txDate').value = new Date().toISOString().slice(0, 10);
        location.hash = '#transakcije';
        $('txQty').focus();
    });
    drawer.querySelector('[data-act="alert"]').addEventListener('click', () => {
        $('alertInstrument').value = String(instrumentId);
        location.hash = '#opozorila';
        $('alertThreshold').focus();
    });
}

function countBack(history, days) {
    if (!history.length) return 0;
    const last = history[history.length - 1].date;
    const floor = new Date(new Date(last + 'T12:00:00').getTime() - days * 86400000)
        .toISOString().slice(0, 10);
    let n = 0;
    for (let k = history.length - 1; k >= 0 && history[k].date >= floor; k--) n++;
    return n;
}

function emptyChartNote(text) {
    return `<div class="flex items-center justify-center h-32 font-mono text-[0.72rem] text-stone">${text}</div>`;
}

// ------------------------------------------------------------------
//  Line chart with crosshair + tooltip (shared by portfolio and drawer)
// ------------------------------------------------------------------

function drawLineChart(host, seriesList, opts = {}) {
    const W = 640, H = 240, PAD_L = 56, PAD_R = 10, PAD_T = 10, PAD_B = 26;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;

    const all = seriesList.flatMap((s) => s.points.map((p) => p.value));
    const ticks = niceTicks(Math.min(...all), Math.max(...all), 4);
    const min = ticks[0];
    const max = ticks[ticks.length - 1];

    const grid = ticks.map((t) => {
        const y = PAD_T + (1 - (t - min) / (max - min)) * plotH;
        return `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="rgba(28,26,23,0.08)"/>
            <text x="${PAD_L - 8}" y="${y + 3}" text-anchor="end" font-family="'Space Mono',monospace"
                font-size="9" fill="#6b6256">${fmtNum(t, t >= 1000 ? 0 : 2)}</text>`;
    }).join('');

    const base = seriesList[0].points;
    const xLabels = [0, Math.floor((base.length - 1) / 2), base.length - 1]
        .filter((v, k, arr) => arr.indexOf(v) === k)
        .map((idx) => {
            const x = PAD_L + xForIndex(base, idx) * plotW;
            return `<text x="${x}" y="${H - 8}" text-anchor="${idx === 0 ? 'start' : idx === base.length - 1 ? 'end' : 'middle'}"
                font-family="'Space Mono',monospace" font-size="9" fill="#6b6256">${fmtDateSl(base[idx].date)}</text>`;
        }).join('');

    const paths = seriesList.map((s) => {
        const d = seriesToPath(s.points, { width: plotW, height: plotH, min, max });
        return `<path d="${d}" transform="translate(${PAD_L},${PAD_T})" fill="none"
            stroke="${s.color}" stroke-width="${s.width || 2}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}
            stroke-linejoin="round" stroke-linecap="round"/>`;
    }).join('');

    const lastPoint = opts.accentLast ? (() => {
        const p = base[base.length - 1];
        const x = PAD_L + xForIndex(base, base.length - 1) * plotW;
        const y = PAD_T + (1 - (p.value - min) / (max - min)) * plotH;
        return `<circle cx="${x}" cy="${y}" r="3.5" fill="#d4451f" stroke="#fffdf8" stroke-width="2"/>`;
    })() : '';

    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img">
        ${grid}${xLabels}${paths}${lastPoint}
        <line data-cross x1="0" y1="${PAD_T}" x2="0" y2="${PAD_T + plotH}" stroke="#d4451f"
            stroke-width="1" stroke-dasharray="3 3" opacity="0"/>
        <circle data-dot r="3.5" fill="#1c1a17" stroke="#fffdf8" stroke-width="2" opacity="0"/>
        <rect data-overlay x="${PAD_L}" y="${PAD_T}" width="${plotW}" height="${plotH}" fill="transparent"/>
    </svg>`;

    const svg = host.querySelector('svg');
    const overlay = svg.querySelector('[data-overlay]');
    const cross = svg.querySelector('[data-cross]');
    const dot = svg.querySelector('[data-dot]');
    const tip = $('chartTip');

    const toIndex = (clientX) => {
        const rect = overlay.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        let best = 0, bestDist = Infinity;
        for (let k = 0; k < base.length; k++) {
            const d = Math.abs(xForIndex(base, k) - frac);
            if (d < bestDist) { bestDist = d; best = k; }
        }
        return best;
    };

    const show = (clientX) => {
        const idx = toIndex(clientX);
        const p = base[idx];
        const xf = xForIndex(base, idx);
        const x = PAD_L + xf * plotW;
        const y = PAD_T + (1 - (p.value - min) / (max - min)) * plotH;
        cross.setAttribute('x1', x); cross.setAttribute('x2', x);
        cross.setAttribute('opacity', '1');
        dot.setAttribute('cx', x); dot.setAttribute('cy', y);
        dot.setAttribute('opacity', '1');
        const rect = overlay.getBoundingClientRect();
        tip.innerHTML = opts.tip ? opts.tip(idx) : fmtEur(p.value);
        tip.style.left = (rect.left + xf * rect.width) + 'px';
        tip.style.top = (rect.top + (y - PAD_T) / plotH * rect.height) + 'px';
        tip.classList.remove('hidden');
    };

    const hide = () => {
        cross.setAttribute('opacity', '0');
        dot.setAttribute('opacity', '0');
        tip.classList.add('hidden');
    };

    overlay.addEventListener('mousemove', (e) => show(e.clientX));
    overlay.addEventListener('mouseleave', hide);
    overlay.addEventListener('touchstart', (e) => show(e.touches[0].clientX), { passive: true });
    overlay.addEventListener('touchmove', (e) => show(e.touches[0].clientX), { passive: true });
    overlay.addEventListener('touchend', hide);
}

function xForIndex(points, idx) {
    const t0 = Date.parse(points[0].date);
    const t1 = Date.parse(points[points.length - 1].date);
    if (t1 === t0) return 0;
    return (Date.parse(points[idx].date) - t0) / (t1 - t0);
}

// ------------------------------------------------------------------
//  Transactions
// ------------------------------------------------------------------

const SIDE_LABELS = { buy: 'Nakup', sell: 'Prodaja', div: 'Dividenda' };

function renderTransactions() {
    const list = state.transactions;
    $('txCount').textContent = list.length ? String(list.length) : '';
    if (!list.length) {
        $('txTable').innerHTML = `<div class="p-6 text-center font-mono text-[0.72rem] text-stone">
            Še ni vpisov. Prvi nakup vpišeš v obrazec zgoraj.</div>`;
        return;
    }
    $('txTable').innerHTML = `<table class="ledger"><thead><tr>
        <th>Datum</th><th>Papir</th><th>Vrsta</th><th class="max-md:hidden">Količina</th><th class="max-md:hidden">Cena</th><th class="max-md:hidden">Stroški</th><th>Skupaj</th><th></th>
    </tr></thead><tbody>${list.map((t) => {
        const total = t.quantity * t.price + (t.side === 'buy' ? t.fees : -t.fees);
        const sideCls = t.side === 'buy' ? 'text-ink' : t.side === 'sell' ? 'text-clay' : 'text-gain';
        return `<tr data-tx="${t.id}">
            <td>${fmtDateSl(t.trade_date)}</td>
            <td><b>${escapeHtml(t.symbol)}</b>${t.note ? `<span class="paper-name">${escapeHtml(t.note)}</span>` : ''}</td>
            <td class="${sideCls}">${SIDE_LABELS[t.side] || t.side}</td>
            <td class="max-md:hidden">${fmtQty(t.quantity)}</td>
            <td class="max-md:hidden">${fmtEur(t.price)}</td>
            <td class="max-md:hidden">${fmtEur(t.fees)}</td>
            <td><b>${fmtEur(total)}</b></td>
            <td class="whitespace-nowrap">
                <button type="button" data-edit class="text-stone hover:text-ink underline decoration-dotted underline-offset-2">uredi</button>
                <button type="button" data-del class="ml-2 text-stone hover:text-clay underline decoration-dotted underline-offset-2">izbriši</button>
            </td></tr>`;
    }).join('')}</tbody></table>`;

    $('txTable').querySelectorAll('tr[data-tx]').forEach((tr) => {
        const id = Number(tr.dataset.tx);
        tr.querySelector('[data-edit]').addEventListener('click', () => startTxEdit(id));
        tr.querySelector('[data-del]').addEventListener('click', () => deleteTx(id));
    });
}

function startTxEdit(id) {
    const t = state.transactions.find((x) => x.id === id);
    if (!t) return;
    $('txId').value = String(id);
    $('txInstrument').value = String(t.instrument_id);
    $('txSide').value = t.side;
    $('txQty').value = fmtQty(t.quantity);
    $('txPrice').value = fmtNum(t.price).replace(/ /g, '');
    $('txFees').value = t.fees ? fmtNum(t.fees).replace(/ /g, '') : '';
    $('txDate').value = t.trade_date;
    $('txNote').value = t.note || '';
    $('txSubmit').textContent = 'Shrani';
    $('txCancel').classList.remove('hidden');
    $('txHint').textContent = 'Urejaš vpis #' + id;
    syncTxLabels();
    location.hash = '#transakcije';
    $('txQty').focus();
}

function resetTxForm() {
    $('txForm').reset();
    $('txId').value = '';
    $('txSubmit').textContent = 'Dodaj';
    $('txCancel').classList.add('hidden');
    $('txHint').textContent = '';
    syncTxLabels();
}

function syncTxLabels() {
    const div = $('txSide').value === 'div';
    $('txQtyLabel').textContent = div ? 'Št. delnic' : 'Količina';
    $('txPriceLabel').textContent = div ? 'Neto na delnico (€)' : 'Cena na enoto (€)';
}

async function submitTx(event) {
    event.preventDefault();
    const body = {
        instrument_id: Number($('txInstrument').value),
        side: $('txSide').value,
        quantity: parseSlNum($('txQty').value),
        price: parseSlNum($('txPrice').value),
        fees: parseSlNum($('txFees').value) ?? 0,
        trade_date: $('txDate').value,
        note: $('txNote').value.trim(),
    };
    if (body.quantity === null || body.quantity <= 0) return showError('Vpiši veljavno količino.');
    if (body.price === null || body.price < 0) return showError('Vpiši veljavno ceno.');
    if (!body.trade_date) return showError('Izberi datum.');

    const editing = $('txId').value !== '';
    const url = API + '?resource=transactions' + (editing ? '&id=' + $('txId').value : '');
    const res = await fetch(url, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return showError((data && data.error) || 'Shranjevanje ni uspelo.');

    resetTxForm();
    await loadTransactions();
    renderAll();
    renderBoard(); // held-dot markers may change
    markSettled('txTable', 'tr[data-tx="' + data.id + '"]');
}

async function deleteTx(id) {
    if (!confirm('Izbrišem ta vpis?')) return;
    const res = await fetch(API + '?resource=transactions&id=' + id, { method: 'DELETE' });
    if (!res.ok) return showError('Brisanje ni uspelo.');
    await loadTransactions();
    renderAll();
    renderBoard();
}

function markSettled(hostId, selector) {
    const row = $(hostId).querySelector(selector);
    if (row) row.classList.add('settle');
}

// ------------------------------------------------------------------
//  Dividends
// ------------------------------------------------------------------

function renderDividends() {
    const held = holdings();
    const today = new Date().toISOString().slice(0, 10);

    const list = state.dividends;
    $('divTable').innerHTML = list.length ? `<table class="ledger"><thead><tr>
        <th>Papir</th><th>Bruto/delnico</th><th>Presečni dan</th><th>Ocena zate</th><th></th>
    </tr></thead><tbody>${list.map((d) => {
        const h = held[d.instrument_id];
        const mine = h && h.qty > 0 ? h.qty * d.amount : null;
        const upcoming = d.ex_date && d.ex_date >= today;
        return `<tr>
            <td><b>${escapeHtml(d.symbol)}</b>${upcoming ? '<span class="paper-name text-clay">prihaja</span>' : ''}</td>
            <td>${fmtEur(d.amount)}</td>
            <td>${fmtDateSl(d.ex_date)}</td>
            <td>${mine === null ? '–' : '<b>' + fmtEur(mine) + '</b> bruto'}</td>
            <td><button type="button" data-divdel="${d.id}" class="text-stone hover:text-clay underline decoration-dotted underline-offset-2">izbriši</button></td>
        </tr>`;
    }).join('')}</tbody></table>`
        : `<div class="p-6 text-center font-mono text-[0.72rem] text-stone">Ko izdajatelj napove dividendo, jo zabeleži zgoraj.</div>`;

    $('divTable').querySelectorAll('[data-divdel]').forEach((b) => {
        b.addEventListener('click', async () => {
            const res = await fetch(API + '?resource=dividends&id=' + b.dataset.divdel, { method: 'DELETE' });
            if (!res.ok) return showError('Brisanje ni uspelo.');
            await loadDividends();
            renderDividends();
        });
    });

    // Received: div transactions grouped by year.
    const received = state.transactions.filter((t) => t.side === 'div');
    const byYear = {};
    for (const t of received) {
        const year = t.trade_date.slice(0, 4);
        byYear[year] = (byYear[year] || 0) + t.quantity * t.price - t.fees;
    }
    const years = Object.keys(byYear).sort().reverse();
    $('divReceived').innerHTML = years.length ? `<table class="ledger"><thead><tr>
        <th>Leto</th><th>Neto prejeto</th></tr></thead><tbody>
        ${years.map((y) => `<tr><td>${y}</td><td><b>${fmtEur(byYear[y])}</b></td></tr>`).join('')}
    </tbody></table>`
        : `<div class="p-6 text-center font-mono text-[0.72rem] text-stone">Dividend še nisi prejel: ko jo, jo vpiši med transakcije.</div>`;

    // Yield on cost across the portfolio, when there is anything to say.
    const rows = enrichHoldings(held, quotes());
    const totals = enrichHoldings.totals(rows);
    const thisYear = byYear[new Date().getFullYear()] || 0;
    $('divYield').textContent = totals.costBasis > 0 && thisYear > 0
        ? 'letos ' + pct(thisYear / totals.costBasis * 100) + ' na vložek'
        : '';
}

// ------------------------------------------------------------------
//  Alerts
// ------------------------------------------------------------------

const KIND_LABELS = { above: 'cena nad', below: 'cena pod', move: 'dnevni premik nad' };

function renderAlerts() {
    const list = state.alerts;
    if (!list.length) {
        $('alertsList').innerHTML = `<div class="p-6 text-center font-mono text-[0.72rem] text-stone">
            Nobenega pravila še ni. Nastavi prvega in Telegram ti javi, ko se kaj zgodi.</div>`;
        return;
    }

    // Preview which rules would fire against the latest board.
    const firing = new Set(
        evaluateAlerts(list, quotes()).map((f) => f.alert.id),
    );

    $('alertsList').innerHTML = `<table class="ledger"><thead><tr>
        <th>Papir</th><th>Pogoj</th><th>Stanje</th><th></th>
    </tr></thead><tbody>${list.map((a) => {
        const unit = a.kind === 'move' ? pct(a.threshold) : fmtEur(a.threshold);
        const status = !a.active
            ? '<span class="text-stone">v premoru</span>'
            : firing.has(a.id)
                ? '<span class="text-clay font-bold">pogoj drži</span>'
                : a.last_fired_date
                    ? 'sproženo ' + fmtDateSl(a.last_fired_date)
                    : '<span class="text-stone">čaka</span>';
        return `<tr>
            <td><b>${a.symbol ? escapeHtml(a.symbol) : 'vsi papirji'}</b></td>
            <td>${KIND_LABELS[a.kind]} ${unit}</td>
            <td>${status}</td>
            <td class="whitespace-nowrap">
                <button type="button" data-toggle="${a.id}" class="text-stone hover:text-ink underline decoration-dotted underline-offset-2">${a.active ? 'premor' : 'vklopi'}</button>
                <button type="button" data-del="${a.id}" class="ml-2 text-stone hover:text-clay underline decoration-dotted underline-offset-2">izbriši</button>
            </td></tr>`;
    }).join('')}</tbody></table>`;

    $('alertsList').querySelectorAll('[data-toggle]').forEach((b) => {
        b.addEventListener('click', async () => {
            const alert = state.alerts.find((a) => a.id === Number(b.dataset.toggle));
            const res = await fetch(API + '?resource=alerts&id=' + alert.id, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active: alert.active ? 0 : 1 }),
            });
            if (!res.ok) return showError('Spreminjanje ni uspelo.');
            await loadAlerts();
            renderAlerts();
        });
    });
    $('alertsList').querySelectorAll('[data-del]').forEach((b) => {
        b.addEventListener('click', async () => {
            const res = await fetch(API + '?resource=alerts&id=' + b.dataset.del, { method: 'DELETE' });
            if (!res.ok) return showError('Brisanje ni uspelo.');
            await loadAlerts();
            renderAlerts();
        });
    });
}

async function submitAlert(event) {
    event.preventDefault();
    const kind = $('alertKind').value;
    const instrument = $('alertInstrument').value;
    const body = {
        kind,
        threshold: parseSlNum($('alertThreshold').value),
        instrument_id: instrument === '' ? null : Number(instrument),
    };
    if (body.threshold === null || body.threshold <= 0) return showError('Vpiši veljaven prag.');
    if (body.instrument_id === null && kind !== 'move') {
        return showError('Cenovno opozorilo potrebuje izbran papir.');
    }
    const res = await fetch(API + '?resource=alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return showError((data && data.error) || 'Shranjevanje ni uspelo.');
    $('alertForm').reset();
    syncAlertLabels();
    await loadAlerts();
    renderAlerts();
}

function syncAlertLabels() {
    const move = $('alertKind').value === 'move';
    $('alertThresholdLabel').textContent = move ? 'Prag (%)' : 'Prag (€)';
    $('alertThreshold').placeholder = move ? '3,0' : '280,00';
}

// ------------------------------------------------------------------
//  Tax clock
// ------------------------------------------------------------------

function renderTax() {
    const today = new Date().toISOString().slice(0, 10);
    const held = holdings();
    const blocks = [];

    for (const [id, h] of Object.entries(held)) {
        if (h.qty <= 0 || !h.lots.length) continue;
        const i = instrumentById(id);
        if (!i || i.last === null) continue;
        const report = taxReport(h.lots, i.last, today);
        blocks.push({ instrument: i, report });
    }

    if (!blocks.length) {
        $('taxBody').innerHTML = `<div class="bg-card border border-hairline rounded-[3px] p-6 text-center font-mono text-[0.72rem] text-stone">
            Davčna ura teče, ko imaš odprte pozicije.</div>`;
        return;
    }

    let totalTax = 0, totalGain = 0;
    const tables = blocks.map(({ instrument, report }) => {
        totalTax += report.totalTax;
        totalGain += report.totalGain;
        return `<div class="bg-card border border-hairline rounded-[3px] overflow-x-auto mb-4">
            <div class="px-4 pt-3 pb-1 flex items-baseline justify-between">
                <span class="font-display italic text-lg">${escapeHtml(instrument.name)}
                    <span class="font-mono not-italic text-sm text-stone">${escapeHtml(instrument.symbol)}</span></span>
                <span class="font-mono text-[0.68rem] text-stone">ob prodaji danes: <b class="${report.totalTax > 0 ? 'text-clay' : 'text-gain'}">${fmtEur(report.totalTax)}</b> davka</span>
            </div>
            <table class="ledger"><thead><tr>
                <th>Nakup</th><th>Količina</th><th>Nabavna</th><th>Dobiček</th><th>Stopnja</th><th>Davek</th><th>Nižja stopnja</th>
            </tr></thead><tbody>${report.lots.map((lot) => `<tr>
                <td>${fmtDateSl(lot.date)}</td>
                <td>${fmtQty(lot.qty)}</td>
                <td>${fmtEur(lot.unitCost)}</td>
                <td class="${signClass(lot.gain)}">${fmtEur(lot.gain)}</td>
                <td>${pct(lot.ratePct, 0)}</td>
                <td>${lot.tax > 0 ? fmtEur(lot.tax) : '–'}</td>
                <td>${lot.nextDropDate
                    ? `${pct(lot.nextRatePct, 0)} od ${fmtDateSl(lot.nextDropDate)}`
                    : '<span class="text-gain">brez davka</span>'}</td>
            </tr>`).join('')}</tbody></table></div>`;
    }).join('');

    $('taxBody').innerHTML = `
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3 mb-4">
            ${tile('Nerealiziran dobiček', fmtEur(totalGain), signClass(totalGain), true)}
            ${tile('Davek ob prodaji danes', fmtEur(totalTax), totalTax > 0 ? 'text-clay' : 'text-gain')}
        </div>${tables}`;
}

// ------------------------------------------------------------------
//  Forms wiring + selects + section nav
// ------------------------------------------------------------------

function fillInstrumentSelects() {
    const opts = groupBySegment(instruments()).map((g) =>
        `<optgroup label="${g.label}">${g.instruments.map((i) =>
            `<option value="${i.id}">${escapeHtml(i.symbol)} · ${escapeHtml(i.name)}</option>`).join('')}</optgroup>`
    ).join('');
    $('txInstrument').innerHTML = opts;
    $('divInstrument').innerHTML = opts;
    $('alertInstrument').innerHTML = '<option value="">— vsi papirji —</option>' + opts;
}

function wireForms() {
    $('txForm').addEventListener('submit', submitTx);
    $('txCancel').addEventListener('click', resetTxForm);
    $('txSide').addEventListener('change', syncTxLabels);
    $('txDate').value = new Date().toISOString().slice(0, 10);

    $('alertForm').addEventListener('submit', submitAlert);
    $('alertKind').addEventListener('change', syncAlertLabels);
    syncAlertLabels();

    $('divForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const body = {
            instrument_id: Number($('divInstrument').value),
            amount: parseSlNum($('divAmount').value),
            ex_date: $('divExDate').value || null,
            pay_date: $('divPayDate').value || null,
        };
        if (body.amount === null || body.amount <= 0) return showError('Vpiši veljaven znesek.');
        const res = await fetch(API + '?resource=dividends', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) return showError((data && data.error) || 'Shranjevanje ni uspelo.');
        $('divForm').reset();
        await loadDividends();
        renderDividends();
    });
}

function watchSections() {
    const links = [...document.querySelectorAll('#sectionNav .nav-link')];
    const sections = links.map((a) => document.querySelector(a.getAttribute('href')));
    const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            links.forEach((a) => a.classList.toggle('active',
                a.getAttribute('href') === '#' + entry.target.id));
        }
    }, { rootMargin: '-25% 0px -65% 0px' });
    sections.forEach((s) => s && observer.observe(s));
}
