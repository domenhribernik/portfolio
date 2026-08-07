// DOM-free logic for the Trails flight recorder (views/trails). Everything
// here is pure and tested by tests/trails-logic.test.mjs; script.js, map.js
// and sync.js only wire these functions to the DOM, Leaflet and the
// controller. Units are metric throughout: metres, metres per second,
// kilometres, milliseconds.

const DASH = '–';

const pad2 = (n) => String(n).padStart(2, '0');

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Whole number with thousands grouped past ten thousand. The separator is a
 * no-break space (U+00A0) so a readout never wraps away from its unit.
 */
function fmtInt(n) {
    const whole = String(Math.round(Math.abs(n)));
    const grouped = whole.length > 4 ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : whole;
    return (n < 0 ? '-' : '') + grouped;
}

/** A duration in ms as m:ss, or h:mm:ss once it passes an hour. */
export function formatDuration(ms) {
    if (!isNum(ms) || ms < 0) return DASH;
    const total = Math.floor(ms / 1000);
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/**
 * A distance in metres, in the unit that suits its size: metres below a
 * kilometre, one decimal up to 100 km, whole kilometres beyond.
 */
export function formatKm(m) {
    if (!isNum(m)) return DASH;
    if (Math.abs(m) < 1000) return `${Math.round(m)} m`;
    const km = m / 1000;
    return Math.abs(km) < 100 ? `${km.toFixed(1)} km` : `${fmtInt(km)} km`;
}

/** Ground speed from metres per second to whole km/h. */
export function formatSpeed(mps) {
    if (!isNum(mps)) return DASH;
    return `${fmtInt(mps * 3.6)} km/h`;
}

/** Altitude in whole metres. */
export function formatAlt(m) {
    if (!isNum(m)) return DASH;
    return `${fmtInt(m)} m`;
}

/** An epoch or ISO instant as a local Date, or null when it isn't one. */
function toDate(value) {
    if (value === null || value === undefined || value === '') return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** An instant as dd.mm.yyyy in local time, the site's day-first convention. */
export function formatDateDmy(value) {
    const d = toDate(value);
    if (!d) return DASH;
    return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** An instant as a 24-hour local wall clock, hh:mm. */
export function formatClock(value) {
    const d = toDate(value);
    if (!d) return DASH;
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Today as ISO yyyy-mm-dd in the viewer's own timezone. Slicing a UTC ISO
 * string instead would name yesterday for the first hours of every CEST
 * morning, exactly when a red-eye lands.
 */
export function todayIso(now = new Date()) {
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

// --- great-circle geometry -------------------------------------------------

const EARTH_KM = 6371.0088; // mean radius; the flight is not precise enough to care
const RAD = Math.PI / 180;

/** Great-circle distance between two positions, in kilometres. */
export function haversineKm(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * RAD;
    const p2 = lat2 * RAD;
    const dp = (lat2 - lat1) * RAD;
    const dl = (lon2 - lon1) * RAD;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial great-circle bearing from one position to another, 0-360 clockwise from north. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * RAD;
    const p2 = lat2 * RAD;
    const dl = (lon2 - lon1) * RAD;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) / RAD + 360) % 360;
}

const ROSE = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** A bearing as a sixteen-point compass name. */
export function compassPoint(deg) {
    if (!isNum(deg)) return DASH;
    const norm = ((deg % 360) + 360) % 360;
    return ROSE[Math.round(norm / 22.5) % 16];
}

/**
 * How far the horizon is from a given altitude, in kilometres.
 *
 * The standard 3.57*sqrt(h) approximation, which already folds in the usual
 * atmospheric refraction. This is the whole "what can I see out of the
 * window" model: anything inside this radius is over the horizon, anything
 * outside is behind the curve of the Earth.
 */
export function horizonKm(altM) {
    if (!isNum(altM) || altM <= 0) return 0;
    return 3.57 * Math.sqrt(altM);
}

/**
 * Ground speed in m/s inferred from two consecutive fixes. Phones very often
 * report coords.speed as null, so the track's own geometry is the fallback.
 */
export function deriveSpeedMps(prev, fix) {
    if (!prev || !fix) return null;
    const dt = fix.t - prev.t;
    if (!isNum(dt) || dt <= 0) return null;
    return (haversineKm(prev.lat, prev.lon, fix.lat, fix.lon) * 1000) / (dt / 1000);
}

// --- recording -------------------------------------------------------------

/**
 * Silence beyond which the track is considered broken, not flown.
 *
 * Must stay comfortably above `acceptFix`'s `idleMs` heartbeat: that heartbeat
 * deliberately stores a fix once a minute while the aircraft sits still, and a
 * lower threshold here would draw every one of those as a break in recording.
 * A real break (a backgrounded tab, a receiver that lost lock) lasts minutes,
 * so 90 s separates the two cleanly.
 */
export const GAP_MS = 90_000;

/**
 * Whether a new fix earns a place in the track.
 *
 * Three gates, in order. An error circle wider than `maxAccM` is discarded
 * outright: a 500 m fix would draw the track through the wrong valley. Then a
 * hard time throttle, so a chatty receiver cannot fill the database with a
 * fix per second. Then either real movement or a once-a-minute heartbeat, so
 * a taxi hold records a few honest points instead of looking like lost signal
 * while GPS jitter alone never registers as flying.
 */
export function acceptFix(prev, fix, options = {}) {
    const { minMs = 3000, minM = 15, maxAccM = 100, idleMs = 60_000 } = options;
    if (!fix || !isNum(fix.lat) || !isNum(fix.lon)) return false;
    if (isNum(fix.acc) && fix.acc > maxAccM) return false;
    if (!prev) return true;

    const dt = fix.t - prev.t;
    if (!isNum(dt) || dt < minMs) return false;
    if (dt >= idleMs) return true;
    return haversineKm(prev.lat, prev.lon, fix.lat, fix.lon) * 1000 >= minM;
}

/** Whether the step from `prev` to `p` is a break in the recording. */
function isGap(prev, p, maxGapMs) {
    return p.gap === true || p.t - prev.t > maxGapMs;
}

/**
 * Split a track at every break in recording.
 *
 * Returns solid `segments` to draw as lines and `gaps` as [before, after]
 * pairs to draw dashed: the aircraft flew that leg, the phone just was not
 * listening. A fix the recorder itself flagged `gap` (a watch restarted after
 * the tab was backgrounded) breaks the track no matter how close the clocks.
 */
export function gapSegments(points, maxGapMs = GAP_MS) {
    if (!Array.isArray(points) || points.length === 0) return { segments: [], gaps: [] };
    const segments = [[points[0]]];
    const gaps = [];
    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const p = points[i];
        if (isGap(prev, p, maxGapMs)) {
            gaps.push([prev, p]);
            segments.push([p]);
        } else {
            segments[segments.length - 1].push(p);
        }
    }
    return { segments, gaps };
}

/**
 * Fold a track into the numbers the flight is summarised by.
 *
 * Distance spans gaps on purpose: the aircraft covered that ground whether or
 * not the phone was awake, and a straight line is the best estimate of it.
 * Speed does not: a leg with no fixes has no knowable speed, so those legs are
 * skipped rather than turned into a fictional record. `avgSpeedKmh` is
 * wall-clock, the intuitive "how fast was the trip", while `movingMs` and
 * `gapMs` report how much of it was actually recorded.
 */
export function flightStats(points, maxGapMs = GAP_MS) {
    const empty = {
        pointCount: 0, startedAt: null, endedAt: null,
        durationMs: 0, movingMs: 0, gapMs: 0, gapCount: 0,
        distanceKm: 0, maxSpeedKmh: 0, avgSpeedKmh: 0,
        maxAltM: null, minAltM: null,
    };
    if (!Array.isArray(points) || points.length === 0) return empty;

    let distanceKm = 0;
    let gapMs = 0;
    let gapCount = 0;
    let maxSpeedMps = 0;
    let maxAltM = null;
    let minAltM = null;

    const noteAlt = (p) => {
        if (!isNum(p.alt)) return;
        maxAltM = maxAltM === null ? p.alt : Math.max(maxAltM, p.alt);
        minAltM = minAltM === null ? p.alt : Math.min(minAltM, p.alt);
    };
    const noteSpeed = (v) => {
        if (isNum(v) && v > maxSpeedMps) maxSpeedMps = v;
    };

    noteAlt(points[0]);
    noteSpeed(points[0].spd);

    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const p = points[i];
        distanceKm += haversineKm(prev.lat, prev.lon, p.lat, p.lon);
        noteAlt(p);
        if (isGap(prev, p, maxGapMs)) {
            gapCount++;
            gapMs += p.t - prev.t;
            noteSpeed(p.spd);
        } else {
            noteSpeed(isNum(p.spd) ? p.spd : deriveSpeedMps(prev, p));
        }
    }

    const startedAt = points[0].t;
    const endedAt = points[points.length - 1].t;
    const durationMs = Math.max(0, endedAt - startedAt);
    const hours = durationMs / 3_600_000;

    return {
        pointCount: points.length,
        startedAt,
        endedAt,
        durationMs,
        movingMs: Math.max(0, durationMs - gapMs),
        gapMs,
        gapCount,
        distanceKm,
        maxSpeedKmh: maxSpeedMps * 3.6,
        avgSpeedKmh: hours > 0 ? distanceKm / hours : 0,
        maxAltM,
        minAltM,
    };
}

// --- what is out of the window --------------------------------------------

/**
 * data/places.json into usable records.
 *
 * The file interns country names and stores rows as
 * [name, lat, lon, population, countryIndex, isCapital] purely to keep the
 * offline payload small; nothing outside this function should know that.
 */
export function inflatePlaces(data) {
    const rows = data && Array.isArray(data.places) ? data.places : [];
    const countries = data && Array.isArray(data.countries) ? data.countries : [];
    return rows.map((r) => ({
        name: r[0],
        lat: r[1],
        lon: r[2],
        pop: r[3],
        country: countries[r[4]] || '',
        capital: r[5] === 1,
    }));
}

/**
 * The places currently over the horizon, nearest first.
 *
 * Everything inside `horizonKm(altM)` is geometrically in view. That is
 * usually far too many names to read at a glance, so the list keeps the most
 * prominent ones by population, and always keeps the single nearest place
 * even when it is a small town: the thing directly under the wing is exactly
 * what someone looking out of the window is trying to name.
 */
export function visibleCities(lat, lon, altM, places, limit = 8) {
    const radiusKm = horizonKm(altM);
    if (radiusKm <= 0 || !Array.isArray(places)) return [];

    // Latitude alone bounds the search cheaply and without antimeridian care.
    const latPad = radiusKm / 110.6 + 0.05;
    const inSight = [];
    for (const p of places) {
        if (Math.abs(p.lat - lat) > latPad) continue;
        const distanceKm = haversineKm(lat, lon, p.lat, p.lon);
        if (distanceKm > radiusKm) continue;
        const bearing = bearingDeg(lat, lon, p.lat, p.lon);
        inSight.push({
            name: p.name, country: p.country, pop: p.pop, capital: p.capital,
            distanceKm, bearingDeg: bearing, compass: compassPoint(bearing),
        });
    }

    const byDistance = (a, b) => a.distanceKm - b.distanceKm;
    if (inSight.length <= limit) return inSight.sort(byDistance);

    const nearest = inSight.reduce((a, b) => (b.distanceKm < a.distanceKm ? b : a));
    const kept = new Set([nearest]);
    for (const c of [...inSight].sort((a, b) => b.pop - a.pop)) {
        if (kept.size >= limit) break;
        kept.add(c);
    }
    return [...kept].sort(byDistance);
}

// --- simplification for sync ----------------------------------------------

const EARTH_M = 6_371_008.8;

/** Local flat projection in metres, good enough over one track's span. */
function projector(lat0) {
    const k = Math.cos(lat0 * RAD) * RAD * EARTH_M;
    return (p) => ({ x: p.lon * k, y: p.lat * RAD * EARTH_M });
}

/** Perpendicular distance from point p to the line through a and b. */
function perpDist(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    return Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y)) / Math.sqrt(len2);
}

