// Decision logic for Trips (views/trips). DOM-free so tests/trips-logic.test.mjs
// can hold it: line colours, the atlas counts, photo intake (EXIF, location
// fallback, resize maths), the offline outbox's rules, roles, routes and the
// map's clustering. script.js only wires these to the page.

import { placeLabel } from '../nebo/geo.js';

// ---- line colours ----------------------------------------------------

// Each trip owns one line colour, the way each line on a network map does.
// Keys match LINE_COLOURS in app/controllers/trips-controller.php (a test
// holds them together). `text` is the bullet's initials colour, chosen for
// 4.5:1 or better against the line.
export const INK = '#1d1b18';
export const PAPER = '#fbfaf6';

export const LINE_COLOURS = [
    { key: 'red', name: 'Red', hex: '#cf2d25', text: PAPER },
    { key: 'blue', name: 'Blue', hex: '#1d4fc4', text: PAPER },
    { key: 'green', name: 'Green', hex: '#0f7a45', text: PAPER },
    { key: 'yellow', name: 'Yellow', hex: '#f0bd2a', text: INK },
    { key: 'magenta', name: 'Magenta', hex: '#b0246f', text: PAPER },
    { key: 'brown', name: 'Brown', hex: '#87562a', text: PAPER },
    { key: 'teal', name: 'Teal', hex: '#0b7a80', text: PAPER },
    { key: 'orange', name: 'Orange', hex: '#bb4a0c', text: PAPER },
    { key: 'violet', name: 'Violet', hex: '#6b3db8', text: PAPER },
    { key: 'grey', name: 'Grey', hex: '#6b665e', text: PAPER },
];

export function lineColour(key) {
    return LINE_COLOURS.find(c => c.key === key) ?? LINE_COLOURS[0];
}

/** The colour for a new trip: the first unused one, else the least used. */
export function nextLineColour(trips) {
    const uses = new Map(LINE_COLOURS.map(c => [c.key, 0]));
    for (const t of trips) {
        if (uses.has(t.line)) uses.set(t.line, uses.get(t.line) + 1);
    }
    let best = LINE_COLOURS[0].key;
    for (const c of LINE_COLOURS) {
        if (uses.get(c.key) < uses.get(best)) best = c.key;
    }
    return best;
}

// ---- the atlas count line ------------------------------------------------

/** Totals for the atlas: trips, places, photos and distinct countries. */
export function networkStats(trips) {
    const countries = new Set();
    let places = 0;
    let photos = 0;
    for (const t of trips) {
        photos += t.photo_count ?? 0;
        for (const p of t.places ?? []) {
            places++;
            if (p.country_code) countries.add(p.country_code.toLowerCase());
        }
    }
    return { trips: trips.length, places, photos, countries: countries.size };
}

/** Up to two letters for a trip's bullet: the first of the first two words. */
export function tripInitials(name) {
    const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    return words.slice(0, 2).map(w => [...w][0].toLocaleUpperCase()).join('');
}

// ---- routes ------------------------------------------------------------
//
// Screens live in the hash so the back arrow (components/back-link.js) walks
// them: atlas, a trip, a place in map or grid view, a photo open on a place.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROUTE = new RegExp(`^#/t/(${UUID})(?:/p/(${UUID})(?:/(grid))?(?:/f/(${UUID}))?)?(?:/.*)?$`);
const TRIP_ONLY = new RegExp(`^#/t/(${UUID})(?:/.*)?$`);

export function parseRoute(hash) {
    const h = String(hash ?? '');
    const m = h.match(ROUTE);
    if (m && m[2]) {
        const route = { screen: 'place', trip: m[1], place: m[2], view: m[3] ? 'grid' : 'map' };
        if (m[4]) route.photo = m[4];
        return route;
    }
    const t = h.match(TRIP_ONLY);
    if (t) return { screen: 'trip', trip: t[1] };
    return { screen: 'atlas' };
}

