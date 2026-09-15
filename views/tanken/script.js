/**
 * views/tanken: DOM wiring only. Every decision with a right answer lives in
 * logic.js and is tested by tests/tanken-logic.test.mjs.
 *
 * The page never talks to Tankerkoenig. It reads our own controller, which
 * serves the database; whether a request also triggered an outbound call is
 * decided server-side by a once-a-minute lease, so reloading changes nothing.
 */

import {
    FUELS, FUEL_LABELS, WEEKDAYS, WEEKDAY_LABELS,
    clampRadius, formatPrice, formatKm, formatHour, formatCents,
    priceOf, sortByPrice, bestPrice, relativeAge, freshestObservation,
    hasStats, curveSeries, cheapestHour, dearestHour, dailySwing,
    curveToPath, curveDomain, niceTicks,
} from './logic.js';

const API = '../../app/controllers/tanken-controller.php';
const NOMINATIM = 'https://nominatim.openstreetmap.org';

const $ = (id) => document.getElementById(id);

const state = {
    lat: null,
    lng: null,
    radius: 5,
    fuel: 'e5',
    weekday: null,
    stations: [],
    stats: null,
    degraded: false,
};

/* ---------------------------------------------------------------- panels */

function setPanel(name) {
    document.body.classList.remove('nolocation', 'loading', 'ready', 'error');
    document.body.classList.add(name);
}

function setStatus(text) {
    $('searchStatus').textContent = text || '';
}

/* ------------------------------------------------------------------ data */

async function loadStations() {
    if (state.lat === null) return;
    setPanel('loading');
    try {
        const url = `${API}?action=stations&lat=${state.lat}&lng=${state.lng}&rad=${state.radius}`;
        const response = await fetch(url);
        const data = await response.json().catch(() => null);
        if (!response.ok) {
            const error = new Error((data && data.error) || `Request failed (${response.status})`);
            error.status = response.status;
            throw error;
        }
        if (data.outsideCoverage) {
            state.stations = [];
            state.degraded = false;
            renderStations();
            setPanel('ready');
            setStatus('That place is outside Germany, which is all this data covers.');
            return;
        }
        state.stations = Array.isArray(data.stations) ? data.stations : [];
        state.degraded = !!data.degraded;
        renderStations();
        setPanel('ready');
    } catch (err) {
        // A status means the server answered and said no; its absence means we
        // never reached it, which is a different thing to tell someone.
        $('errorText').textContent = err.status
            ? err.message
            : 'Could not reach the price service. Check your connection and try again.';
        setPanel('error');
    }
}

async function loadStats() {
    try {
        const response = await fetch('hourly-stats.json');
        if (!response.ok) return;
        state.stats = await response.json();
    } catch {
        state.stats = null;
    }
    renderStats();
}

/* -------------------------------------------------------------- location */

function useMyLocation() {
    if (!navigator.geolocation) {
        setStatus('This browser has no geolocation, so type a place instead.');
        return;
    }
    setStatus('Locating…');
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            setStatus('');
            setLocation(pos.coords.latitude, pos.coords.longitude);
        },
        () => setStatus('Could not get your location. Type a place instead.'),
        { enableHighAccuracy: true, timeout: 10000 },
    );
}

async function searchPlace(query) {
    if (!query.trim()) return;
    setStatus('Searching…');
    try {
        const url = `${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=5&countrycodes=de&q=${encodeURIComponent(query)}`;
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        const list = await response.json();
        if (!Array.isArray(list) || !list.length) {
            setStatus('No such place in Germany.');
            return;
        }
        const hit = list[0];
        setStatus(hit.display_name.split(',').slice(0, 2).join(',').trim());
        setLocation(parseFloat(hit.lat), parseFloat(hit.lon));
    } catch {
        setStatus('Place search is unavailable right now.');
    }
}

function setLocation(lat, lng) {
    state.lat = Number(lat.toFixed(5));
    state.lng = Number(lng.toFixed(5));
    loadStations();
}

/* --------------------------------------------------------------- render */

