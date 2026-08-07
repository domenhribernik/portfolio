// Trails: wiring only. Every decision worth arguing about lives in logic.js
// (pure, tested), storage.js (IndexedDB) or map.js (Leaflet). This file moves
// values between them and the DOM.
//
// The one thing that cannot be tested and must therefore be read carefully is
// the recording lifecycle at the bottom: browsers throttle and eventually
// freeze background tabs, and there is no web API that records GPS while the
// page is not on screen. So the app holds a Screen Wake Lock, keeps the
// instrument panel readable in a dark cabin, and treats every interruption as
// a gap it can draw honestly rather than a failure it hides.

import {
    formatDuration, formatKm, formatSpeed, formatAlt, formatDateDmy, formatClock,
    haversineKm, bearingDeg, horizonKm, deriveSpeedMps, acceptFix, gapSegments,
    flightStats, inflatePlaces, visibleCities, profileSeries, seriesPath,
    playbackIndex, interpolatePosition, deserializeFlight,
} from './logic.js';
import * as store from './storage.js';
import { createChart, setPlaces } from './map.js';
import * as api from './sync.js';

const $ = (id) => document.getElementById(id);
const el = {
    banners: $('banners'),
    fixLamp: $('fixLamp'), fixText: $('fixText'),
    dimLamp: $('dimLamp'), dimStatText: $('dimStatText'),
    recordMap: $('recordMap'), flightMap: $('flightMap'), sharedMap: $('sharedMap'),
    rose: $('rose'), roseTicks: $('roseTicks'), scaleBar: $('scaleBar'), scaleLabel: $('scaleLabel'),
    sightings: $('sightings'), sightingsList: $('sightingsList'), sightRadius: $('sightRadius'),
    panel: $('recordPanel'),
    gSpeed: $('gSpeed'), gAlt: $('gAlt'), gDist: $('gDist'), gTime: $('gTime'),
    dSpeed: $('dSpeed'), dAlt: $('dAlt'), dDist: $('dDist'), dTime: $('dTime'),
    btnStart: $('btnStart'), btnStop: $('btnStop'), btnDim: $('btnDim'), btnUndim: $('btnUndim'),
    dimmer: $('dimmer'),
    flightList: $('flightList'), historyEmpty: $('historyEmpty'), syncBox: $('syncBox'),
    flightName: $('flightName'), flightWhen: $('flightWhen'), flightTools: $('flightTools'),
    flightStats: $('flightStats'), scrub: $('scrub'), scrubOut: $('scrubOut'), scrubBox: $('scrubBox'),
    profileSvg: $('profileSvg'), profAxisA: $('profAxisA'), profAxisB: $('profAxisB'),
    sharedName: $('sharedName'), sharedWhen: $('sharedWhen'), sharedBy: $('sharedBy'),
    sharedStats: $('sharedStats'), sharedScrub: $('sharedScrub'), sharedScrubOut: $('sharedScrubOut'),
};

