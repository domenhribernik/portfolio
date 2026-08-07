// Unit tests for views/trails/logic.js, the DOM-free brain of the Trails
// flight recorder: metric formatting, great-circle geometry, the horizon
// visibility model, GPS fix filtering, track statistics and chart geometry.
// Run: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatDuration, formatKm, formatSpeed, formatAlt, formatDateDmy, formatClock, todayIso, haversineKm, bearingDeg, compassPoint, horizonKm, deriveSpeedMps, acceptFix, gapSegments, flightStats, inflatePlaces, visibleCities, simplifyTrack, serializeFlight, deserializeFlight,
    playbackIndex, interpolatePosition, profileSeries, seriesPath, mergeFlightLists } from '../views/trails/logic.js';

// Thousands are grouped with U+00A0 so a readout never wraps away from its unit.
const NB = ' ';

test('formatDuration counts a flight in hours, minutes and seconds', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(45_000), '0:45');
    assert.equal(formatDuration(754_000), '12:34');
    assert.equal(formatDuration(3_723_000), '1:02:03');
    assert.equal(formatDuration(36_000_000), '10:00:00');
});

test('formatDuration renders a dash for missing values', () => {
    assert.equal(formatDuration(null), '–');
    assert.equal(formatDuration(undefined), '–');
    assert.equal(formatDuration(NaN), '–');
    assert.equal(formatDuration(-5), '–');
});

test('formatKm switches from metres to kilometres at the kilometre mark', () => {
    assert.equal(formatKm(0), '0 m');
    assert.equal(formatKm(850), '850 m');
    assert.equal(formatKm(999), '999 m');
    assert.equal(formatKm(1000), '1.0 km');
    assert.equal(formatKm(12_432), '12.4 km');
});

test('formatKm drops decimals once a distance passes 100 km and groups thousands', () => {
    assert.equal(formatKm(99_949), '99.9 km');
    assert.equal(formatKm(100_000), '100 km');
    assert.equal(formatKm(1_043_000), '1043 km');
    assert.equal(formatKm(12_400_000), `12${NB}400 km`);
});

test('formatSpeed reads out ground speed in whole km/h', () => {
    assert.equal(formatSpeed(0), '0 km/h');
    assert.equal(formatSpeed(42.8), '154 km/h');
    assert.equal(formatSpeed(250), '900 km/h');
});

test('formatAlt reads out altitude in whole metres, grouped past ten thousand', () => {
    assert.equal(formatAlt(0), '0 m');
    assert.equal(formatAlt(1250.6), '1251 m');
    assert.equal(formatAlt(11_250), `11${NB}250 m`);
});

test('the readouts render a dash rather than a wrong number when GPS gives nothing', () => {
    for (const fn of [formatKm, formatSpeed, formatAlt]) {
        assert.equal(fn(null), '–');
        assert.equal(fn(undefined), '–');
        assert.equal(fn(NaN), '–');
    }
});

test('formatDateDmy renders day-first, the site convention', () => {
    assert.equal(formatDateDmy(Date.UTC(2026, 7, 7, 12)), '07.08.2026');
    assert.equal(formatDateDmy('2026-08-07T12:00:00Z'), '07.08.2026');
    assert.equal(formatDateDmy(null), '–');
    assert.equal(formatDateDmy('not a date'), '–');
});

test('formatClock renders a 24-hour wall clock', () => {
    // Built from local parts so the assertion holds in any timezone.
    assert.equal(formatClock(new Date(2026, 7, 7, 9, 5).getTime()), '09:05');
    assert.equal(formatClock(new Date(2026, 7, 7, 23, 59).getTime()), '23:59');
    assert.equal(formatClock(null), '–');
});

test('todayIso reads the local calendar day, not the UTC one', () => {
    // 00:30 CEST on 7 August is still 6 August in UTC; the local day wins.
    assert.equal(todayIso(new Date(2026, 7, 7, 0, 30)), '2026-08-07');
    assert.equal(todayIso(new Date(2026, 0, 1, 23, 59)), '2026-01-01');
});