/** Douglas-Peucker over one unbroken run, returning the indices worth keeping. */
function douglasPeucker(xy, epsilonM) {
    const keep = new Array(xy.length).fill(false);
    keep[0] = true;
    keep[xy.length - 1] = true;
    // Iterative: a 12 000-fix track would blow the stack recursively.
    const stack = [[0, xy.length - 1]];
    while (stack.length) {
        const [lo, hi] = stack.pop();
        if (hi - lo < 2) continue;
        let worst = 0;
        let at = -1;
        for (let i = lo + 1; i < hi; i++) {
            const d = perpDist(xy[i], xy[lo], xy[hi]);
            if (d > worst) { worst = d; at = i; }
        }
        if (at !== -1 && worst > epsilonM) {
            keep[at] = true;
            stack.push([lo, at], [at, hi]);
        }
    }
    return keep;
}

/**
 * Thin a recorded track down to something worth syncing.
 *
 * A ten-hour flight is 8-12 000 fixes, almost all of them on a line the
 * previous two already described. Douglas-Peucker drops those and keeps every
 * turn wider than `epsilonM`. Each recording gap is simplified on its own, so
 * the two ends of a gap always survive and the track is never welded across
 * the part nobody recorded. `maxPoints` is a hard ceiling for the controller's
 * payload cap, applied by evenly thinning whatever survived.
 */