const state = {
    places: [],
    viewer: null,
    charts: {},
    screen: null,
    detail: null,      // { flight, points }
    shared: null,
    recording: null,   // see startRecording()
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** crypto.randomUUID needs a secure context; keep a usable id either way. */
function newId() {
    if (self.crypto?.randomUUID) return self.crypto.randomUUID();
    const b = new Uint8Array(16);
    (self.crypto || { getRandomValues: (a) => a.forEach((_, i) => { a[i] = Math.random() * 256; }) })
        .getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------- banners

function banner(id, { text, kind = 'warn', actions = [] }) {
    dismiss(id);
    const node = document.createElement('div');
    node.className = `banner banner--${kind}`;
    node.dataset.banner = id;
    node.innerHTML = `<span>${text}</span><span class="banner__spacer"></span>`;
    for (const a of actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `banner__btn${a.primary ? ' banner__btn--go' : ''}`;
        b.textContent = a.label;
        b.addEventListener('click', () => { a.onClick(); });
        node.appendChild(b);
    }
    el.banners.appendChild(node);
}

function dismiss(id) {
    el.banners.querySelector(`[data-banner="${id}"]`)?.remove();
}

// ---------------------------------------------------------------- chrome

function setFix(stateName, text) {
    el.fixLamp.dataset.state = stateName;
    el.fixText.textContent = text;
    // The night panel covers the header, and someone who dimmed the screen to
    // save battery still has to be able to see that the flight is recording.
    el.dimLamp.dataset.state = stateName;
    el.dimStatText.textContent = text;
}

function chartFor(name, container, opts) {
    if (!state.charts[name]) {
        state.charts[name] = createChart(container, opts);
        if (name === 'record' && state.charts.record) {
            state.charts.record.map.on('zoomend moveend', updateScaleBar);
            updateScaleBar();
        }
    }
    state.charts[name]?.invalidate();
    return state.charts[name];
}

/** The scale bar reports the ground distance its own width covers. */
function updateScaleBar() {
    const chart = state.charts.record;
    if (!chart) return;
    const mpp = chart.metresPerPixel();
    const target = 62;
    // Snap to a round number a chart would actually print.
    const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000,
        100_000, 200_000, 500_000, 1_000_000, 2_000_000];
    const raw = mpp * target;
    const pick = nice.find((n) => n >= raw) ?? nice[nice.length - 1];
    el.scaleBar.style.width = `${Math.round(pick / mpp)}px`;
    el.scaleLabel.textContent = formatKm(pick);
}

function buildRose() {
    const ticks = [];
    for (let i = 0; i < 36; i++) {
        const long = i % 9 === 0;
        const a = (i * 10) * Math.PI / 180;
        const r1 = long ? 27 : 31;
        ticks.push(`<line x1="${(50 + Math.sin(a) * r1).toFixed(1)}" y1="${(50 - Math.cos(a) * r1).toFixed(1)}"
                          x2="${(50 + Math.sin(a) * 34).toFixed(1)}" y2="${(50 - Math.cos(a) * 34).toFixed(1)}" />`);
    }
    el.roseTicks.innerHTML = ticks.join('');
}

// ---------------------------------------------------------------- routing

const SCREENS = ['record', 'history', 'flight', 'shared'];

function show(screen) {
    state.screen = screen;
    for (const s of SCREENS) {
        document.querySelector(`[data-screen="${s}"]`)?.classList.toggle('is-on', s === screen);
    }
    for (const t of document.querySelectorAll('.tab')) {
        t.classList.toggle('is-on', t.dataset.tab === screen
            || (screen === 'flight' && t.dataset.tab === 'history'));
    }
    // Leaflet measures 0x0 while its container is display:none.
    requestAnimationFrame(() => Object.values(state.charts).forEach((c) => c?.invalidate()));
}

async function route() {
    const token = new URLSearchParams(location.search).get('t');
    if (token) { await openShared(token); return; }

    const hash = location.hash.replace(/^#/, '');
    if (hash.startsWith('flight/')) { await openFlight(hash.slice(7)); return; }
    if (hash === 'history') { show('history'); await renderHistory(); return; }
    show('record');
    chartFor('record', el.recordMap);
}

// ---------------------------------------------------------------- history

async function renderHistory() {
    const flights = await store.listFlights();
    el.historyEmpty.classList.toggle('is-hidden', flights.length > 0);
    el.flightList.innerHTML = flights.map((f) => {
        const s = f.stats || {};
        const live = f.status === 'recording';
        return `<li><button class="flight" data-open="${esc(f.id)}" type="button">
            <span class="flight__date"><b>${formatDateDmy(f.startedAt)}</b>${formatClock(f.startedAt)}</span>
            <span class="flight__name">${esc(f.name || 'Untitled flight')}</span>
            <span class="flight__figs">
                <span>${formatKm((s.distanceKm || 0) * 1000)}</span>
                <span>${formatDuration(s.durationMs || 0)}</span>
                ${live ? '<span class="flight__flag">Recording</span>' : ''}
                ${s.gapCount ? `<span class="flight__flag">${s.gapCount} gap${s.gapCount > 1 ? 's' : ''}</span>` : ''}
                ${!f.syncedAt && state.viewer ? '<span class="flight__flag">Not synced</span>' : ''}
            </span>
            <span class="flight__arrow" aria-hidden="true">&rsaquo;</span>
        </button></li>`;
    }).join('');
    renderSyncBox();
}

function renderSyncBox() {
    if (!state.viewer) {
        el.syncBox.innerHTML = `<a class="btn btn--ghost btn--sm" href="${api.loginUrl()}">Sign in to sync</a>`;
        return;
    }
    el.syncBox.innerHTML = '<button class="btn btn--ghost btn--sm" id="btnSync" type="button">Sync now</button>';
    $('btnSync')?.addEventListener('click', () => runSync(true));
}

// ---------------------------------------------------------------- detail

function statRows(s, extra = []) {
    const rows = [
        ['Distance', formatKm((s.distanceKm || 0) * 1000)],
        ['Duration', formatDuration(s.durationMs || 0)],
        ['Max alt', formatAlt(s.maxAltM)],
        ['Max speed', formatSpeed((s.maxSpeedKmh || 0) / 3.6)],
        ['Avg speed', formatSpeed((s.avgSpeedKmh || 0) / 3.6)],
        ['Fixes', String(s.pointCount ?? 0)],
        ...extra,
    ];
    if (s.gapCount) rows.push(['Gaps', `${s.gapCount} · ${formatDuration(s.gapMs)}`]);
    return rows.map(([k, v]) => `<div class="gauge">
        <dt class="gauge__label">${k}</dt><dd class="gauge__value">${v}</dd></div>`).join('');
}

async function openFlight(id) {
    const flight = await store.getFlight(id);
    if (!flight) { location.hash = '#history'; return; }
    const points = await store.getPoints(id);
    state.detail = { flight, points };

    show('flight');
    el.flightName.value = flight.name || '';
    el.flightWhen.textContent = points.length
        ? `${formatDateDmy(flight.startedAt)} · ${formatClock(flight.startedAt)} to ${formatClock(flight.endedAt || points[points.length - 1].t)}`
        : formatDateDmy(flight.startedAt);
    el.flightStats.innerHTML = statRows(flight.stats || flightStats(points));

    const chart = chartFor('flight', el.flightMap);
    if (chart) {
        chart.setTrack(gapSegments(points));
        chart.fitTrack(points);
        if (points.length) {
            const last = points[points.length - 1];
            chart.setPosition(last.lat, last.lon, headingAt(points, points.length - 1));
        }
    }

    renderProfile(el.profileSvg, el.profAxisA, el.profAxisB, points);
    wireScrub(el.scrub, el.scrubOut, points, chart);
    renderTools(flight);
}

function renderTools(flight) {
    const shared = !!flight.shareUrl;
    el.flightTools.innerHTML = `
        <button class="btn btn--ghost btn--sm" id="btnShare" type="button">${shared ? 'Sharing' : 'Share'}</button>
        <button class="btn btn--ghost btn--sm btn--danger" id="btnDelete" type="button">Delete</button>
        ${shared ? `<div class="share-url">
            <input id="shareUrl" readonly value="${esc(flight.shareUrl)}" aria-label="Public link to this flight">
            <button class="btn btn--ghost btn--sm" id="btnCopy" type="button">Copy</button>
            <button class="btn btn--ghost btn--sm btn--danger" id="btnUnshare" type="button">Stop</button>
        </div>` : ''}`;

    $('btnShare')?.addEventListener('click', () => shareFlight(flight));
    $('btnDelete')?.addEventListener('click', () => deleteFlight(flight));
    $('btnUnshare')?.addEventListener('click', () => unshareFlight(flight));
    $('btnCopy')?.addEventListener('click', async () => {
        const input = $('shareUrl');
        input.select();
        try { await navigator.clipboard.writeText(input.value); $('btnCopy').textContent = 'Copied'; }
        catch { /* the selection is the fallback */ }
    });
}

async function shareFlight(flight) {
    if (!state.viewer) {
        banner('share', {
            text: 'Sharing puts this flight on a public link, so it needs an account.',
            kind: 'info',
            actions: [{ label: 'Sign in', primary: true, onClick: () => { location.href = api.loginUrl(); } }],
        });
        return;
    }
    $('btnShare').disabled = true;
    // A flight the server has never seen cannot be shared; push it first.
    await runSync(false);
    const res = await api.createShare(flight.id);
    $('btnShare').disabled = false;
    if (!res.ok) {
        banner('share', { text: res.offline ? 'No connection, so the link could not be created.' : (res.error || 'Could not create the link.') });
        return;
    }
    const url = `${location.origin}${location.pathname}?t=${res.data.token}`;
    const updated = await store.updateFlight(flight.id, { shareUrl: url });
    state.detail.flight = updated;
    renderTools(updated);
}

async function unshareFlight(flight) {
    const res = await api.revokeShare(flight.id);
    if (!res.ok && !res.signedOut) {
        banner('share', { text: res.error || 'Could not stop sharing.' });
        return;
    }
    const updated = await store.updateFlight(flight.id, { shareUrl: null });
    state.detail.flight = updated;
    renderTools(updated);
}

async function deleteFlight(flight) {
    const btn = $('btnDelete');
    if (btn.dataset.armed !== '1') {
        btn.dataset.armed = '1';
        btn.textContent = 'Delete for good?';
        setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = '0'; btn.textContent = 'Delete'; } }, 4000);
        return;
    }
    if (state.recording?.flightId === flight.id) await stopRecording();
    await store.markDeleted(flight.id);
    runSync(false);
    location.hash = '#history';
}

