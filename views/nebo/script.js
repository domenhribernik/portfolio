// Page wiring for Nebo: loads the catalogs, runs the clock, and connects the
// controls, tooltip and almanac to the pure math in logic.js / render.js.
// Every visible string flows through the dictionaries in lang/ (see i18n.js):
// the system language picks the startup language, the masthead dropdown and
// localStorage override it.
import {
    julianDay, schlyterD, lst, raDecToAltAz,
    sunPosition, moonPosition, moonPhase, moonTopocentricAlt,
    planetPositions, riseSet, parseStars,
} from './logic.js';
import { drawSky, PLANET_STYLE } from './render.js';
import { zoomAt, clampPan, clampZoom, screenToWorld } from './zoom.js';
import { formatCoords } from './geo.js';
import { openLocationPicker } from './location-map.js';
import {
    pickLanguage, lookup, format, loadDictionary, applyTranslations,
    FALLBACK, STORAGE_KEY,
} from './i18n.js';

const LJUBLJANA = { lat: 46.0569, lon: 14.5058 };
// English fallback until a dictionary arrives; dict.compass replaces it
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

const $ = (id) => document.getElementById(id);
const canvas = $('skyCanvas');
const ctx = canvas.getContext('2d');
const tooltip = $('tooltip');

const state = {
    lat: LJUBLJANA.lat,
    lon: LJUBLJANA.lon,
    placeKey: 'home',  // 'home' = the Ljubljana default, 'picked' = chosen on the map
    placeName: null,   // reverse-geocoded label for a picked place, when we have one
    anchor: null,      // Date chosen via the date input; null = anchored to now
    offsetMin: 0,      // slider offset in minutes
    showLines: true,
    showLabels: true,
    showGraticule: true,
    stars: [],
    constellations: [],
    hover: null,
    objects: [],
    // pinch-to-zoom viewport (touch only): screen = world * zoom + pan
    zoom: 1,
    panX: 0,
    panY: 0,
    almanacKey: '',
    lang: null,
    dict: null,
};

function displayedDate() {
    const base = state.anchor ? state.anchor.getTime() : Date.now();
    return new Date(base + state.offsetMin * 60000);
}

function isLive() {
    return !state.anchor && state.offsetMin === 0;
}

// The date input shows today by default (local YYYY-MM-DD) instead of an empty
// mm/dd/yyyy placeholder. This is cosmetic: the chart stays live until another
// day is actually picked, and "Now" resets the field back here.
function todayInputValue() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// ---------------------------------------------------------------- language

const t = (key, params) => (params ? format(lookup(state.dict, key), params) : lookup(state.dict, key));
const locale = () => state.dict?.locale || 'en-GB';
const phaseLabel = (phase) => state.dict?.phases?.[phase.name] ?? phase.name;
const planetLabel = (key, fallback) => state.dict?.planets?.[key] ?? fallback;

function compass(az) {
    const points = state.dict?.compass ?? COMPASS;
    return points[Math.round(az / 22.5) % 16];
}

// The place chip is written from state, not data-i18n, because the map picker
// can replace it; a language switch re-renders whichever variant is showing.
function updatePlateChips() {
    if (state.placeKey === 'picked') {
        const cardinals = state.dict?.sky?.cardinals ?? ['N', 'S', 'E', 'W'];
        $('platePlace').textContent = state.placeName || t('plate.yourSky');
        $('plateCoords').textContent = formatCoords(state.lat, state.lon, cardinals);
    } else {
        $('platePlace').textContent = t('plate.place');
        $('plateCoords').textContent = t('plate.coords');
    }
}

async function setLanguage(lang, { save = false } = {}) {
    state.dict = await loadDictionary(lang);
    state.lang = lang;
    if (save) {
        try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* private mode: the choice just won't stick */ }
    }
    document.documentElement.lang = lang;
    document.title = t('meta.title');
    document.querySelector('meta[name="description"]')?.setAttribute('content', t('meta.description'));
    applyTranslations(state.dict);
    $('langSelect').value = lang;
    updatePlateChips();
    state.almanacKey = ''; // ledger wording changed: force the daily sweep to re-render
    clearHover();
    refresh();
}

