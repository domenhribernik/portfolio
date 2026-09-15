/**
 * DOM-free logic for views/tanken, unit-tested by tests/tanken-logic.test.mjs
 * (node --test tests/). The page's script.js imports this as an ES module.
 *
 * `now` is injected wherever the clock matters, so "updated 4 minutes ago"
 * is deterministic under test; in the browser it defaults to the real clock.
 *
 * The three API ceilings below are also declared in app/services/tanken-service.php.
 * They exist in both languages because the page must not offer a radius the
 * server would clamp, and the test suite greps the PHP so the two cannot drift.
 */

export const MAX_RADIUS_KM = 25;
export const MAX_IDS_PER_REQUEST = 10;
export const MIN_CALL_INTERVAL = 60;

export const FUELS = ['e5', 'e10', 'diesel'];
export const FUEL_LABELS = { e5: 'Super E5', e10: 'Super E10', diesel: 'Diesel' };
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const WEEKDAY_LABELS = {
    mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
    fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};

const EARTH_KM = 6371.0088;
const RAD = Math.PI / 180;

/** Great-circle distance in km. Same implementation as views/trails/logic.js. */
export function haversineKm(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * RAD;
    const p2 = lat2 * RAD;
    const dp = (lat2 - lat1) * RAD;
    const dl = (lon2 - lon1) * RAD;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function clampRadius(km) {
    if (!Number.isFinite(km) || km <= 0) return 5;
    return Math.min(km, MAX_RADIUS_KM);
}

/**
 * German pump prices are quoted to a tenth of a cent and written with a
 * decimal comma: 1,789 €. Rendering 1.79 would be a different, wrong number.
 */
export function formatPrice(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    return value.toFixed(3).replace('.', ',') + ' €';
}

export function formatKm(km) {
    if (typeof km !== 'number' || !Number.isFinite(km)) return '';
    if (km < 1) return `${Math.round(km * 1000)} m`;
    return `${km.toFixed(1).replace('.', ',')} km`;
}

/** The price entry for one fuel, or null when the station never reported it. */
export function priceOf(station, fuel) {
    const entry = station && station.prices ? station.prices[fuel] : null;
    if (!entry || typeof entry.price !== 'number') return null;
    return entry;
}

/**
 * Stations ordered by the chosen fuel, cheapest first.
 *
 * Three bands, in this order: open stations with a price, then closed ones
 * still showing their last price, then anything with no price at all. Within
 * a band it is price, then distance, then id so the order is stable across
 * reloads.
 *
 * The bands matter because a closed station is not an offer. Sorting purely
 * on price would put a shut forecourt at the top of the list while the
 * headline named a different station as the cheapest, which reads as a bug
 * and sends people to a locked pump.
 *
 * Nothing is ever REMOVED, though: MTS-K's terms forbid narrowing results in
 * ways the user did not ask for, so a closed station and one that does not
 * sell E10 both still appear, just below the places you can actually buy.
 */
function band(entry) {
    if (!entry) return 2;
    return entry.status === 'open' ? 0 : 1;
}

export function sortByPrice(stations, fuel) {
    return [...(stations || [])].sort((a, b) => {
        const pa = priceOf(a, fuel);
        const pb = priceOf(b, fuel);
        const ba = band(pa);
        const bb = band(pb);
        if (ba !== bb) return ba - bb;
        if (pa && pb && pa.price !== pb.price) return pa.price - pb.price;
        if (a.dist !== b.dist) return (a.dist ?? 0) - (b.dist ?? 0);
        return String(a.id).localeCompare(String(b.id));
    });
}

/** The cheapest currently-open price across the set, for the headline. */
export function bestPrice(stations, fuel) {
    let best = null;
    for (const station of stations || []) {
        const entry = priceOf(station, fuel);
        if (!entry || entry.status !== 'open') continue;
        if (best === null || entry.price < best.price) best = { price: entry.price, station };
    }
    return best;
}

/**
 * How old a reading is, in words. A poll that failed leaves the old value in
 * place, so this is what stops the page implying the number is live.
 */
export function relativeAge(observedAt, now = new Date()) {
    if (!observedAt) return 'never';
    const then = new Date(observedAt);
    if (Number.isNaN(then.getTime())) return 'never';
    const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);
    if (seconds < 0) return 'just now';
    if (seconds < 90) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.floor(hours / 24);
    return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** The newest observation in the set, which is what the page stamps on itself. */
export function freshestObservation(stations, fuel) {
    let newest = null;
    for (const station of stations || []) {
        const entry = station && station.prices ? station.prices[fuel] : null;
        if (!entry || !entry.observedAt) continue;
        if (newest === null || entry.observedAt > newest) newest = entry.observedAt;
    }
    return newest;
}

// ---------------------------------------------------------------------------
//  Statistics (views/tanken/hourly-stats.json, built by tools/tanken/build.py)
// ---------------------------------------------------------------------------

export function hasStats(stats) {
    return !!(stats && stats.window && stats.window.days > 0);
}

/**
 * The daily curve for one fuel as [{hour, value}], either averaged over the
 * week or for a single weekday. Hours with no data are dropped rather than
 * drawn as zero, which would invent a reading.
 */
export function curveSeries(stats, fuel, weekday = null) {
    if (!hasStats(stats)) return [];
    const source = weekday === null
        ? (stats.byHour || {})[fuel]
        : ((stats.byHourWeekday || {})[fuel] || [])[WEEKDAYS.indexOf(weekday)];
    if (!Array.isArray(source)) return [];
    return source
        .map((value, hour) => ({ hour, value }))
        .filter((point) => typeof point.value === 'number');
}

/** The cheapest hour of the day for a fuel, or null when unknown. */
export function cheapestHour(stats, fuel, weekday = null) {
    const series = curveSeries(stats, fuel, weekday);
    if (!series.length) return null;
    return series.reduce((best, point) => (point.value < best.value ? point : best)).hour;
}

export function dearestHour(stats, fuel, weekday = null) {
    const series = curveSeries(stats, fuel, weekday);
    if (!series.length) return null;
    return series.reduce((best, point) => (point.value > best.value ? point : best)).hour;
}

export function formatHour(hour) {
    if (typeof hour !== 'number' || !Number.isFinite(hour)) return '—';
    return `${String(hour).padStart(2, '0')}:00`;
}

/** A deviation in euros as a signed cent figure, which is how a driver reads it. */
export function formatCents(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    const cents = value * 100;
    const sign = cents > 0 ? '+' : cents < 0 ? '−' : '±';
    return `${sign}${Math.abs(cents).toFixed(1).replace('.', ',')} ct`;
}

/** How much a driver saves by filling at the cheapest hour instead of the dearest. */
export function dailySwing(stats, fuel, weekday = null) {
    const series = curveSeries(stats, fuel, weekday);
    if (series.length < 2) return null;
    const values = series.map((point) => point.value);
    return Math.max(...values) - Math.min(...values);
}

// ---------------------------------------------------------------------------
//  Chart geometry (ported from views/stocks/logic.js)
// ---------------------------------------------------------------------------

const round2 = (n) => Math.round(n * 100) / 100;

/** Round axis ticks covering [min, max] in roughly `count` steps. */
export function niceTicks(min, max, count = 5) {
    if (min === max) { min -= 1; max += 1; }
    const rawStep = (max - min) / count;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const candidates = [1, 2, 2.5, 5, 10];
    const step = candidates.find((c) => c * magnitude >= rawStep) * magnitude;
    const start = Math.floor(min / step) * step;
    const ticks = [];
    for (let v = start; v < max + step - 1e-9; v += step) {
        ticks.push(Math.round(v * 1e6) / 1e6);
    }
    return ticks;
}

/**
 * Scale [{hour, value}] into an SVG path inside a plot box. X is proportional
 * to the hour, so a gap in the data leaves a gap in the line rather than
 * squeezing the rest of the day across it.
 */
export function curveToPath(series, { width, height, min, max }) {
    if (!series || series.length < 2) return '';
    const ySpan = max - min || 1;
    return 'M' + series.map((point) => {
        const x = (point.hour / 23) * width;
        const y = (1 - (point.value - min) / ySpan) * height;
        return `${round2(x)},${round2(y)}`;
    }).join('L');
}

/** A padded y-domain for the curve, symmetric about zero so the baseline reads. */
export function curveDomain(series) {
    if (!series || !series.length) return { min: -0.05, max: 0.05 };
    const values = series.map((p) => p.value);
    const extent = Math.max(Math.abs(Math.min(...values)), Math.abs(Math.max(...values)));
    const padded = extent * 1.2 || 0.05;
    return { min: -padded, max: padded };
}