export function simplifyTrack(points, epsilonM = 25, maxPoints = 2000) {
    if (!Array.isArray(points) || points.length <= 2) return Array.isArray(points) ? [...points] : [];

    const project = projector(points[0].lat);
    const { segments } = gapSegments(points);
    const kept = [];
    for (const seg of segments) {
        if (seg.length <= 2) { kept.push(...seg); continue; }
        const flags = douglasPeucker(seg.map(project), epsilonM);
        for (let i = 0; i < seg.length; i++) if (flags[i]) kept.push(seg[i]);
    }
    if (kept.length <= maxPoints) return kept;

    // Still too many: keep every segment endpoint, then spread the remaining
    // budget evenly over the rest so the shape stays proportionate.
    const mandatory = new Set([0, kept.length - 1]);
    for (let i = 1; i < kept.length; i++) {
        if (isGap(kept[i - 1], kept[i], GAP_MS)) { mandatory.add(i - 1); mandatory.add(i); }
    }
    const budget = maxPoints - mandatory.size;
    if (budget <= 0) return [...mandatory].sort((a, b) => a - b).map((i) => kept[i]);

    const optional = [];
    for (let i = 0; i < kept.length; i++) if (!mandatory.has(i)) optional.push(i);
    const step = optional.length / budget;
    const chosen = new Set(mandatory);
    for (let i = 0; i < budget; i++) chosen.add(optional[Math.floor(i * step)]);
    return [...chosen].sort((a, b) => a - b).map((i) => kept[i]);
}

