import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    MAX_RADIUS_KM, MAX_IDS_PER_REQUEST, MIN_CALL_INTERVAL,
    clampRadius, formatPrice, formatKm, formatHour, formatCents,
    haversineKm, priceOf, sortByPrice, bestPrice, relativeAge, freshestObservation,
    hasStats, curveSeries, cheapestHour, dearestHour, dailySwing,
    curveToPath, curveDomain,
} from '../views/tanken/logic.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* views/tanken shows other people's licensed data under two rules it does not
   get to bend: the radius and request ceilings Tankerkoenig enforces, and the
   attribution both licences require. Those are the first two groups here.
   The rest is the arithmetic a driver reads off the page. */

// ---------------------------------------------------------------------------
//  The ceilings, which exist in two languages
// ---------------------------------------------------------------------------

test('the API ceilings in logic.js match the ones the PHP enforces', () => {
    const php = readFileSync(join(ROOT, 'app/services/tanken-service.php'), 'utf8');

    // Drift here is not cosmetic: the page would offer a radius the server
    // clamps, or batch more ids than the API accepts.
    assert.match(php, new RegExp(`MAX_RADIUS_KM\\s*=\\s*${MAX_RADIUS_KM}\\b`));
    assert.match(php, new RegExp(`MAX_IDS_PER_REQUEST\\s*=\\s*${MAX_IDS_PER_REQUEST}\\b`));
    assert.match(php, new RegExp(`MIN_CALL_INTERVAL\\s*=\\s*${MIN_CALL_INTERVAL}\\b`));
});

test('the radius can never exceed what the licence allows', () => {
    assert.equal(clampRadius(80), 25);
    assert.equal(clampRadius(25), 25);
    assert.equal(clampRadius(3), 3);
    assert.equal(clampRadius(0), 5, 'a nonsense radius falls back, it does not become unlimited');
    assert.equal(clampRadius(-4), 5);
    assert.equal(clampRadius(NaN), 5);
});

test('the page carries both licence credits and the Tankerkoenig link', () => {
    const html = readFileSync(join(ROOT, 'views/tanken/index.html'), 'utf8');

    // CC BY 4.0 on the live feed, BY-NC-SA 4.0 on the archive. Both are
    // conditions of use, so a page that lost one would be a licence breach
    // rather than a missing caption.
    assert.match(html, /CC BY 4\.0/, 'live price attribution is missing');
    assert.match(html, /CC BY-NC-SA 4\.0/, 'historical archive attribution is missing');
    assert.match(html, /tankerkoenig\.de/, 'the required link to tankerkoenig.de is missing');
    assert.match(html, /non-commercial/i, 'the NC term has to be stated, not just cited');
});

// ---------------------------------------------------------------------------
//  Ordering: cheapest first, but nothing removed
// ---------------------------------------------------------------------------

const station = (id, price, { status = 'open', dist = 1, fuel = 'e5' } = {}) => ({
    id,
    name: id,
    brand: id.toUpperCase(),
    dist,
    prices: price === null ? {} : { [fuel]: { price, status, observedAt: '2026-09-14T10:00:00' } },
});

test('stations sort cheapest first for the chosen fuel', () => {
    const list = [station('a', 1.879), station('b', 1.749), station('c', 1.799)];
    assert.deepEqual(sortByPrice(list, 'e5').map((s) => s.id), ['b', 'c', 'a']);
});

test('a closed station never outranks somewhere you can actually buy', () => {
    // A shut forecourt is not an offer, however cheap its last reading was.
    // Sorting it to the top would contradict the headline, which skips closed
    // stations, and would send someone to a locked pump.
    const list = [station('none', null), station('cheap', 1.70), station('closed', 1.65, { status: 'closed' })];
    const sorted = sortByPrice(list, 'e5');
    assert.equal(sorted.length, 3, 'every station the server returned must still be there');
    assert.deepEqual(sorted.map((s) => s.id), ['cheap', 'closed', 'none']);
});