// ------------------------------------------------------------------ drawing

function redraw() {
    const size = canvas.clientWidth;
    if (!size) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(size * dpr)) {
        canvas.width = Math.round(size * dpr);
        canvas.height = Math.round(size * dpr);
    }
    // fold the pinch viewport into the device-pixel transform, so every draw in
    // render.js lands zoomed/panned without any of its math having to know
    const s = state.zoom * dpr;
    ctx.setTransform(s, 0, 0, s, state.panX * dpr, state.panY * dpr);

    const result = drawSky(ctx, {
        size,
        date: displayedDate(),
        lat: state.lat,
        lon: state.lon,
        stars: state.stars,
        constellations: state.constellations,
        showLines: state.showLines,
        showLabels: state.showLabels,
        showGraticule: state.showGraticule,
        hover: state.hover,
        labels: {
            moon: state.dict?.sky?.moon,
            cardinals: state.dict?.sky?.cardinals,
            planets: state.dict?.planets,
        },
    });
    state.objects = result.objects;
}

function resizeCanvas() {
    canvas.style.height = `${canvas.clientWidth}px`;
    // a rotate/resize changes how far the dome may pan; pull it back in bounds
    const clamped = clampPan(state, canvas.clientWidth);
    state.panX = clamped.panX;
    state.panY = clamped.panY;
    redraw();
}

// -------------------------------------------------------------------- clock

function updateClock() {
    if (!state.dict) return; // no dictionary yet: the placeholder dashes stay
    const date = displayedDate();
    $('plateClock').textContent = date.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $('plateDate').textContent = fmtDate(date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    $('liveDot').classList.toggle('is-paused', !isLive());
    $('offsetLabel').textContent = offsetText();
}

function offsetText() {
    if (isLive()) return t('controls.live');
    const m = state.offsetMin;
    const sign = m < 0 ? '−' : '+';
    const abs = Math.abs(m);
    const parts = `${sign}${Math.floor(abs / 60)} h ${String(abs % 60).padStart(2, '0')} m`;
    return state.anchor ? `${parts} · ${t('controls.pinned')}` : parts;
}

// ------------------------------------------------------------------ almanac

const fmtTime = (d) => d
    ? d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
    : '–';

// Intl inconsistently puts a comma after the short weekday depending on
// locale and options (sl-SI always does, en-GB only when year is present),
// so strip it to keep "Sat 11 Jul" / "sob. 11. jul." matching across langs.
const fmtDate = (d, opts) => d.toLocaleDateString(locale(), opts).replace(/,/g, '');

function sunAltAt(date) {
    const jd = julianDay(date);
    const sun = sunPosition(schlyterD(jd));
    return raDecToAltAz(sun.ra, sun.dec, lst(jd, state.lon), state.lat).alt;
}

function moonAltAt(date) {
    const jd = julianDay(date);
    const moon = moonPosition(schlyterD(jd));
    const h = raDecToAltAz(moon.ra, moon.dec, lst(jd, state.lon), state.lat);
    return moonTopocentricAlt(h.alt, moon.rEarthRadii);
}

function updateAlmanac() {
    if (!state.dict) return; // the ledger needs words before it needs numbers
    const date = displayedDate();
    const key = `${date.toDateString()}|${state.lat.toFixed(2)}|${state.lon.toFixed(2)}`;
    const phase = moonPhase(schlyterD(julianDay(date)));

    // rise/set sweeps only change with the local day or the observer
    if (key !== state.almanacKey) {
        state.almanacKey = key;
        const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());

        const sun = riseSet(sunAltAt, dayStart);
        const night = riseSet(sunAltAt, dayStart, -18);
        const moon = riseSet(moonAltAt, dayStart);

        $('sunriseVal').textContent = sun.alwaysDown ? t('ledger.notToday') : fmtTime(sun.rise);
        $('sunsetVal').textContent = sun.alwaysUp ? t('ledger.notToday') : fmtTime(sun.set);
        $('nightStartVal').textContent = night.set ? fmtTime(night.set) : t('ledger.noTrueNight');
        $('moonriseVal').textContent = moon.alwaysUp ? t('ledger.allDay') : fmtTime(moon.rise);
        $('moonsetVal').textContent = moon.alwaysDown ? t('ledger.belowAllDay') : fmtTime(moon.set);
        $('ledgerDate').textContent = fmtDate(date, { weekday: 'short', day: 'numeric', month: 'short' });
    }

    $('phaseVal').textContent = phaseLabel(phase);
    $('illumVal').textContent = `${Math.round(phase.illumination * 100)} %`;
    drawMoonIcon(phase);

    // the wanderers, right now
    const jd = julianDay(date);
    const lstDeg = lst(jd, state.lon);
    const rows = planetPositions(schlyterD(jd)).map((p) => {
        const h = raDecToAltAz(p.ra, p.dec, lstDeg, state.lat);
        const dot = `<span class="planet-dot" style="background:${PLANET_STYLE[p.key].color}"></span>`;
        const value = h.alt > 1
            ? `${t('ledger.planetUp', { alt: Math.round(h.alt) })} <span class="dir">${compass(h.az)}</span>`
            : `<span class="dir">${t('ledger.belowHorizon')}</span>`;
        return `<div class="record-row"><dt>${dot}${planetLabel(p.key, p.name)}</dt><span class="leader"></span><dd>${value}</dd></div>`;
    });
    $('planetRows').innerHTML = rows.join('');
}