// --- great-circle geometry -------------------------------------------------

test('haversineKm measures a real leg against its published distance', () => {
    // Ljubljana to Zagreb, ~117 km great-circle.
    assert.ok(Math.abs(haversineKm(46.056, 14.508, 45.815, 15.982) - 117.09) < 0.5);
    // Heathrow to JFK, the classic North Atlantic run.
    assert.ok(Math.abs(haversineKm(51.47, -0.4543, 40.6413, -73.7781) - 5540) < 5);
});

test('haversineKm is zero for a stationary aircraft and never negative', () => {
    assert.equal(haversineKm(46.056, 14.508, 46.056, 14.508), 0);
    assert.ok(haversineKm(-33.9, 151.2, 35.7, 139.7) > 0);
});

test('haversineKm crosses the antimeridian by the short way', () => {
    // 1 degree apart either side of the date line, not 359 degrees.
    const km = haversineKm(0, 179.5, 0, -179.5);
    assert.ok(Math.abs(km - 111.2) < 1, `expected ~111 km, got ${km}`);
});

test('bearingDeg points at the compass quarters', () => {
    assert.ok(Math.abs(bearingDeg(0, 0, 1, 0) - 0) < 0.01);
    assert.ok(Math.abs(bearingDeg(0, 0, 0, 1) - 90) < 0.01);
    assert.ok(Math.abs(bearingDeg(0, 0, -1, 0) - 180) < 0.01);
    assert.ok(Math.abs(bearingDeg(0, 0, 0, -1) - 270) < 0.01);
});

test('compassPoint names the sixteen-point rose and wraps through north', () => {
    assert.equal(compassPoint(0), 'N');
    assert.equal(compassPoint(45), 'NE');
    assert.equal(compassPoint(90), 'E');
    assert.equal(compassPoint(180), 'S');
    assert.equal(compassPoint(270), 'W');
    assert.equal(compassPoint(350), 'N');
    assert.equal(compassPoint(371), 'N');   // 11 degrees once wrapped
    assert.equal(compassPoint(405), 'NE');  // 45 degrees once wrapped
    assert.equal(compassPoint(-90), 'W');
});

test('horizonKm is how far you can see from a given altitude', () => {
    // The standard 3.57*sqrt(h) horizon: ~374 km from a cruising airliner.
    assert.ok(Math.abs(horizonKm(11_000) - 374.4) < 0.5);
    assert.ok(Math.abs(horizonKm(100) - 35.7) < 0.1);
    assert.equal(horizonKm(0), 0);
});

test('horizonKm refuses to invent a view from a missing or negative altitude', () => {
    assert.equal(horizonKm(null), 0);
    assert.equal(horizonKm(undefined), 0);
    assert.equal(horizonKm(NaN), 0);
    assert.equal(horizonKm(-50), 0);
});

test('deriveSpeedMps fills in ground speed when the device reports none', () => {
    const prev = { t: 0, lat: 0, lon: 0 };
    const next = { t: 10_000, lat: 0, lon: 0.001 };
    // 111.2 m in 10 s.
    assert.ok(Math.abs(deriveSpeedMps(prev, next) - 11.12) < 0.05);
});

test('deriveSpeedMps returns null rather than a divide-by-zero', () => {
    assert.equal(deriveSpeedMps(null, { t: 10, lat: 0, lon: 0 }), null);
    assert.equal(deriveSpeedMps({ t: 10, lat: 0, lon: 0 }, { t: 10, lat: 0, lon: 1 }), null);
    assert.equal(deriveSpeedMps({ t: 20, lat: 0, lon: 0 }, { t: 10, lat: 0, lon: 1 }), null);
});

// --- recording ------------------------------------------------------------

/** A GPS fix as the recorder stores it. */
const fix = (t, lat, lon, extra = {}) => ({ t, lat, lon, alt: null, acc: 10, spd: null, ...extra });