/** Heading at a point, taken from the leg that arrived there. */
function headingAt(points, i) {
    if (i <= 0 || !points[i - 1]) return 0;
    return bearingDeg(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
}

function renderProfile(svg, axisA, axisB, points) {
    const W = 640;
    const H = 180;
    const alt = profileSeries(points, 'alt');
    const spd = profileSeries(points, 'spd').map((p) => ({ t: p.t, v: p.v * 3.6 }));

    if (!alt.length && !spd.length) {
        svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#6d8798"
            font-family="B612 Mono, monospace" font-size="13">No altitude or speed recorded</text>`;
        axisA.textContent = axisB.textContent = '';
        return;
    }

    // A channel sitting at its own maximum lands exactly on the top edge and
    // loses half its stroke to the clip, so the plot is inset from the frame.
    const PAD = 10;
    const plotH = H - PAD * 2;

    const grid = [0.25, 0.5, 0.75].map((f) =>
        `<line class="profile__grid" x1="0" y1="${(H * f).toFixed(1)}" x2="${W}" y2="${(H * f).toFixed(1)}" />`).join('');

    const span = (s) => {
        const vs = s.map((p) => p.v);
        return { min: Math.min(...vs, 0), max: Math.max(...vs) || 1 };
    };
    // Both channels share the x-axis of the whole flight, not their own extent.
    const t0 = points.length ? points[0].t : 0;
    const t1 = points.length ? points[points.length - 1].t : 1;
    const stretch = (s) => (s.length ? [{ t: t0, v: s[0].v }, ...s, { t: t1, v: s[s.length - 1].v }] : s);

    let lines = '';
    if (alt.length) {
        lines += `<path class="profile__line profile__line--alt" d="${seriesPath(stretch(alt), { width: W, height: plotH, ...span(alt) })}" />`;
    }
    if (spd.length) {
        lines += `<path class="profile__line profile__line--spd" d="${seriesPath(stretch(spd), { width: W, height: plotH, ...span(spd) })}" />`;
    }
    svg.innerHTML = `${grid}<g transform="translate(0 ${PAD})">${lines}</g>`;
    axisA.textContent = formatClock(t0);
    axisB.textContent = formatClock(t1);
}

function wireScrub(range, out, points, chart) {
    const box = range.closest('.scrub');
    if (points.length < 2) { box.classList.add('is-hidden'); return; }
    box.classList.remove('is-hidden');
    const t0 = points[0].t;
    const span = points[points.length - 1].t - t0;
    range.value = '1000';
    out.textContent = formatClock(points[points.length - 1].t);

    range.oninput = () => {
        const t = t0 + (Number(range.value) / 1000) * span;
        const pos = interpolatePosition(points, t);
        out.textContent = formatClock(t);
        if (pos && chart) {
            chart.setPosition(pos.lat, pos.lon, headingAt(points, playbackIndex(points, t)));
        }
    };
}

// ---------------------------------------------------------------- shared

async function openShared(token) {
    show('shared');
    el.sharedName.textContent = 'Loading…';
    const res = await api.fetchShared(token);
    if (!res.ok) {
        el.sharedName.textContent = 'This link is not available';
        el.sharedWhen.textContent = res.offline
            ? 'A shared flight needs a connection to load.'
            : 'It may have been unshared or deleted.';
        return;
    }
    const parsed = deserializeFlight(res.data.flight);
    if (!parsed) { el.sharedName.textContent = 'This flight could not be read'; return; }

    const { flight, points } = parsed;
    state.shared = parsed;
    el.sharedBy.textContent = res.data.owner ? `Shared by ${res.data.owner}` : 'Shared flight';
    el.sharedName.textContent = flight.name || 'Untitled flight';
    el.sharedWhen.textContent = points.length
        ? `${formatDateDmy(flight.startedAt)} · ${formatClock(flight.startedAt)} to ${formatClock(points[points.length - 1].t)}`
        : formatDateDmy(flight.startedAt);
    el.sharedStats.innerHTML = statRows(flight.stats || flightStats(points));

    const chart = chartFor('shared', el.sharedMap);
    if (chart) {
        chart.setTrack(gapSegments(points));
        chart.fitTrack(points);
        if (points.length) {
            const last = points[points.length - 1];
            chart.setPosition(last.lat, last.lon, headingAt(points, points.length - 1));
        }
    }
    wireScrub(el.sharedScrub, el.sharedScrubOut, points, chart);
}

// ---------------------------------------------------------------- recording

let wakeLock = null;

async function holdScreenAwake() {
    if (!('wakeLock' in navigator)) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); }
    catch { wakeLock = null; }
}

function releaseScreen() {
    try { wakeLock?.release(); } catch { /* already gone */ }
    wakeLock = null;
}

async function startRecording() {
    if (!navigator.geolocation) {
        banner('gps', { text: 'This browser has no geolocation, so there is nothing to record.' });
        return;
    }

    const now = Date.now();
    const flight = {
        id: newId(),
        name: `Flight ${formatDateDmy(now)}`,
        startedAt: now,
        endedAt: null,
        status: 'recording',
        stats: flightStats([]),
        updatedAt: now,
        syncedAt: null,
        deletedAt: null,
        shareUrl: null,
    };
    await store.createFlight(flight);
    await store.setMeta('activeFlightId', flight.id);
    beginWatch(flight, []);
}

/** Attach a geolocation watch to a flight, resuming an existing track or not. */
function beginWatch(flight, points) {
    dismiss('resume');
    dismiss('gps');
    const resumed = points.length > 0;

    state.recording = {
        flightId: flight.id,
        startedAt: flight.startedAt,
        points,
        last: points.length ? points[points.length - 1] : null,
        distanceKm: flightStats(points).distanceKm || 0,
        // A resumed flight always marks its next fix, so the map draws the
        // silence as a dashed leg instead of pretending it flew a straight line.
        pendingGap: resumed,
        lastSightings: 0,
    };

    el.btnStart.classList.add('is-hidden');
    el.btnStop.classList.remove('is-hidden');
    setFix('wait', 'Acquiring');
    holdScreenAwake();

    const chart = chartFor('record', el.recordMap);
    if (chart) chart.follow = true;
    // Paint the panel from what is already stored before waiting on GPS.
    // A resumed flight can be minutes from its next accepted fix, and blank
    // instruments over a track that is safely on disk read as lost data.
    if (points.length) paintLive(points[points.length - 1]);

    state.recording.watchId = navigator.geolocation.watchPosition(onFix, onFixError, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 20_000,
    });

    state.recording.ticker = setInterval(tickClock, 1000);
    tickClock();
}

async function onFix(position) {
    const rec = state.recording;
    if (!rec) return;

    const c = position.coords;
    const fix = {
        flightId: rec.flightId,
        t: position.timestamp || Date.now(),
        lat: c.latitude,
        lon: c.longitude,
        alt: Number.isFinite(c.altitude) ? c.altitude : null,
        acc: Number.isFinite(c.accuracy) ? c.accuracy : null,
        spd: Number.isFinite(c.speed) ? c.speed : null,
        gap: false,
    };

    setFix('live', fix.acc != null ? `Fix · ${Math.round(fix.acc)} m` : 'Fix');

    if (!acceptFix(rec.last, fix)) return;
    if (fix.spd === null) fix.spd = deriveSpeedMps(rec.last, fix);
    if (rec.pendingGap) { fix.gap = true; rec.pendingGap = false; }

    if (rec.last) rec.distanceKm += haversineKm(rec.last.lat, rec.last.lon, fix.lat, fix.lon);
    rec.points.push(fix);
    rec.last = fix;
    await store.appendPoint(fix);

    paintLive(fix);

    // Stats are recomputed on a slow cadence: cheap enough at one fix per few
    // seconds, and it means a crash never loses more than half a minute.
    if (rec.points.length % 10 === 0) {
        await store.updateFlight(rec.flightId, { stats: flightStats(rec.points) });
    }
}

function paintLive(fix) {
    const rec = state.recording;
    const chart = state.charts.record;
    const heading = rec.points.length > 1 ? headingAt(rec.points, rec.points.length - 1) : 0;

    el.gSpeed.innerHTML = withUnit(formatSpeed(fix.spd));
    el.gAlt.innerHTML = withUnit(formatAlt(fix.alt));
    el.gDist.innerHTML = withUnit(formatKm(rec.distanceKm * 1000));
    el.dSpeed.innerHTML = el.gSpeed.innerHTML;
    el.dAlt.innerHTML = el.gAlt.innerHTML;
    el.dDist.innerHTML = el.gDist.innerHTML;

    if (chart) {
        chart.setTrack(gapSegments(rec.points));
        chart.setPosition(fix.lat, fix.lon, heading);
        chart.setHorizon(fix.lat, fix.lon, horizonKm(fix.alt));
    }
    el.rose.querySelector('.rose__needle').style.transform = `rotate(${heading}deg)`;

    // Recomputing 2000 places against every fix is wasted work; the horizon
    // barely moves in fifteen seconds.
    if (Date.now() - rec.lastSightings > 15_000) {
        rec.lastSightings = Date.now();
        paintSightings(fix);
    }
}

const withUnit = (s) => String(s).replace(/\s(m|km|km\/h)$/, ' <small>$1</small>');

function paintSightings(fix) {
    const radius = horizonKm(fix.alt);
    const seen = visibleCities(fix.lat, fix.lon, fix.alt, state.places);
    el.sightings.classList.toggle('is-empty', seen.length === 0);
    el.sightRadius.textContent = radius ? `${formatKm(radius * 1000)} out` : '';
    el.sightingsList.innerHTML = seen.map((c) => `<li class="sight">
        <span class="sight__name"><b>${esc(c.name)}</b>${c.country ? ` <i>${esc(c.country)}</i>` : ''}</span>
        <span class="sight__dist">${formatKm(c.distanceKm * 1000)}</span>
        <span class="sight__brg">${c.compass}</span>
    </li>`).join('');
    state.charts.record?.setLabels(seen.map((c) => {
        const src = state.places.find((p) => p.name === c.name && p.country === c.country);
        return { name: c.name, lat: src?.lat, lon: src?.lon };
    }).filter((p) => Number.isFinite(p.lat)));
}

function onFixError(err) {
    if (err.code === err.PERMISSION_DENIED) {
        setFix('error', 'Denied');
        banner('gps', {
            text: 'Location is blocked for this page, so there is nothing to record. Allow it in your browser\'s site settings and press start again.',
        });
        stopRecording();
        return;
    }
    setFix('wait', err.code === err.TIMEOUT ? 'Searching' : 'No signal');
}

function tickClock() {
    const rec = state.recording;
    if (!rec) return;
    const elapsed = formatDuration(Date.now() - rec.startedAt);
    el.gTime.textContent = elapsed;
    el.dTime.textContent = elapsed;
}

async function stopRecording() {
    const rec = state.recording;
    if (!rec) return;
    state.recording = null;

    if (rec.watchId != null) navigator.geolocation.clearWatch(rec.watchId);
    clearInterval(rec.ticker);
    releaseScreen();

    el.btnStop.classList.add('is-hidden');
    el.btnStart.classList.remove('is-hidden');
    setFix('idle', 'Standby');

    const points = await store.getPoints(rec.flightId);
    const stats = flightStats(points);
    // startedAt was the moment the button was pressed, which is not when the
    // flight is known to have begun: the first fix can be a minute of
    // acquisition later, and a device whose GPS clock differs from its system
    // clock widens that further. Once there is a track, the track is the
    // truth, so the row agrees with its own points and its own stats.
    await store.updateFlight(rec.flightId, {
        status: 'done',
        startedAt: points.length ? points[0].t : rec.startedAt,
        endedAt: points.length ? points[points.length - 1].t : Date.now(),
        stats,
    });
    await store.setMeta('activeFlightId', null);

    runSync(false);
    if (points.length) location.hash = `#flight/${rec.flightId}`;
    else location.hash = '#history';
}

/** A flight left recording by a reload or a crash is offered back, never dropped. */
async function offerResume() {
    const id = await store.getMeta('activeFlightId');
    if (!id) return;
    const flight = await store.getFlight(id);
    if (!flight || flight.status !== 'recording') { await store.setMeta('activeFlightId', null); return; }
    const points = await store.getPoints(id);

    banner('resume', {
        text: `A flight from ${formatClock(flight.startedAt)} is still recording, with ${points.length} fixes saved.`,
        kind: 'go',
        actions: [
            { label: 'Resume', primary: true, onClick: () => beginWatch(flight, points) },
            {
                label: 'End it',
                onClick: async () => {
                    dismiss('resume');
                    await store.updateFlight(id, {
                        status: 'done',
                        startedAt: points.length ? points[0].t : flight.startedAt,
                        endedAt: points.length ? points[points.length - 1].t : flight.startedAt,
                        stats: flightStats(points),
                    });
                    await store.setMeta('activeFlightId', null);
                    location.hash = `#flight/${id}`;
                },
            },
        ],
    });
}

// ---------------------------------------------------------------- sync

let syncing = false;

async function runSync(loud) {
    if (syncing || !state.viewer) return;
    syncing = true;
    if (loud) $('btnSync') && ($('btnSync').textContent = 'Syncing…');

    const res = await api.syncFlights({
        local: await store.listAllFlights(),
        load: (uuid) => store.getPoints(uuid),
        save: async (flight, points) => {
            const existing = await store.getFlight(flight.id);
            const row = {
                ...flight,
                status: 'done',
                syncedAt: Date.now(),
                deletedAt: existing?.deletedAt ?? null,
                shareUrl: existing?.shareUrl ?? null,
            };
            if (existing) await store.updateFlight(flight.id, { ...row, updatedAt: flight.updatedAt });
            else await store.createFlight(row);
            await store.replacePoints(flight.id, points);
        },
        markSynced: (uuid) => store.updateFlight(uuid, { syncedAt: Date.now() }),
    });

    syncing = false;
    if (loud) {
        renderSyncBox();
        if (!res.ok) {
            banner('sync', { text: res.signedOut ? 'Your session expired. Sign in again to sync.' : (res.error || 'Sync failed.') });
        } else {
            dismiss('sync');
        }
    }
    if (res.ok && (res.pushed || res.pulled) && state.screen === 'history') await renderHistory();
}

// ---------------------------------------------------------------- boot

function wireEvents() {
    el.btnStart.addEventListener('click', startRecording);
    el.btnStop.addEventListener('click', stopRecording);

    el.btnDim.addEventListener('click', () => {
        el.dimmer.hidden = false;
        el.btnDim.setAttribute('aria-pressed', 'true');
        el.btnUndim.focus();
    });
    el.btnUndim.addEventListener('click', () => {
        el.dimmer.hidden = true;
        el.btnDim.setAttribute('aria-pressed', 'false');
        el.btnDim.focus();
    });

    el.sightings.addEventListener('click', () => {
        const open = el.sightings.getAttribute('aria-expanded') === 'true';
        el.sightings.setAttribute('aria-expanded', String(!open));
    });

    el.flightList.addEventListener('click', (e) => {
        const id = e.target.closest('[data-open]')?.dataset.open;
        if (id) location.hash = `#flight/${id}`;
    });

    el.flightName.addEventListener('change', async () => {
        if (!state.detail) return;
        const name = el.flightName.value.trim().slice(0, 120);
        const updated = await store.updateFlight(state.detail.flight.id, { name });
        state.detail.flight = updated;
        if (state.viewer) api.renameRemote(updated.id, name);
    });

    window.addEventListener('hashchange', route);

    window.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        // The lock is dropped whenever the page is hidden and must be retaken.
        if (state.recording) holdScreenAwake();
        Object.values(state.charts).forEach((c) => c?.invalidate());
    });

    window.addEventListener('online', () => { dismiss('offline'); runSync(false); });
}

async function boot() {
    buildRose();
    wireEvents();

    // The panel's height positions the sightings block above it.
    const setPanelVar = () => document.documentElement.style
        .setProperty('--panel-h', `${el.panel.offsetHeight}px`);
    setPanelVar();
    new ResizeObserver(setPanelVar).observe(el.panel);

    const persists = await store.storageReady;
    if (!persists) {
        banner('storage', {
            text: 'This browser will not let the page store anything, usually private browsing. Recording works, but flights disappear when you close the tab.',
        });
    }

    fetch('data/places.json')
        .then((r) => r.json())
        .then((d) => {
            state.places = inflatePlaces(d);
            setPlaces(state.places);
            Object.values(state.charts).forEach((c) => c?.redrawTowns());
        })
        .catch(() => { state.places = []; });

    await route();

    // Everything above works signed out and offline. Only now go look.
    const session = await api.getSession();
    if (session.ok && session.data.viewer) {
        state.viewer = session.data.viewer;
        renderSyncBox();
        runSync(false);
    } else if (state.screen === 'history') {
        renderSyncBox();
    }

    if (!new URLSearchParams(location.search).get('t')) await offerResume();
}

boot();