function drawMoonIcon(phase) {
    const icon = $('moonIcon');
    const ictx = icon.getContext('2d');
    const r = 9;
    const cx = 11;
    ictx.clearRect(0, 0, 22, 22);
    ictx.save();
    ictx.translate(cx, cx);
    // northern-hemisphere habit: a waxing moon is lit on the right
    if (!phase.waxing) ictx.scale(-1, 1);
    ictx.fillStyle = 'rgba(231, 234, 248, 0.16)';
    ictx.beginPath();
    ictx.arc(0, 0, r, 0, Math.PI * 2);
    ictx.fill();
    ictx.fillStyle = '#e9c98f';
    ictx.beginPath();
    ictx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
    ictx.ellipse(0, 0, Math.abs(2 * phase.illumination - 1) * r, r, 0, Math.PI / 2, Math.PI * 1.5, phase.illumination < 0.5);
    ictx.fill();
    ictx.restore();
}

// ------------------------------------------------------------------ tooltip

function tooltipHtml(obj) {
    const line = (name, sub) => `<div class="t-name">${name}</div><div class="t-sub">${sub}</div>`;
    if (obj.type === 'star') {
        const s = obj.data;
        return line(s.name || t('tooltip.unnamedStar'), t('tooltip.starSub', { mag: s.mag.toFixed(1) }) + (s.con ? ` · ${s.con}` : ''));
    }
    if (obj.type === 'planet') {
        const name = planetLabel(obj.data.key, obj.data.name);
        return line(name, t('tooltip.wandererSub', { alt: Math.round(obj.data.alt), dir: compass(obj.data.az) }));
    }
    if (obj.type === 'moon') {
        return line(t('tooltip.moon'), t('tooltip.moonSub', { phase: phaseLabel(obj.data), pct: Math.round(obj.data.illumination * 100) }));
    }
    return line(t('tooltip.sun'), t('tooltip.sunSub', { alt: obj.data.alt.toFixed(1) }));
}

const touchScreen = window.matchMedia('(hover: none)').matches;
let tooltipTimer = null;

function handlePointer(event) {
    const rect = canvas.getBoundingClientRect();
    // objects live in world space; undo the pinch viewport to hit-test them
    const { x, y } = screenToWorld(state, event.clientX - rect.left, event.clientY - rect.top);
    let best = null;
    let bestDist = (touchScreen ? 24 : 16) / state.zoom; // fingers are blunter than cursors
    for (const obj of state.objects) {
        const dist = Math.hypot(obj.x - x, obj.y - y) - obj.hitR;
        if (dist < bestDist) { bestDist = dist; best = obj; }
    }
    if (best !== state.hover) {
        state.hover = best;
        redraw();
    }
    if (best) {
        tooltip.innerHTML = tooltipHtml(best);
        tooltip.classList.remove('hidden');
        const plate = canvas.parentElement.getBoundingClientRect();
        const px = event.clientX - plate.left;
        const py = event.clientY - plate.top;
        tooltip.style.left = `${Math.min(px + 14, plate.width - 150)}px`;
        tooltip.style.top = `${Math.max(py - 40, 6)}px`;
        // no mouseleave on a touchscreen: let a tapped tooltip fade on its own
        if (touchScreen) {
            clearTimeout(tooltipTimer);
            tooltipTimer = setTimeout(() => { clearHover(); redraw(); }, 4000);
        }
    } else {
        tooltip.classList.add('hidden');
    }
}