test('acceptFix always takes the first fix of a flight', () => {
    assert.equal(acceptFix(null, fix(0, 46, 14)), true);
});

test('acceptFix throws away fixes the receiver is not confident about', () => {
    // A 500 m error circle would draw a track through the wrong country.
    assert.equal(acceptFix(null, fix(0, 46, 14, { acc: 500 })), false);
    assert.equal(acceptFix(null, fix(0, 46, 14, { acc: 100 })), true);
    assert.equal(acceptFix(null, fix(0, 46, 14, { acc: null })), true);
});

test('acceptFix rate-limits the track to one fix every few seconds', () => {
    const prev = fix(0, 46, 14);
    // 1 s later and 250 m along: moving fast, but too soon to store.
    assert.equal(acceptFix(prev, fix(1000, 46.00225, 14)), false);
    assert.equal(acceptFix(prev, fix(3000, 46.00225, 14)), true);
});

test('acceptFix ignores GPS jitter while the aircraft sits still', () => {
    const prev = fix(0, 46, 14);
    // 10 s later, wandered 5 m: that is the receiver breathing, not taxiing.
    assert.equal(acceptFix(prev, fix(10_000, 46.000045, 14)), false);
});

test('acceptFix still beats once a minute so a hold does not look like lost signal', () => {
    const prev = fix(0, 46, 14);
    assert.equal(acceptFix(prev, fix(59_000, 46.000045, 14)), false);
    assert.equal(acceptFix(prev, fix(60_000, 46.000045, 14)), true);
});

test('gapSegments keeps an unbroken track in one piece', () => {
    const pts = [fix(0, 46, 14), fix(5000, 46.1, 14), fix(10_000, 46.2, 14)];
    const { segments, gaps } = gapSegments(pts);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].length, 3);
    assert.deepEqual(gaps, []);
});

test('gapSegments splits the track where the recorder went quiet', () => {
    // Two minutes of silence: the app was backgrounded mid-flight.
    const pts = [fix(0, 46, 14), fix(5000, 46.1, 14), fix(125_000, 47, 14), fix(130_000, 47.1, 14)];
    const { segments, gaps } = gapSegments(pts);
    assert.equal(segments.length, 2);
    assert.deepEqual(segments.map((s) => s.length), [2, 2]);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0][0].t, 5000);
    assert.equal(gaps[0][1].t, 125_000);
});

test('gapSegments honours a fix the recorder itself flagged as a resume', () => {
    // Timestamps are close, but the recorder knows it restarted the watch.
    const pts = [fix(0, 46, 14), fix(4000, 46.1, 14, { gap: true }), fix(8000, 46.2, 14)];
    const { segments, gaps } = gapSegments(pts);
    assert.equal(segments.length, 2);
    assert.equal(gaps.length, 1);
});

test('gapSegments copes with an empty or single-fix track', () => {
    assert.deepEqual(gapSegments([]), { segments: [], gaps: [] });
    const one = gapSegments([fix(0, 46, 14)]);
    assert.equal(one.segments.length, 1);
    assert.deepEqual(one.gaps, []);
});

test('flightStats measures the whole flight', () => {
    const pts = [
        fix(0, 46.0, 14.0, { alt: 300, spd: 80 }),
        fix(600_000, 46.5, 14.0, { alt: 9000, spd: 230 }),
        fix(1_200_000, 47.0, 14.0, { alt: 11_000, spd: 250 }),
    ];
    const s = flightStats(pts);
    assert.equal(s.pointCount, 3);
    assert.equal(s.startedAt, 0);
    assert.equal(s.endedAt, 1_200_000);
    assert.equal(s.durationMs, 1_200_000);
    assert.ok(Math.abs(s.distanceKm - 111.2) < 1, `got ${s.distanceKm}`);
    assert.equal(s.maxAltM, 11_000);
    assert.equal(s.minAltM, 300);
    assert.equal(s.maxSpeedKmh, 900);
    assert.ok(Math.abs(s.avgSpeedKmh - 333.6) < 3, `got ${s.avgSpeedKmh}`);
});