export function routeHash(route) {
    if (route.screen === 'trip') return `#/t/${route.trip}`;
    if (route.screen === 'place') {
        let h = `#/t/${route.trip}/p/${route.place}`;
        if (route.view === 'grid') h += '/grid';
        if (route.photo) h += `/f/${route.photo}`;
        return h;
    }
    return '#/';
}

/**
 * The invite token from a `#join=<token>` fragment. The link lives in the
 * fragment, never the query, because analytics records the full query string
 * and a fragment never leaves the browser.
 */
export function parseJoinFragment(hash) {
    const m = String(hash ?? '').match(/^#join=([0-9a-f]{32})$/i);
    return m ? m[1].toLowerCase() : null;
}

// ---- naming a place ------------------------------------------------------

/**
 * A Nominatim search or reverse hit as a station: its own short name (the
 * feature itself, else its locality), position, country code, and a longer
 * "Locality, Country" detail line from nebo's labeller.
 */
export function placeFromNominatim(hit) {
    if (!hit) return null;
    const lat = parseFloat(hit.lat);
    const lon = parseFloat(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const a = hit.address || {};
    const locality = a.city || a.town || a.village || a.hamlet || a.municipality || a.suburb || a.county || null;
    const own = typeof hit.name === 'string' && hit.name.trim() ? hit.name.trim() : null;
    const name = own || locality || String(hit.display_name || '').split(',')[0].trim() || 'Unnamed stop';
    const cc = typeof a.country_code === 'string' && /^[a-z]{2}$/i.test(a.country_code) ? a.country_code.toLowerCase() : null;
    return { name, lat, lon, country_code: cc, detail: placeLabel(hit, name) };
}

// ---- reading a photo's EXIF ------------------------------------------------
//
// Phones write where and when a photo was taken into its EXIF block, and the
// resize on the way up (a canvas re-encode) throws that block away, so it is
// read here first. JPEG only: the browser hands HEIC over as JPEG when the
// picker converts, and a PNG has no camera data worth reading.
//
// Every read is bounds-checked; a truncated or hostile file gives null, never
// a throw. Pass the first 128 KB of the file, which always holds APP1.

export function readExif(buffer) {
    try {
        return readExifUnsafe(new DataView(buffer));
    } catch {
        return null;
    }
}

function readExifUnsafe(view) {
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
    let pos = 2;
    while (pos + 4 <= view.byteLength) {
        if (view.getUint8(pos) !== 0xff) return null;
        const marker = view.getUint8(pos + 1);
        // Start of scan or end of image: the metadata segments are behind us.
        if (marker === 0xda || marker === 0xd9) return null;
        const len = view.getUint16(pos + 2);
        if (marker === 0xe1 && pos + 10 <= view.byteLength
            && view.getUint32(pos + 4) === 0x45786966 && view.getUint16(pos + 8) === 0) {
            return readTiff(view, pos + 10, Math.min(view.byteLength, pos + 2 + len));
        }
        pos += 2 + len;
    }
    return null;
}

function readTiff(view, start, end) {
    const order = view.getUint16(start);
    if (order !== 0x4949 && order !== 0x4d4d) return null;
    const le = order === 0x4949;
    const u16 = (o) => view.getUint16(start + o, le);
    const u32 = (o) => view.getUint32(start + o, le);
    const inRange = (o, n) => o >= 0 && start + o + n <= end;
    if (!inRange(0, 8) || u16(2) !== 42) return null;

    /** Tag map of one IFD: tag -> {type, count, valueOffset}. */
    const ifd = (o) => {
        const tags = new Map();
        if (!inRange(o, 2)) return tags;
        const n = u16(o);
        for (let i = 0; i < n; i++) {
            const e = o + 2 + i * 12;
            if (!inRange(e, 12)) break;
            tags.set(u16(e), { type: u16(e + 2), count: u32(e + 4), at: e + 8 });
        }
        return tags;
    };
    const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    const dataAt = (t) => {
        const bytes = (SIZE[t.type] ?? 1) * t.count;
        return bytes <= 4 ? t.at : u32(t.at);
    };
    const ascii = (t) => {
        if (!t || t.type !== 2) return null;
        const o = dataAt(t);
        if (!inRange(o, t.count)) return null;
        let s = '';
        for (let i = 0; i < t.count; i++) {
            const c = view.getUint8(start + o + i);
            if (c === 0) break;
            s += String.fromCharCode(c);
        }
        return s;
    };
    const rationals = (t) => {
        if (!t || t.type !== 5 || t.count < 3) return null;
        const o = dataAt(t);
        if (!inRange(o, 24)) return null;
        const out = [];
        for (let i = 0; i < 3; i++) {
            const den = u32(o + i * 8 + 4);
            if (den === 0) return null;
            out.push(u32(o + i * 8) / den);
        }
        return out;
    };

    const ifd0 = ifd(u32(4));
    const result = { lat: null, lon: null, takenAt: null, offsetMin: null, orientation: null };

    const orient = ifd0.get(0x0112);
    if (orient && orient.type === 3) result.orientation = u16(orient.at);

    const exifPtr = ifd0.get(0x8769);
    if (exifPtr) {
        const exif = ifd(u32(exifPtr.at));
        result.takenAt = exifDateToIso(ascii(exif.get(0x9003)) ?? ascii(exif.get(0x9004)));
        result.offsetMin = parseExifOffset(ascii(exif.get(0x9011)));
    }

    const gpsPtr = ifd0.get(0x8825);
    if (gpsPtr) {
        const gps = ifd(u32(gpsPtr.at));
        const lat = rationals(gps.get(0x0002));
        const lon = rationals(gps.get(0x0004));
        if (lat && lon) {
            let la = lat[0] + lat[1] / 60 + lat[2] / 3600;
            let lo = lon[0] + lon[1] / 60 + lon[2] / 3600;
            if ((ascii(gps.get(0x0001)) ?? 'N').toUpperCase() === 'S') la = -la;
            if ((ascii(gps.get(0x0003)) ?? 'E').toUpperCase() === 'W') lo = -lo;
            // 0,0 is what a camera writes when it had no fix at all.
            const real = Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0);
            if (real) {
                result.lat = la;
                result.lon = lo;
            }
        }
    }
    return result;
}

/** "2026:08:14 14:32:05" to "2026-08-14 14:32:05"; a blank camera date is null. */
function exifDateToIso(s) {
    const m = String(s ?? '').match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m || m[1] === '0000' || m[2] === '00' || m[3] === '00') return null;
    return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

/** "+02:00" to 120, "-03:30" to -210. */
function parseExifOffset(s) {
    const m = String(s ?? '').match(/^([+-])(\d{2}):(\d{2})$/);
    if (!m) return null;
    const min = Number(m[2]) * 60 + Number(m[3]);
    return m[1] === '-' ? -min : min;
}

// ---- resizing ------------------------------------------------------------

export const MAX_EDGE = 2048;
const QUALITY_STEPS = [0.82, 0.72, 0.62, 0.52];

/** The size to draw a photo at: never upscaled, long edge at most maxEdge. */
export function fitWithin(width, height, maxEdge = MAX_EDGE) {
    const long = Math.max(width, height);
    if (long <= maxEdge) return { width, height, scale: 1 };
    const scale = maxEdge / long;
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        scale,
    };
}