// ----------------------------------------------------------------- controls

function refresh({ almanac = true } = {}) {
    updateClock();
    redraw();
    if (almanac) updateAlmanac();
}

// a time jump invalidates whatever the pointer was resting on
function clearHover() {
    state.hover = null;
    tooltip.classList.add('hidden');
}

$('timeSlider').addEventListener('input', (event) => {
    state.offsetMin = parseInt(event.target.value, 10) || 0;
    clearHover();
    refresh();
});

$('nowBtn').addEventListener('click', () => {
    state.anchor = null;
    state.offsetMin = 0;
    $('timeSlider').value = 0;
    $('dateInput').value = todayInputValue();
    clearHover();
    refresh();
});

$('dateInput').addEventListener('change', (event) => {
    const value = event.target.value;
    if (!value) { state.anchor = null; clearHover(); refresh(); return; }
    const [y, m, d] = value.split('-').map(Number);
    // pin the chart to a stargazing hour of that evening
    state.anchor = new Date(y, m - 1, d, 22, 0, 0);
    state.offsetMin = 0;
    $('timeSlider').value = 0;
    clearHover();
    refresh();
});

for (const btn of document.querySelectorAll('.chip-toggle')) {
    btn.addEventListener('click', () => {
        const opt = btn.dataset.opt;
        state[opt] = !state[opt];
        btn.classList.toggle('is-on', state[opt]);
        btn.setAttribute('aria-pressed', String(state[opt]));
        redraw();
    });
}

$('placeBtn').addEventListener('click', () => {
    openLocationPicker({
        lat: state.lat,
        lon: state.lon,
        cardinals: state.dict?.sky?.cardinals ?? ['N', 'S', 'E', 'W'],
        strings: {
            loading: t('location.loading'),
            mapFailed: t('location.mapFailed'),
            picking: t('location.picking'),
            locating: t('location.locating'),
            geoFailed: t('location.geoFailed'),
            geoUnavailable: t('location.geoUnavailable'),
            searching: t('location.searching'),
            notFound: t('location.notFound'),
            searchFailed: t('location.searchFailed'),
        },
        onPick: ({ lat, lon, name }) => {
            state.lat = lat;
            state.lon = lon;
            state.placeKey = 'picked';
            state.placeName = name || null;
            updatePlateChips();
            refresh();
        },
    });
});

$('langSelect').addEventListener('change', (event) => {
    setLanguage(event.target.value, { save: true })
        .catch(() => { $('langSelect').value = state.lang; }); // dictionary fetch failed: stay put
});

function showError(message) {
    const el = $('errorMsg');
    el.textContent = message;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 6000);
}

canvas.addEventListener('mousemove', handlePointer);
canvas.addEventListener('mouseleave', () => {
    state.hover = null;
    tooltip.classList.add('hidden');
    redraw();
});

// ---------------------------------------------------------- pinch to zoom
// Touch only: two fingers scale the dome about their midpoint, one finger
// drags it once zoomed in. The pure viewport math lives in zoom.js; here we
// only translate raw touch points into calls to it.

// Own every gesture while zoomed (pan + pinch); at rest let a one-finger drag
// scroll the page but keep two-finger pinch for ourselves.
function syncTouchAction() {
    canvas.style.touchAction = state.zoom > 1 ? 'none' : 'pan-y';
}

function applyView(view) {
    const clamped = clampPan({ ...view, zoom: clampZoom(view.zoom) }, canvas.clientWidth);
    state.zoom = clamped.zoom;
    state.panX = clamped.panX;
    state.panY = clamped.panY;
    syncTouchAction();
    redraw();
}