test('flightStats counts the time the recorder lost and still spans the gap on distance', () => {
    const pts = [fix(0, 46, 14), fix(5000, 46.1, 14), fix(305_000, 47, 14)];
    const s = flightStats(pts);
    assert.equal(s.gapCount, 1);
    assert.equal(s.gapMs, 300_000);
    assert.equal(s.movingMs, 5000);
    // The aircraft covered the ground even though nothing was recorded.
    assert.ok(s.distanceKm > 100, `got ${s.distanceKm}`);
});

test('flightStats survives a track with no altitude or speed at all', () => {
    const s = flightStats([fix(0, 46, 14), fix(5000, 46.001, 14)]);
    assert.equal(s.maxAltM, null);
    assert.equal(s.minAltM, null);
    assert.ok(s.maxSpeedKmh > 0);
});

test('flightStats returns an empty summary rather than throwing on no fixes', () => {
    const s = flightStats([]);
    assert.equal(s.pointCount, 0);
    assert.equal(s.distanceKm, 0);
    assert.equal(s.durationMs, 0);
    assert.equal(s.startedAt, null);
    assert.equal(s.maxAltM, null);
});

// --- what is out of the window --------------------------------------------

// The shape data/places.json ships: interned country names plus compact rows
// of [name, lat, lon, population, countryIndex, isCapital].
const PLACES_FILE = {
    countries: ['Slovenia', 'Croatia', 'Austria'],
    places: [
        ['Zagreb', 45.8, 15.98, 698_966, 1, 1],
        ['Ljubljana', 46.055, 14.515, 314_807, 0, 1],
        ['Graz', 47.07, 15.44, 260_000, 2, 0],
        ['Maribor', 46.554, 15.646, 95_000, 0, 0],
        ['Sydney', -33.92, 151.19, 4_600_000, 1, 0],
    ],
};

test('inflatePlaces turns the compact file into usable records', () => {
    const places = inflatePlaces(PLACES_FILE);
    assert.equal(places.length, 5);
    assert.deepEqual(places[1], {
        name: 'Ljubljana', lat: 46.055, lon: 14.515,
        pop: 314_807, country: 'Slovenia', capital: true,
    });
    assert.equal(places[2].country, 'Austria');
    assert.equal(places[2].capital, false);
});

test('inflatePlaces tolerates a missing or malformed file', () => {
    assert.deepEqual(inflatePlaces(null), []);
    assert.deepEqual(inflatePlaces({}), []);
    assert.deepEqual(inflatePlaces({ countries: [], places: 'nope' }), []);
});

test('visibleCities lists only what is actually over the horizon', () => {
    const places = inflatePlaces(PLACES_FILE);
    // Over Ljubljana at 1000 m the horizon is 112.9 km, and that is the whole
    // point of the model: Maribor at 103 km is in sight, Zagreb at 117 km is
    // already behind the curve of the Earth.
    const names = visibleCities(46.055, 14.515, 1000, places).map((c) => c.name);
    assert.deepEqual(names, ['Ljubljana', 'Maribor']);
});

test('visibleCities sees much further from cruising altitude', () => {
    const places = inflatePlaces(PLACES_FILE);
    // At 11 km the horizon reaches 374 km and the same two cities appear.
    const high = visibleCities(46.055, 14.515, 11_000, places).map((c) => c.name);
    assert.ok(high.includes('Zagreb'));
    assert.ok(high.includes('Graz'));
    assert.ok(!high.includes('Sydney'));     // other side of the planet
});

test('visibleCities sees nothing at all from the ground', () => {
    const places = inflatePlaces(PLACES_FILE);
    assert.deepEqual(visibleCities(46.055, 14.515, 0, places), []);
    assert.deepEqual(visibleCities(46.055, 14.515, null, places), []);
});