/** The next JPEG quality to try when an encode is over the upload limit, or null. */
export function nextJpegQuality(q) {
    const i = QUALITY_STEPS.findIndex((s) => Math.abs(s - q) < 1e-9);
    return i >= 0 && i < QUALITY_STEPS.length - 1 ? QUALITY_STEPS[i + 1] : null;
}

// Where a photo's coordinates came from. Same list as the SQL ENUM and the
// PHP LOC_SOURCES (a test holds all three together). 'place' is approximate.
export const LOC_SOURCES = ['exif', 'device', 'place', 'manual'];

// ---- where and when a photo was taken ---------------------------------------
//
// Mobile photo pickers strip GPS from the file (Android 13+ without a special
// permission, iOS unless the user opts in), so the fallback is the normal path:
// the photo's own GPS, else where the phone is right now if the photo was just
// taken, else the place's own pin, flagged approximate.

const JUST_TAKEN_MS = 10 * 60_000;
const FIX_MAX_AGE_MS = 2 * 60_000;
const FIX_MAX_ACCURACY_M = 150;

export function isJustTaken(lastModifiedMs, nowMs, windowMs = JUST_TAKEN_MS) {
    if (!Number.isFinite(lastModifiedMs) || lastModifiedMs <= 0) return false;
    const age = nowMs - lastModifiedMs;
    return age >= -60_000 && age <= windowMs;
}