function renderFuelTabs() {
    $('fuelTabs').innerHTML = FUELS.map((fuel) => {
        const active = fuel === state.fuel;
        return `<button type="button" role="tab" data-fuel="${fuel}" aria-selected="${active}"
            class="font-mono text-[0.72rem] tracking-[0.12em] uppercase ${active
                ? 'text-ink underline decoration-clay decoration-2 underline-offset-4'
                : 'text-stone hover:text-ink'}">${FUEL_LABELS[fuel]}</button>`;
    }).join('');
}

function renderStations() {
    const sorted = sortByPrice(state.stations, state.fuel);
    const best = bestPrice(state.stations, state.fuel);

    $('stationCount').textContent = sorted.length
        ? `${sorted.length} within ${state.radius} km`
        : '';
    $('emptyNote').classList.toggle('hidden', sorted.length > 0);

    $('headline').innerHTML = best
        ? `Cheapest right now: <strong class="font-display">${formatPrice(best.price)}</strong> at ${escapeHtml(best.station.brand || best.station.name)}, ${formatKm(best.station.dist)} away.`
        : '';

    $('stationList').innerHTML = sorted.map((station, index) => {
        const entry = priceOf(station, state.fuel);
        const closed = !entry || entry.status !== 'open';
        const isBest = best && station.id === best.station.id;
        const address = [station.street, station.houseNumber].filter(Boolean).join(' ');
        const note = !entry ? 'no price' : entry.status === 'closed' ? 'closed' : '';

        return `<li class="station-row${closed ? ' is-closed' : ''}${isBest ? ' is-best' : ''}">
            <span class="font-mono text-[0.72rem] text-faint tabular-nums">${String(index + 1).padStart(2, '0')}</span>
            <span class="min-w-0">
                <span class="block font-medium truncate">${escapeHtml(station.brand || station.name)}</span>
                <span class="block font-mono text-[0.68rem] text-stone truncate">${escapeHtml(address)}${address && station.place ? ', ' : ''}${escapeHtml(station.place)} · ${formatKm(station.dist)}</span>
            </span>
            <span class="station-price text-right">
                <span class="block font-display text-[1.05rem]">${entry ? formatPrice(entry.price) : '—'}</span>
                <span class="block font-mono text-[0.62rem] text-stone">${note ? escapeHtml(note) + ' · ' : ''}${escapeHtml(relativeAge(entry && entry.observedAt))}</span>
            </span>
        </li>`;
    }).join('');

    const freshest = freshestObservation(state.stations, state.fuel);
    $('freshness').textContent = freshest
        ? `Last updated ${relativeAge(freshest)}.${state.degraded ? ' The last refresh did not go through, so these may be older than usual.' : ''}`
        : '';
}

function renderStats() {
    const stats = state.stats;
    const ready = hasStats(stats);
    $('statsEmpty').classList.toggle('hidden', ready);
    $('chartHost').classList.toggle('hidden', !ready);
    $('weekdayTabs').classList.toggle('hidden', !ready);

    if (!ready) {
        $('statsHeadline').textContent = '';
        $('statsWindow').textContent = '';
        return;
    }

    const cheap = cheapestHour(stats, state.fuel, state.weekday);
    const dear = dearestHour(stats, state.fuel, state.weekday);
    const swing = dailySwing(stats, state.fuel, state.weekday);

    $('statsWindow').textContent = `${stats.window.days} days · ${stats.window.from} to ${stats.window.to}`;
    $('statsHeadline').innerHTML = cheap === null ? '' :
        `Cheapest time to fill up: <strong class="font-display">around ${formatHour(cheap)}</strong>. ` +
        `Dearest around ${formatHour(dear)}, a difference of about ${formatCents(swing).replace('+', '')} a litre.`;

    renderWeekdayTabs();
    drawCurve();
}