test('the list order agrees with the headline about what is cheapest', () => {
    const list = [station('shut', 1.50, { status: 'closed' }), station('open', 1.75), station('dearer', 1.95)];
    const sorted = sortByPrice(list, 'e5');
    assert.equal(sorted[0].id, bestPrice(list, 'e5').station.id);
});

test('a station that does not sell the selected fuel still appears', () => {
    const list = [station('diesel-only', 1.65, { fuel: 'diesel' }), station('petrol', 1.80)];
    const sorted = sortByPrice(list, 'e5');
    assert.equal(sorted.length, 2);
    assert.equal(sorted.at(-1).id, 'diesel-only');
});

test('the order is stable when prices tie', () => {
    const list = [station('b', 1.70, { dist: 5 }), station('a', 1.70, { dist: 2 })];
    assert.deepEqual(sortByPrice(list, 'e5').map((s) => s.id), ['a', 'b'], 'nearest breaks a tie');
});

test('the headline price ignores stations that are closed', () => {
    const list = [station('shut', 1.50, { status: 'closed' }), station('open', 1.75)];
    assert.equal(bestPrice(list, 'e5').station.id, 'open');
});

test('bestPrice is null when nothing is open', () => {
    assert.equal(bestPrice([station('shut', 1.5, { status: 'closed' })], 'e5'), null);
    assert.equal(bestPrice([], 'e5'), null);
});

// ---------------------------------------------------------------------------
//  Formatting a driver reads
// ---------------------------------------------------------------------------

// U+00A0 before every unit, so a readout can never wrap away from what it
// measures. Spelled out here because the character is invisible in a diff and
// an editor that "tidied" it into a plain space would break the layout
// silently. Same convention as formatKm in views/trails/logic.js.
const NB = '\u00a0';

test('prices keep the tenth of a cent and the decimal comma', () => {
    // 1.789 is the number on the sign. Rounding it to 1,79 would be a
    // different price, and a full stop is the wrong separator in Germany.
    assert.equal(formatPrice(1.789), `1,789${NB}\u20ac`);
    assert.equal(formatPrice(1.7), `1,700${NB}\u20ac`);
    assert.equal(formatPrice(null), '\u2014');
    assert.equal(formatPrice(NaN), '\u2014');
});

test('distances switch unit where the number gets silly', () => {
    assert.equal(formatKm(0.4), `400${NB}m`);
    assert.equal(formatKm(2.35), `2,4${NB}km`);
});

test('deviations read as signed cents', () => {
    assert.equal(formatCents(0.021), `+2,1${NB}ct`);
    assert.equal(formatCents(-0.034), `\u22123,4${NB}ct`);
    assert.equal(formatCents(0), `\u00b10,0${NB}ct`);
});

test('the hour label is zero padded', () => {
    assert.equal(formatHour(7), '07:00');
    assert.equal(formatHour(20), '20:00');
    assert.equal(formatHour(null), '—');
});

// ---------------------------------------------------------------------------
//  Age, which is what stops a stale price passing for a live one
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-14T12:00:00Z');
const ago = (seconds) => new Date(NOW.getTime() - seconds * 1000).toISOString();

test('a reading describes its own age honestly', () => {
    assert.equal(relativeAge(ago(30), NOW), 'just now');
    assert.equal(relativeAge(ago(240), NOW), '4 min ago');
    assert.equal(relativeAge(ago(3 * 3600), NOW), '3 h ago');
    assert.equal(relativeAge(ago(26 * 3600), NOW), 'yesterday');
    assert.equal(relativeAge(ago(5 * 86400), NOW), '5 days ago');
});

test('a missing reading is never described as fresh', () => {
    assert.equal(relativeAge(null, NOW), 'never');
    assert.equal(relativeAge('not a date', NOW), 'never');
});

test('the page stamps itself with the newest reading it holds', () => {
    const list = [
        { id: 'a', prices: { e5: { price: 1.7, status: 'open', observedAt: '2026-09-14T09:00:00' } } },
        { id: 'b', prices: { e5: { price: 1.8, status: 'open', observedAt: '2026-09-14T11:30:00' } } },
    ];
    assert.equal(freshestObservation(list, 'e5'), '2026-09-14T11:30:00');
    assert.equal(freshestObservation([], 'e5'), null);
});