// --- the wire format ------------------------------------------------------

/** Version stamp on every synced payload, so an old flight stays readable. */
export const WIRE_VERSION = 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const round = (v, dp) => (isNum(v) ? Number(v.toFixed(dp)) : null);

/**
 * A flight and its track as the controller stores it.
 *
 * Columnar rather than an array of objects, because repeating the five keys
 * 2000 times is most of the payload. Time is seconds since the flight started
 * instead of a repeated 13-digit epoch, coordinates keep 5 decimals (about a
 * metre, far finer than the GPS behind them) and gaps travel as a short index
 * list rather than a boolean on every fix.
 */
export function serializeFlight(flight, points) {
    const track = Array.isArray(points) ? points : [];
    const base = track.length ? track[0].t : (flight.startedAt || 0);
    const gap = [];
    track.forEach((p, i) => { if (p.gap === true) gap.push(i); });

    return {
        v: WIRE_VERSION,
        uuid: flight.id,
        name: flight.name || '',
        startedAt: flight.startedAt ?? base,
        endedAt: flight.endedAt ?? null,
        updatedAt: flight.updatedAt ?? null,
        stats: flight.stats || flightStats(track),
        points: {
            base,
            t: track.map((p) => Math.round((p.t - base) / 1000)),
            lat: track.map((p) => round(p.lat, 5)),
            lon: track.map((p) => round(p.lon, 5)),
            alt: track.map((p) => round(p.alt, 0)),
            spd: track.map((p) => round(p.spd, 1)),
            gap,
        },
    };
}

/**
 * A wire payload back into a flight and its track, or null if it is junk.
 *
 * Sync drops unreadable flights silently rather than failing a whole upload,
 * so this never throws: a corrupted row from some old browser must not be able
 * to block every other flight from syncing.
 */