function renderWeekdayTabs() {
    const options = [{ key: null, label: 'All week' }]
        .concat(WEEKDAYS.map((key) => ({ key, label: WEEKDAY_LABELS[key].slice(0, 3) })));
    $('weekdayTabs').innerHTML = options.map(({ key, label }) => {
        const active = key === state.weekday;
        return `<button type="button" role="tab" data-weekday="${key === null ? '' : key}" aria-selected="${active}"
            class="font-mono text-[0.68rem] tracking-[0.1em] uppercase ${active
                ? 'text-ink underline decoration-clay decoration-2 underline-offset-4'
                : 'text-stone hover:text-ink'}">${label}</button>`;
    }).join('');
}

/* The curve, as inline SVG. There is no charting library in this repo and
   this needs one line, an axis and a baseline. */
function drawCurve() {
    const host = $('chartHost');
    const series = curveSeries(state.stats, state.fuel, state.weekday);
    if (series.length < 2) {
        host.innerHTML = '<div class="flex items-center justify-center h-32 font-mono text-[0.72rem] text-stone">Not enough data for this day.</div>';
        return;
    }

    const W = 640, H = 240;
    const PAD_L = 52, PAD_R = 12, PAD_T = 14, PAD_B = 28;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;

    const { min, max } = curveDomain(series);
    const ticks = niceTicks(min, max, 4);

    const y = (value) => PAD_T + (1 - (value - min) / (max - min || 1)) * plotH;
    const x = (hour) => PAD_L + (hour / 23) * plotW;

    const grid = ticks.map((tick) => `
        <line x1="${PAD_L}" x2="${W - PAD_R}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}"
              stroke="rgba(28,26,23,0.08)" stroke-width="1"/>
        <text x="${PAD_L - 8}" y="${(y(tick) + 3).toFixed(1)}" text-anchor="end"
              font-family="'Space Mono', monospace" font-size="9" fill="#6b6256">${formatCents(tick)}</text>`).join('');

    // The daily mean is the thing every value is measured against, so it gets
    // a real line rather than being left implicit at an unlabelled gridline.
    const baseline = `<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"
                            stroke="rgba(28,26,23,0.3)" stroke-width="1" stroke-dasharray="3 3"/>`;

    const hourLabels = [0, 4, 8, 12, 16, 20].map((hour) => `
        <text x="${x(hour).toFixed(1)}" y="${H - 8}" text-anchor="middle"
              font-family="'Space Mono', monospace" font-size="9" fill="#6b6256">${formatHour(hour)}</text>`).join('');

    const path = curveToPath(series, { width: plotW, height: plotH, min, max });

    const cheap = cheapestHour(state.stats, state.fuel, state.weekday);
    const cheapPoint = series.find((p) => p.hour === cheap);
    const marker = cheapPoint ? `
        <circle cx="${x(cheapPoint.hour).toFixed(1)}" cy="${y(cheapPoint.value).toFixed(1)}" r="4"
                fill="#2f5b53"/>` : '';

    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Average price deviation by hour of day for ${FUEL_LABELS[state.fuel]}">
        ${grid}${baseline}
        <path d="${path}" transform="translate(${PAD_L},${PAD_T})" fill="none"
              stroke="#1c1a17" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        ${marker}${hourLabels}
    </svg>`;
}

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ----------------------------------------------------------------- wiring */

$('geoBtn').addEventListener('click', useMyLocation);

$('searchForm').addEventListener('submit', (event) => {
    event.preventDefault();
    searchPlace($('searchInput').value);
});

$('radiusInput').addEventListener('input', (event) => {
    state.radius = clampRadius(Number(event.target.value));
    $('radiusValue').textContent = `${state.radius} km`;
});
$('radiusInput').addEventListener('change', () => loadStations());

$('fuelTabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-fuel]');
    if (!button) return;
    state.fuel = button.dataset.fuel;
    renderFuelTabs();
    renderStations();
    renderStats();
});

$('weekdayTabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-weekday]');
    if (!button) return;
    state.weekday = button.dataset.weekday || null;
    renderStats();
});

$('retryBtn').addEventListener('click', () => loadStations());

renderFuelTabs();
setPanel('nolocation');
loadStats();
