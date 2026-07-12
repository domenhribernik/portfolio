// Location-picker modal for Nebo. Lazily pulls in Leaflet (CDN) the first time
// it opens, drops a dark OpenStreetMap/CARTO map into the dialog, and lets you
// choose a spot three ways: drag the map under a fixed centre pin, search a
// place name, or use device GPS. On confirm it hands the chosen lat/lon (and a
// reverse-geocoded name, when one resolved) back to the caller, which re-points
// the star chart. All coordinate/parse maths lives in the pure geo.js.
import { clampLat, wrapLon, formatCoords, placeLabel, parseSearchResult } from './geo.js';

const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
const NOMINATIM = 'https://nominatim.openstreetmap.org';

const $ = (id) => document.getElementById(id);

let leafletPromise = null;
let map = null;
let L = null;
let wired = false;
let session = null;    // { cardinals, strings, onPick } for the current opening
let currentName = null; // latest reverse-geocoded label for the pin, or null
let reverseTimer = null;
let lastFocus = null;

// ---- lazy Leaflet ---------------------------------------------------------

function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise((resolve, reject) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = LEAFLET_CSS;
        document.head.appendChild(link);
        const script = document.createElement('script');
        script.src = LEAFLET_JS;
        script.onload = () => (window.L ? resolve(window.L) : reject(new Error('leaflet missing')));
        script.onerror = () => reject(new Error('leaflet load failed'));
        document.head.appendChild(script);
    });
    return leafletPromise;
}

// ---- OpenStreetMap / Nominatim -------------------------------------------

async function reverseGeocode(lat, lon) {
    const url = `${NOMINATIM}/reverse?format=jsonv2&zoom=10&addressdetails=1&lat=${lat}&lon=${lon}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`reverse ${res.status}`);
    return res.json();
}

async function searchPlace(query) {
    const url = `${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`search ${res.status}`);
    return parseSearchResult(await res.json());
}

// ---- small view helpers ---------------------------------------------------

function setStatus(message) {
    const el = $('locStatus');
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
}

function setReadout(lat, lon) {
    const coords = formatCoords(clampLat(lat), wrapLon(lon), session.cardinals);
    $('locReadout').textContent = currentName ? `${currentName} · ${coords}` : coords;
}

// Name the pin's resting spot a beat after it settles, so a drag doesn't fire
// a request per frame. The name is a nicety: failure just leaves the coords.
function scheduleReverse(lat, lon) {
    clearTimeout(reverseTimer);
    setStatus(session.strings.picking);
    reverseTimer = setTimeout(async () => {
        try {
            const result = await reverseGeocode(clampLat(lat), wrapLon(lon));
            currentName = placeLabel(result, null);
            const c = map.getCenter();
            setReadout(c.lat, c.lng);
        } catch { /* keep the coords-only readout */ }
        setStatus('');
    }, 550);
}

function ensureMap(lat, lon) {
    if (map) return;
    map = L.map('locMap', { worldCopyJump: true, zoomControl: true }).setView([lat, lon], 8);
    L.tileLayer(TILE_URL, { maxZoom: 19, subdomains: 'abcd', attribution: TILE_ATTR }).addTo(map);
    map.on('move', () => {
        currentName = null; // the point moved: last name no longer applies
        const c = map.getCenter();
        setReadout(c.lat, c.lng);
    });
    map.on('moveend', () => {
        const c = map.getCenter();
        scheduleReverse(c.lat, c.lng);
    });
}

// ---- actions --------------------------------------------------------------

function closeModal() {
    $('locModal').classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
    clearTimeout(reverseTimer);
    setStatus('');
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
}

function commit() {
    if (!map) return;
    const c = map.getCenter();
    const pick = { lat: clampLat(c.lat), lon: wrapLon(c.lng), name: currentName };
    closeModal();
    session.onPick(pick);
}

function useMyLocation() {
    if (!navigator.geolocation) { setStatus(session.strings.geoUnavailable); return; }
    setStatus(session.strings.locating);
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            setStatus('');
            if (map) map.setView([clampLat(pos.coords.latitude), wrapLon(pos.coords.longitude)], 10);
        },
        () => setStatus(session.strings.geoFailed),
        { enableHighAccuracy: true, timeout: 10000 },
    );
}

async function onSearch(event) {
    event.preventDefault();
    const query = $('locSearchInput').value.trim();
    if (!query || !map) return;
    setStatus(session.strings.searching);
    try {
        const hit = await searchPlace(query);
        if (!hit) { setStatus(session.strings.notFound); return; }
        setStatus('');
        map.setView([clampLat(hit.lat), wrapLon(hit.lon)], 10);
    } catch {
        setStatus(session.strings.searchFailed);
    }
}

function wireOnce() {
    if (wired) return;
    wired = true;
    $('locClose').addEventListener('click', closeModal);
    $('locConfirm').addEventListener('click', commit);
    $('locMine').addEventListener('click', useMyLocation);
    $('locSearchForm').addEventListener('submit', onSearch);
    $('locModal').addEventListener('click', (event) => {
        if (event.target === $('locModal')) closeModal(); // backdrop, not the card
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !$('locModal').classList.contains('hidden')) closeModal();
    });
}

// ---- public ---------------------------------------------------------------

export async function openLocationPicker({ lat, lon, cardinals, strings, onPick }) {
    session = { cardinals, strings, onPick };
    currentName = null;
    wireOnce();
    lastFocus = document.activeElement;

    $('locModal').classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
    setStatus(strings.loading);

    try {
        L = await loadLeaflet();
    } catch {
        setStatus(strings.mapFailed);
        return;
    }
    setStatus('');

    ensureMap(lat, lon);
    map.invalidateSize();                       // container was hidden at creation
    map.setView([clampLat(lat), wrapLon(lon)], Math.max(map.getZoom(), 8));
    setReadout(lat, lon);
    scheduleReverse(lat, lon);
    $('locSearchInput').focus();
}