export function isUsableFix(fix, nowMs) {
    if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return false;
    return (nowMs - fix.timestamp) <= FIX_MAX_AGE_MS && fix.accuracy <= FIX_MAX_ACCURACY_M;
}

export function resolvePhotoLocation({ exif, fix, place, fileLastModified, now, capturedInApp = false }) {
    if (exif && Number.isFinite(exif.lat) && Number.isFinite(exif.lon)) {
        return { lat: exif.lat, lon: exif.lon, source: 'exif', approximate: false };
    }
    if ((capturedInApp || isJustTaken(fileLastModified, now)) && isUsableFix(fix, now)) {
        return { lat: fix.lat, lon: fix.lon, source: 'device', approximate: false };
    }
    return { lat: place.lat, lon: place.lon, source: 'place', approximate: true };
}

/**
 * When the photo was taken, as the wall clock where it was taken: EXIF's own
 * clock and zone, else the file's time in the phone's zone (tzOffsetMin is
 * minutes east of UTC, the negation of Date#getTimezoneOffset).
 */
export function resolveTakenAt({ exif, fileLastModified, tzOffsetMin }) {
    if (exif?.takenAt) return { takenAt: exif.takenAt, offsetMin: exif.offsetMin ?? null };
    if (!Number.isFinite(fileLastModified) || fileLastModified <= 0) return { takenAt: null, offsetMin: null };
    const wall = new Date(fileLastModified + tzOffsetMin * 60_000).toISOString();
    return { takenAt: `${wall.slice(0, 10)} ${wall.slice(11, 19)}`, offsetMin: tzOffsetMin };
}

// ---- the grid: a timetable of photos -----------------------------------------

/** Photos by the day they were taken, oldest first; undated ones last. */
export function groupByDay(photos) {
    const sorted = [...photos].sort((a, b) => {
        if (!a.taken_at && !b.taken_at) return 0;
        if (!a.taken_at) return 1;
        if (!b.taken_at) return -1;
        return a.taken_at < b.taken_at ? -1 : a.taken_at > b.taken_at ? 1 : 0;
    });
    const groups = [];
    for (const p of sorted) {
        const day = p.taken_at ? p.taken_at.slice(0, 10) : null;
        const last = groups[groups.length - 1];
        if (last && last.day === day) last.photos.push(p);
        else groups.push({ day, photos: [p] });
    }
    return groups;
}