export function deserializeFlight(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.v !== WIRE_VERSION) return null;
    if (typeof payload.uuid !== 'string' || !UUID_RE.test(payload.uuid)) return null;

    const c = payload.points;
    if (!c || !Array.isArray(c.t) || !Array.isArray(c.lat) || !Array.isArray(c.lon)) return null;
    const n = c.t.length;
    if (c.lat.length !== n || c.lon.length !== n) return null;

    const base = isNum(c.base) ? c.base : (isNum(payload.startedAt) ? payload.startedAt : 0);
    const gaps = new Set(Array.isArray(c.gap) ? c.gap : []);
    const alt = Array.isArray(c.alt) ? c.alt : [];
    const spd = Array.isArray(c.spd) ? c.spd : [];

    const points = [];
    for (let i = 0; i < n; i++) {
        if (!isNum(c.lat[i]) || !isNum(c.lon[i]) || !isNum(c.t[i])) return null;
        points.push({
            t: base + c.t[i] * 1000,
            lat: c.lat[i],
            lon: c.lon[i],
            alt: isNum(alt[i]) ? alt[i] : null,
            spd: isNum(spd[i]) ? spd[i] : null,
            acc: null,
            gap: gaps.has(i),
        });
    }

    return {
        flight: {
            id: payload.uuid,
            name: typeof payload.name === 'string' ? payload.name : '',
            startedAt: isNum(payload.startedAt) ? payload.startedAt : base,
            endedAt: isNum(payload.endedAt) ? payload.endedAt : null,
            updatedAt: isNum(payload.updatedAt) ? payload.updatedAt : null,
            stats: payload.stats && typeof payload.stats === 'object' ? payload.stats : flightStats(points),
        },
        points,
    };
}

// --- playback -------------------------------------------------------------

/** Index of the last fix at or before `tMs`, clamped to the track; -1 if empty. */
export function playbackIndex(points, tMs) {
    if (!Array.isArray(points) || points.length === 0) return -1;
    if (tMs <= points[0].t) return 0;
    if (tMs >= points[points.length - 1].t) return points.length - 1;
    let lo = 0;
    let hi = points.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (points[mid].t <= tMs) lo = mid; else hi = mid - 1;
    }
    return lo;
}

/**
 * Where the aircraft was at a given moment, for the playback scrubber.
 *
 * Positions between two fixes are interpolated, but never across a recording
 * gap: nobody knows what route was flown while the phone was asleep, so the
 * marker holds at the last real fix rather than gliding along an invented
 * straight line.
 */
export function interpolatePosition(points, tMs) {
    const i = playbackIndex(points, tMs);
    if (i === -1) return null;
    const a = points[i];
    const b = points[i + 1];
    if (!b || tMs <= a.t) return { lat: a.lat, lon: a.lon, alt: a.alt };
    if (isGap(a, b, GAP_MS)) return { lat: a.lat, lon: a.lon, alt: a.alt };

    const f = (tMs - a.t) / (b.t - a.t);
    const lerp = (x, y) => (isNum(x) && isNum(y) ? x + (y - x) * f : (isNum(x) ? x : null));
    return { lat: lerp(a.lat, b.lat), lon: lerp(a.lon, b.lon), alt: lerp(a.alt, b.alt) };
}

// --- chart geometry -------------------------------------------------------

/** One channel of the track as {t, v} pairs, with the missing readings dropped. */
export function profileSeries(points, key) {
    if (!Array.isArray(points)) return [];
    const out = [];
    for (const p of points) if (isNum(p[key])) out.push({ t: p.t, v: p[key] });
    return out;
}

/** An SVG path for a {t, v} series scaled into a width x height box. */
export function seriesPath(series, { width, height, min, max }) {
    if (!Array.isArray(series) || series.length === 0) return '';
    const t0 = series[0].t;
    const span = series[series.length - 1].t - t0;
    const range = max - min;
    const num = (n) => String(Number(n.toFixed(2)));

    return series.map((p, i) => {
        const x = span > 0 ? ((p.t - t0) / span) * width : 0;
        // A perfectly flat channel has no range to scale into; centre it.
        const y = range > 0 ? height - ((p.v - min) / range) * height : height / 2;
        return `${i === 0 ? 'M' : 'L'}${num(x)},${num(y)}`;
    }).join('');
}

// --- sync diffing ---------------------------------------------------------

/**
 * Which flights each side is missing, by client-minted uuid.
 *
 * Flights are effectively immutable once ended (only the name and a deletion
 * change afterwards), so the newer `updatedAt` simply wins rather than needing
 * a field-by-field merge.
 */
export function mergeFlightLists(local, remote) {
    const byUuid = (list) => new Map((Array.isArray(list) ? list : []).map((f) => [f.uuid, f]));
    const l = byUuid(local);
    const r = byUuid(remote);

    const toPush = [];
    const toPull = [];
    for (const [uuid, f] of l) {
        const other = r.get(uuid);
        if (!other || (f.updatedAt ?? 0) > (other.updatedAt ?? 0)) toPush.push(uuid);
    }
    for (const [uuid, f] of r) {
        const other = l.get(uuid);
        if (!other || (f.updatedAt ?? 0) > (other.updatedAt ?? 0)) toPull.push(uuid);
    }
    return { toPush, toPull };
}