test('visibleCities reports the direction to look and orders by distance', () => {
    const places = inflatePlaces(PLACES_FILE);
    const seen = visibleCities(46.055, 14.515, 11_000, places);
    for (let i = 1; i < seen.length; i++) {
        assert.ok(seen[i].distanceKm >= seen[i - 1].distanceKm, 'not sorted by distance');
    }
    const zagreb = seen.find((c) => c.name === 'Zagreb');
    assert.ok(Math.abs(zagreb.distanceKm - 116.8) < 1, `got ${zagreb.distanceKm}`);
    assert.equal(zagreb.compass, 'ESE');
    assert.equal(zagreb.country, 'Croatia');
});

test('visibleCities keeps the biggest landmarks but never drops the closest one', () => {
    const places = inflatePlaces(PLACES_FILE);
    // Limit of 2 over a spot where a small town is nearest: the town survives.
    const seen = visibleCities(46.554, 15.646, 11_000, places, 2);
    assert.equal(seen.length, 2);
    assert.ok(seen.some((c) => c.name === 'Maribor'), 'nearest place was dropped');
});

// --- simplification for sync ----------------------------------------------

test('simplifyTrack collapses a straight leg to its endpoints', () => {
    const pts = [0, 1, 2, 3, 4].map((i) => fix(i * 10_000, 46 + i * 0.1, 14));
    const out = simplifyTrack(pts);
    assert.equal(out.length, 2);
    assert.equal(out[0].t, 0);
    assert.equal(out[1].t, 40_000);
});

test('simplifyTrack keeps a turn that actually happened', () => {
    const pts = [
        fix(0, 46.0, 14.0),
        fix(10_000, 46.1, 14.05),   // ~3.8 km off the straight line
        fix(20_000, 46.2, 14.0),
    ];
    assert.equal(simplifyTrack(pts).length, 3);
});

test('simplifyTrack never welds the track across a recording gap', () => {
    const pts = [
        fix(0, 46.0, 14.0), fix(10_000, 46.1, 14.0), fix(20_000, 46.2, 14.0),
        fix(500_000, 47.0, 14.0), fix(510_000, 47.1, 14.0), fix(520_000, 47.2, 14.0),
    ];
    const out = simplifyTrack(pts);
    // Both sides of the gap keep their own endpoints: 4 points, not 2.
    assert.equal(out.length, 4);
    assert.deepEqual(out.map((p) => p.t), [0, 20_000, 500_000, 520_000]);
});

test('simplifyTrack caps a long flight at a payload the controller will take', () => {
    // A jittery ten-hour track that Douglas-Peucker alone cannot thin enough.
    const pts = [];
    for (let i = 0; i < 9000; i++) {
        pts.push(fix(i * 4000, 46 + i * 0.001, 14 + (i % 2) * 0.004));
    }
    const out = simplifyTrack(pts, 25, 500);
    assert.ok(out.length <= 500, `got ${out.length}`);
    assert.equal(out[0].t, 0);
    assert.equal(out[out.length - 1].t, pts[pts.length - 1].t);
});

test('simplifyTrack passes very short tracks straight through', () => {
    assert.deepEqual(simplifyTrack([]), []);
    const one = [fix(0, 46, 14)];
    assert.equal(simplifyTrack(one).length, 1);
    assert.equal(simplifyTrack([fix(0, 46, 14), fix(1000, 47, 14)]).length, 2);
});

// --- the wire format ------------------------------------------------------

const FLIGHT = {
    id: '6f1e7b0c-6b2a-4f1e-9c3d-2a5b8e4d7c10',
    name: 'Ljubljana to Amsterdam',
    startedAt: 1_754_000_000_000,
    endedAt: 1_754_007_200_000,
    updatedAt: 1_754_007_300_000,
};
const TRACK = [
    fix(1_754_000_000_000, 46.0552, 14.5153, { alt: 300, spd: 82.4 }),
    fix(1_754_000_010_000, 46.1552, 14.5153, { alt: 3000, spd: 180 }),
    fix(1_754_000_020_000, 46.2552, 14.5153, { alt: 11_000, spd: 250, gap: true }),
];