/** "2026-08-14" or "2026-08-14 07:45:30" as "14.08.2026": day first, always. */
export function toDmy(iso) {
    const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** The wall-clock "07:45" of a taken_at. */
export function clockOf(takenAt) {
    const m = String(takenAt ?? '').match(/ (\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : '';
}

/** "14.08.2026", or "14.08.2026 to 16.08.2026" across days; '' with no dates. */
export function dateSpan(photos) {
    const days = photos.map((p) => p.taken_at?.slice(0, 10)).filter(Boolean).sort();
    if (days.length === 0) return '';
    const first = toDmy(days[0]);
    const last = toDmy(days[days.length - 1]);
    return first === last ? first : `${first} to ${last}`;
}

// ---- the offline outbox ------------------------------------------------------
//
// Only creates are queued: a trip, a place, a photo. Each op carries the uuid
// the phone minted, which is also the server's key, so a retry is always safe
// (the server answers a replay with the row it already has). Ops run one at a
// time, oldest first, each only once nothing it depends on is still queued.
//
// op: {seq, kind: 'trip'|'place'|'photo', uuid, userId, trip, place, body,
//      state: 'pending'|'stalled'|'blocked'|'failed'|'orphaned',
//      attempts, nextAt, lastError}

export const MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_CAP_MS = 15 * 60_000;

/** The uuids of the queued creates this op has to wait for. */
export function opDeps(op) {
    if (op.kind === 'place') return [op.trip];
    if (op.kind === 'photo') return [op.place];
    return [];
}

/** The op to send next, or null. */
export function nextRunnable(ops, { now, viewerId }) {
    const queued = new Set(ops.map((o) => o.uuid));
    // The server said storage is full: every photo waits, places still go.
    const photosHeld = ops.some((o) => o.kind === 'photo' && o.state === 'blocked');
    let best = null;
    for (const op of ops) {
        if (op.state !== 'pending' || op.userId !== viewerId || op.nextAt > now) continue;
        if (photosHeld && op.kind === 'photo') continue;
        if (opDeps(op).some((u) => queued.has(u))) continue;
        if (best === null || op.seq < best.seq) best = op;
    }
    return best;
}

/**
 * What the server's answer means for a queued create. Every `code` the
 * controller can send is handled here (a test greps the PHP to keep it so).
 */
export function classifyResponse({ status, code = null, offline = false }) {
    if (offline || status === 0) return 'retry';
    if (status === 200 || status === 201) return 'done';
    if (status === 401) return 'auth';
    if (status === 507 || code === 'quota') return 'blocked';
    if (status === 410) return code === 'gone' ? 'gone' : 'orphaned';
    if (status === 404) return 'orphaned';
    if (status === 408 || status === 429 || status >= 500) return 'retry';
    return 'failed';
}

/** 5s, 10s, 20s ... capped at 15 minutes, spread by plus or minus 25%. */
export function backoffMs(attempts, rand) {
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempts);
    if (base >= BACKOFF_CAP_MS) return BACKOFF_CAP_MS;
    return Math.round(base * (0.75 + rand * 0.5));
}

/** Apply one outcome to the queue. Returns the new ops and the uuids that left it. */
export function applyOutcome(ops, seq, outcome, now, rand) {
    const target = ops.find((o) => o.seq === seq);
    if (!target || outcome === 'auth') return { ops, removed: [] };
    if (outcome === 'done' || outcome === 'gone') {
        return { ops: ops.filter((o) => o.seq !== seq), removed: [target.uuid] };
    }

    let next = ops.map((o) => {
        if (o.seq !== seq) return o;
        if (outcome === 'retry') {
            const attempts = o.attempts + 1;
            return attempts >= MAX_ATTEMPTS
                ? { ...o, attempts, state: 'stalled' }
                : { ...o, attempts, nextAt: now + backoffMs(o.attempts, rand) };
        }
        return { ...o, state: outcome };
    });

    // A create that will never happen strands everything waiting on it.
    if (outcome === 'orphaned' || outcome === 'failed') {
        const dead = new Set([target.uuid]);
        let grew = true;
        while (grew) {
            grew = false;
            next = next.map((o) => {
                if (dead.has(o.uuid) || !opDeps(o).some((u) => dead.has(u))) return o;
                dead.add(o.uuid);
                grew = true;
                return { ...o, state: 'orphaned' };
            });
        }
    }
    return { ops: next, removed: [] };
}

/** Point stranded photos at another place and let them try again. */
export function rehome(ops, photoUuids, placeUuid, tripUuid) {
    const move = new Set(photoUuids);
    return ops.map((o) => (move.has(o.uuid)
        ? { ...o, place: placeUuid, trip: tripUuid, state: 'pending', attempts: 0, nextAt: 0 }
        : o));
}

/** The open trip as the screen shows it: the server's copy plus queued creates. */
export function mergePending(tree, ops) {
    const tripUuid = tree.trip.uuid;
    const placeIds = new Set(tree.places.map((p) => p.uuid));
    const photoIds = new Set(tree.photos.map((p) => p.uuid));
    const places = [...tree.places];
    const photos = [...tree.photos];
    for (const op of ops) {
        if (op.trip !== tripUuid) continue;
        if (op.kind === 'place' && !placeIds.has(op.uuid)) {
            places.push({ ...op.body, country_code: op.body.country_code ?? null, pending: true, state: op.state });
        } else if (op.kind === 'photo' && !photoIds.has(op.uuid)) {
            photos.push({ ...op.body, offset_min: op.body.taken_offset_min ?? null, pending: true, state: op.state });
        }
    }
    return { ...tree, places, photos };
}

/** The atlas with trips started offline at the top. */
export function mergePendingTrips(trips, ops) {
    const known = new Set(trips.map((t) => t.uuid));
    const pending = ops
        .filter((o) => o.kind === 'trip' && !known.has(o.uuid))
        .map((o) => ({ ...o.body, role: 'owner', places: [], photo_count: 0, pending: true, state: o.state }));
    return [...pending, ...trips];
}

// ---- photos on the map ---------------------------------------------------------

/** Pinned where they were taken, versus sitting at their place (approximate). */
export function splitMarkers(photos) {
    const exact = [];
    const approximate = [];
    for (const p of photos) (p.loc_source === 'place' ? approximate : exact).push(p);
    return { exact, approximate };
}

/**
 * Grid clustering in Web Mercator pixel space at a zoom level, so a cell is
 * the same size on screen wherever it is. Cheap enough to rerun on every
 * zoom, and spares vendoring a cluster plugin. Members keep their order.
 */
export function clusterPoints(points, zoom, cellPx = 56) {
    const size = 256 * 2 ** zoom;
    const cells = new Map();
    for (const p of points) {
        const x = ((p.lon + 180) / 360) * size;
        const s = Math.sin((Math.max(-85.05, Math.min(85.05, p.lat)) * Math.PI) / 180);
        const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size;
        const key = `${Math.floor(x / cellPx)}:${Math.floor(y / cellPx)}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(p);
    }
    return [...cells.values()].map((members) => ({
        lat: members.reduce((a, p) => a + p.lat, 0) / members.length,
        lon: members.reduce((a, p) => a + p.lon, 0) / members.length,
        members,
    }));
}

// ---- who may do what -------------------------------------------------------------
//
// Roles: owner, traveller, viewer (a signed-out visitor on the showcase). The
// controller enforces all of this; here it only decides which controls exist.

export function can(role, action, { mine = false } = {}) {
    if (role === 'owner') return action !== 'leave';
    if (role !== 'traveller') return false;
    switch (action) {
        case 'add': return true;
        case 'editPhoto':
        case 'deletePhoto':
        case 'editPlace': return mine;
        case 'leave': return true;
        default: return false;
    }
}

// ---- station names on the map -------------------------------------------------

const LABEL_GAP = 3;

/**
 * Which station names to print, given their boxes in screen pixels in order
 * of priority (the selected station first, then along the line). Greedy: a
 * name is printed only if it clears every name already printed.
 */
export function labelsThatFit(boxes) {
    const kept = [];
    return boxes.map((b) => {
        const clear = kept.every((k) => b.x >= k.x + k.w + LABEL_GAP || k.x >= b.x + b.w + LABEL_GAP
            || b.y >= k.y + k.h + LABEL_GAP || k.y >= b.y + b.h + LABEL_GAP);
        if (clear) kept.push(b);
        return clear;
    });
}