const localPoint = (touch, rect) => ({ x: touch.clientX - rect.left, y: touch.clientY - rect.top });
const touchSpread = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
const touchMidpoint = (a, b, rect) => ({
    x: (a.clientX + b.clientX) / 2 - rect.left,
    y: (a.clientY + b.clientY) / 2 - rect.top,
});

let pinch = null;         // { spread, x, y } of the last two-finger frame
let panFrom = null;       // last one-finger point while dragging a zoomed dome
let gestureMoved = false; // suppress the tap a pinch/pan would otherwise fire

canvas.addEventListener('touchstart', (event) => {
    const rect = canvas.getBoundingClientRect();
    if (event.touches.length === 1) {
        gestureMoved = false; // a fresh finger: assume a tap until it slides
        panFrom = state.zoom > 1 ? localPoint(event.touches[0], rect) : null;
    } else if (event.touches.length === 2) {
        const m = touchMidpoint(event.touches[0], event.touches[1], rect);
        pinch = { spread: touchSpread(event.touches[0], event.touches[1]), x: m.x, y: m.y };
        panFrom = null;
        clearHover();
        redraw();
    }
}, { passive: true });

canvas.addEventListener('touchmove', (event) => {
    const rect = canvas.getBoundingClientRect();
    if (pinch && event.touches.length >= 2) {
        event.preventDefault();
        const spread = touchSpread(event.touches[0], event.touches[1]);
        const m = touchMidpoint(event.touches[0], event.touches[1], rect);
        // scale about the old midpoint, then slide with the midpoint's drift
        const view = zoomAt(state, pinch.x, pinch.y, spread / pinch.spread);
        view.panX += m.x - pinch.x;
        view.panY += m.y - pinch.y;
        applyView(view);
        pinch = { spread, x: m.x, y: m.y };
        gestureMoved = true;
    } else if (panFrom && event.touches.length === 1 && state.zoom > 1) {
        event.preventDefault();
        const p = localPoint(event.touches[0], rect);
        applyView({ zoom: state.zoom, panX: state.panX + (p.x - panFrom.x), panY: state.panY + (p.y - panFrom.y) });
        panFrom = p;
        gestureMoved = true;
    }
}, { passive: false });

canvas.addEventListener('touchend', (event) => {
    if (event.touches.length < 2) pinch = null;
    if (event.touches.length === 0) panFrom = null;
});

// a moved gesture ends with a synthetic click; don't identify a random object
canvas.addEventListener('click', (event) => {
    if (gestureMoved) { gestureMoved = false; return; }
    handlePointer(event);
});

syncTouchAction();

// -------------------------------------------------------------------- boot

async function loadCatalogs() {
    const [starsRes, consRes] = await Promise.all([
        fetch('stars.json'),
        fetch('constellations.json'),
    ]);
    if (!starsRes.ok || !consRes.ok) throw new Error('catalog fetch failed');
    state.stars = parseStars(await starsRes.json());
    state.constellations = (await consRes.json()).constellations;
}

loadCatalogs()
    .then(() => refresh())
    .catch(() => showError(t('errors.catalog')));

let savedLang = null;
try { savedLang = localStorage.getItem(STORAGE_KEY); } catch { /* private mode */ }
const systemLanguages = navigator.languages?.length ? [...navigator.languages] : [navigator.language];
console.info('[nebo] system language:', systemLanguages.join(', '));
setLanguage(pickLanguage(savedLang, systemLanguages)).catch(() => {
    // chosen dictionary unreachable: fall back to English; if even that fails
    // the chart still draws, only the labels stay blank
    setLanguage(FALLBACK).catch(() => {});
});

$('dateInput').value = todayInputValue(); // show today rather than an empty field
new ResizeObserver(resizeCanvas).observe(canvas);
resizeCanvas();
updateClock();

// second hand for the chip; the dome itself only needs a slow tick
setInterval(updateClock, 1000);
setInterval(() => {
    if (isLive()) refresh();
}, 60000);

// canvas labels use Space Mono; redraw once fonts arrive
if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(redraw);
}