test('a serialized flight survives the round trip', () => {
    const { flight, points } = deserializeFlight(serializeFlight(FLIGHT, TRACK));
    assert.equal(flight.id, FLIGHT.id);
    assert.equal(flight.name, 'Ljubljana to Amsterdam');
    assert.equal(flight.startedAt, FLIGHT.startedAt);
    assert.equal(points.length, 3);
    assert.equal(points[0].t, TRACK[0].t);
    assert.equal(points[2].t, TRACK[2].t);
    assert.ok(Math.abs(points[1].lat - 46.1552) < 1e-5);
    assert.equal(points[0].alt, 300);
    assert.equal(points[2].gap, true);
    assert.equal(points[0].gap, false);
});

test('serializeFlight stamps a version and stores time as compact deltas', () => {
    const wire = serializeFlight(FLIGHT, TRACK);
    assert.equal(wire.v, 1);
    assert.equal(wire.uuid, FLIGHT.id);
    // Seconds since the flight started, not repeated 13-digit epochs.
    assert.deepEqual(wire.points.t, [0, 10, 20]);
    assert.deepEqual(wire.points.gap, [2]);
    assert.ok(wire.stats.distanceKm > 0);
});

test('serializeFlight keeps null altitude and speed as null, never zero', () => {
    const wire = serializeFlight(FLIGHT, [fix(FLIGHT.startedAt, 46, 14), fix(FLIGHT.startedAt + 5000, 46.1, 14)]);
    assert.deepEqual(wire.points.alt, [null, null]);
    assert.deepEqual(wire.points.spd, [null, null]);
    const { points } = deserializeFlight(wire);
    assert.equal(points[0].alt, null);
    assert.equal(points[0].spd, null);
});

test('deserializeFlight drops junk instead of throwing', () => {
    assert.equal(deserializeFlight(null), null);
    assert.equal(deserializeFlight({}), null);
    assert.equal(deserializeFlight({ v: 99, uuid: FLIGHT.id }), null);
    assert.equal(deserializeFlight({ v: 1, uuid: 'not-a-uuid', points: {} }), null);
    // Columns of different lengths cannot describe a track.
    const wire = serializeFlight(FLIGHT, TRACK);
    wire.points.lat = wire.points.lat.slice(0, 2);
    assert.equal(deserializeFlight(wire), null);
});

// --- playback -------------------------------------------------------------

test('playbackIndex finds the fix in force at a given moment', () => {
    assert.equal(playbackIndex(TRACK, TRACK[0].t), 0);
    assert.equal(playbackIndex(TRACK, TRACK[0].t + 5000), 0);
    assert.equal(playbackIndex(TRACK, TRACK[1].t), 1);
    assert.equal(playbackIndex(TRACK, TRACK[2].t + 999), 2);
});

test('playbackIndex clamps to the ends of the flight', () => {
    assert.equal(playbackIndex(TRACK, 0), 0);
    assert.equal(playbackIndex(TRACK, Number.MAX_SAFE_INTEGER), 2);
    assert.equal(playbackIndex([], 123), -1);
});

test('interpolatePosition slides smoothly between two fixes', () => {
    const pts = [
        fix(0, 46.0, 14.0, { alt: 1000 }),
        fix(10_000, 46.2, 14.0, { alt: 2000 }),
    ];
    const mid = interpolatePosition(pts, 5000);
    assert.ok(Math.abs(mid.lat - 46.1) < 1e-6, `got ${mid.lat}`);
    assert.equal(mid.lon, 14);
    assert.ok(Math.abs(mid.alt - 1500) < 1e-6);
});

test('interpolatePosition never invents a path across a recording gap', () => {
    const pts = [fix(0, 46.0, 14.0), fix(500_000, 47.0, 14.0)];
    // Halfway through the silence the aircraft is not halfway along a line
    // nobody recorded: it stays at the last known fix.
    const mid = interpolatePosition(pts, 250_000);
    assert.equal(mid.lat, 46.0);
});