// ---------------------------------------------------------------------------
//  Geometry
// ---------------------------------------------------------------------------

test('haversine measures a known distance', () => {
    // Berlin to Hamburg, ~255 km.
    const km = haversineKm(52.52, 13.405, 53.551, 9.994);
    assert.ok(km > 250 && km < 260, `got ${km}`);
    assert.equal(haversineKm(52.52, 13.405, 52.52, 13.405), 0);
});

// ---------------------------------------------------------------------------
//  The statistics panel
// ---------------------------------------------------------------------------

const SAWTOOTH = [
    0.03, 0.03, 0.03, 0.03, 0.04, 0.05, 0.06, 0.06, 0.05, 0.03, 0.02, 0.01,
    0.00, -0.01, -0.01, -0.02, -0.02, -0.03, -0.04, -0.05, -0.06, -0.05, -0.03, 0.01,
];
const statsFixture = {
    window: { from: '2024-09-01', to: '2026-08-31', days: 730 },
    fuels: ['e5', 'e10', 'diesel'],
    byHour: { e5: SAWTOOTH, e10: SAWTOOTH, diesel: SAWTOOTH },
    byHourWeekday: { e5: Array.from({ length: 7 }, () => SAWTOOTH) },
};

test('an unbuilt statistics file reads as absent, not as a flat day', () => {
    // The committed placeholder must not draw a curve of zeroes, which would
    // look like a finding rather than like missing data.
    const placeholder = JSON.parse(readFileSync(join(ROOT, 'views/tanken/hourly-stats.json'), 'utf8'));
    assert.equal(hasStats(placeholder), false);
    assert.deepEqual(curveSeries(placeholder, 'e5'), []);
    assert.equal(cheapestHour(placeholder, 'e5'), null);
    assert.equal(hasStats(null), false);
});

test('the curve drops hours with no data rather than plotting them as zero', () => {
    const gappy = { window: { days: 10 }, byHour: { e5: [0.01, null, -0.02, undefined] } };
    assert.deepEqual(curveSeries(gappy, 'e5'), [{ hour: 0, value: 0.01 }, { hour: 2, value: -0.02 }]);
});

test('the cheapest and dearest hours come off the curve', () => {
    assert.equal(cheapestHour(statsFixture, 'e5'), 20);
    assert.equal(dearestHour(statsFixture, 'e5'), 6);
});

test('a weekday selection reads the weekday table', () => {
    assert.equal(cheapestHour(statsFixture, 'e5', 'mon'), 20);
    assert.deepEqual(curveSeries(statsFixture, 'e5', 'sun').length, 24);
    assert.deepEqual(curveSeries(statsFixture, 'diesel', 'mon'), [], 'no weekday table for diesel here');
});

test('the daily swing is the spread a driver could capture', () => {
    assert.ok(Math.abs(dailySwing(statsFixture, 'e5') - 0.12) < 1e-9);
    assert.equal(dailySwing({ window: { days: 1 }, byHour: { e5: [0.01] } }, 'e5'), null);
});

test('the y domain stays symmetric so the daily mean sits on the middle', () => {
    const domain = curveDomain(curveSeries(statsFixture, 'e5'));
    assert.ok(domain.min < 0 && domain.max > 0);
    assert.ok(Math.abs(domain.min + domain.max) < 1e-9, 'zero must be centred');
});

test('the curve path needs at least two points', () => {
    assert.equal(curveToPath([], { width: 100, height: 50, min: -1, max: 1 }), '');
    assert.equal(curveToPath([{ hour: 0, value: 0 }], { width: 100, height: 50, min: -1, max: 1 }), '');
    const path = curveToPath(curveSeries(statsFixture, 'e5'), { width: 230, height: 100, min: -0.1, max: 0.1 });
    assert.match(path, /^M0,/);
    assert.equal(path.split('L').length, 24);
});