test('interpolatePosition clamps outside the flight and copes with no track', () => {
    assert.equal(interpolatePosition([], 5), null);
    const pts = [fix(0, 46, 14), fix(10_000, 47, 14)];
    assert.equal(interpolatePosition(pts, -99).lat, 46);
    assert.equal(interpolatePosition(pts, 99_999).lat, 47);
});

// --- chart geometry -------------------------------------------------------

test('profileSeries pulls one channel out of the track and drops the holes', () => {
    const pts = [
        fix(0, 46, 14, { alt: 300 }),
        fix(1000, 46, 14, { alt: null }),
        fix(2000, 46, 14, { alt: 900 }),
    ];
    assert.deepEqual(profileSeries(pts, 'alt'), [{ t: 0, v: 300 }, { t: 2000, v: 900 }]);
    assert.deepEqual(profileSeries([], 'alt'), []);
});

test('seriesPath draws an SVG path in the box it is given', () => {
    const series = [{ t: 0, v: 0 }, { t: 10, v: 100 }];
    assert.equal(seriesPath(series, { width: 100, height: 50, min: 0, max: 100 }), 'M0,50L100,0');
});

test('seriesPath centres a flat line instead of dividing by zero', () => {
    const series = [{ t: 0, v: 7 }, { t: 10, v: 7 }];
    assert.equal(seriesPath(series, { width: 100, height: 50, min: 7, max: 7 }), 'M0,25L100,25');
});

test('seriesPath returns nothing to draw for an empty series', () => {
    assert.equal(seriesPath([], { width: 100, height: 50, min: 0, max: 1 }), '');
    assert.equal(seriesPath([{ t: 5, v: 3 }], { width: 100, height: 50, min: 0, max: 6 }), 'M0,25');
});

// --- sync diffing ---------------------------------------------------------

test('mergeFlightLists pushes what only this device has', () => {
    const local = [{ uuid: 'a', updatedAt: 100 }, { uuid: 'b', updatedAt: 100 }];
    const remote = [{ uuid: 'a', updatedAt: 100 }];
    assert.deepEqual(mergeFlightLists(local, remote), { toPush: ['b'], toPull: [] });
});

test('mergeFlightLists pulls flights recorded on another device', () => {
    const local = [{ uuid: 'a', updatedAt: 100 }];
    const remote = [{ uuid: 'a', updatedAt: 100 }, { uuid: 'c', updatedAt: 50 }];
    assert.deepEqual(mergeFlightLists(local, remote), { toPush: [], toPull: ['c'] });
});

test('mergeFlightLists lets the newer edit of the same flight win', () => {
    const local = [{ uuid: 'a', updatedAt: 200 }, { uuid: 'b', updatedAt: 100 }];
    const remote = [{ uuid: 'a', updatedAt: 100 }, { uuid: 'b', updatedAt: 300 }];
    assert.deepEqual(mergeFlightLists(local, remote), { toPush: ['a'], toPull: ['b'] });
});

test('mergeFlightLists has nothing to do when both sides agree', () => {
    const both = [{ uuid: 'a', updatedAt: 100 }];
    assert.deepEqual(mergeFlightLists(both, both), { toPush: [], toPull: [] });
    assert.deepEqual(mergeFlightLists([], []), { toPush: [], toPull: [] });
});

test('the idle heartbeat is never mistaken for lost signal', () => {
    // acceptFix deliberately stores a fix once a minute even when the aircraft
    // has not moved, so a hold still records. If the gap threshold were below
    // that heartbeat, every one of those fixes would be drawn as a break in
    // recording. These two constants have to stay on speaking terms.
    const prev = fix(0, 46, 14);
    const beat = fix(60_000, 46.000045, 14);
    assert.equal(acceptFix(prev, beat), true, 'heartbeat should be stored');

    const { gaps } = gapSegments([prev, beat]);
    assert.deepEqual(gaps, [], 'a stored heartbeat must not read as a gap');
    assert.equal(flightStats([prev, beat]).gapCount, 0);
});
