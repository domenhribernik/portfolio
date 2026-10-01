// Tests for views/trips/logic.js: everything in the travel album that decides
// rather than draws. Photo intake (EXIF, location fallback, resize maths), the
// offline outbox's scheduling and outcome rules, roles, routes, and the map's
// clustering. Also the drift guards that hold the client to the PHP and SQL it
// talks to, and the service worker to the modules the page imports.
//
// Run: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    LINE_COLOURS, nextLineColour, networkStats, tripInitials,
    parseRoute, routeHash, parseJoinFragment, placeFromNominatim,
    readExif, fitWithin, nextJpegQuality, isJustTaken, isUsableFix, resolvePhotoLocation, resolveTakenAt,
    groupByDay, toDmy, clockOf, dateSpan,
    opDeps, nextRunnable, classifyResponse, backoffMs, applyOutcome, rehome, mergePending, mergePendingTrips,
    MAX_ATTEMPTS, clusterPoints, splitMarkers, can, MAX_EDGE, LOC_SOURCES, labelsThatFit,
} from '../views/trips/logic.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ---- line colours ---------------------------------------------------

test('a first trip gets the first line colour', () => {
    assert.equal(nextLineColour([]), 'red');
});

test('a new trip takes the first colour no other trip is using', () => {
    const trips = [{ line: 'red' }, { line: 'green' }];
    assert.equal(nextLineColour(trips), 'blue');
});

test('once every colour is taken, the least used one comes round again', () => {
    const trips = LINE_COLOURS.map(c => ({ line: c.key }));
    trips.push({ line: 'red' }, { line: 'blue' });
    assert.equal(nextLineColour(trips), 'green');
});

test('every line colour has a readable bullet text colour', () => {
    for (const c of LINE_COLOURS) {
        assert.match(c.hex, /^#[0-9a-f]{6}$/);
        assert.ok(['#fbfaf6', '#1d1b18'].includes(c.text), `${c.key} text ${c.text}`);
    }
    // Yellow carries ink, like a real network's yellow line.
    assert.equal(LINE_COLOURS.find(c => c.key === 'yellow').text, '#1d1b18');
});

test('drift: the line colour keys match the PHP list', () => {
    const php = read('app/controllers/trips-controller.php');
    const m = php.match(/const LINE_COLOURS = \[([^\]]+)\]/);
    assert.ok(m, 'LINE_COLOURS not found in trips-controller.php');
    const phpKeys = [...m[1].matchAll(/'([a-z]+)'/g)].map(x => x[1]);
    assert.deepEqual(phpKeys, LINE_COLOURS.map(c => c.key));
});

// ---- the atlas count line --------------------------------------------

test('network stats count trips, places, photos and distinct countries', () => {
    const trips = [
        { photo_count: 12, places: [{ country_code: 'si' }, { country_code: 'si' }, { country_code: 'hr' }] },
        { photo_count: 3, places: [{ country_code: 'it' }, { country_code: null }] },
    ];
    assert.deepEqual(networkStats(trips), { trips: 2, places: 5, photos: 15, countries: 3 });
});

test('network stats of nothing are all zero', () => {
    assert.deepEqual(networkStats([]), { trips: 0, places: 0, photos: 0, countries: 0 });
});

test('trip initials are the first letters of the first two words', () => {
    assert.equal(tripInitials('Summer on the coast'), 'SO');
    assert.equal(tripInitials('slovenia'), 'S');
    assert.equal(tripInitials('  Škofja   Loka '), 'ŠL');
    assert.equal(tripInitials(''), '?');
});

// ---- routes ---------------------------------------------------------

const T = '0b7e1c2a-1111-4aaa-8bbb-000000000001';
const P = '0b7e1c2a-2222-4aaa-8bbb-000000000002';
const F = '0b7e1c2a-3333-4aaa-8bbb-000000000003';

test('an empty hash is the atlas', () => {
    assert.deepEqual(parseRoute(''), { screen: 'atlas' });
    assert.deepEqual(parseRoute('#/'), { screen: 'atlas' });
});

test('a trip, a place and a photo each have a route', () => {
    assert.deepEqual(parseRoute(`#/t/${T}`), { screen: 'trip', trip: T });
    assert.deepEqual(parseRoute(`#/t/${T}/p/${P}`), { screen: 'place', trip: T, place: P, view: 'map' });
    assert.deepEqual(parseRoute(`#/t/${T}/p/${P}/grid`), { screen: 'place', trip: T, place: P, view: 'grid' });
    assert.deepEqual(parseRoute(`#/t/${T}/p/${P}/f/${F}`), { screen: 'place', trip: T, place: P, view: 'map', photo: F });
});

test('a malformed route falls back to the atlas rather than a broken screen', () => {
    assert.deepEqual(parseRoute('#/t/not-a-uuid'), { screen: 'atlas' });
    assert.deepEqual(parseRoute(`#/t/${T}/p/nope`), { screen: 'trip', trip: T });
    assert.deepEqual(parseRoute('#/elsewhere'), { screen: 'atlas' });
});

test('routeHash writes what parseRoute reads', () => {
    assert.equal(routeHash({ screen: 'atlas' }), '#/');
    assert.equal(routeHash({ screen: 'trip', trip: T }), `#/t/${T}`);
    assert.equal(routeHash({ screen: 'place', trip: T, place: P, view: 'map' }), `#/t/${T}/p/${P}`);
    assert.equal(routeHash({ screen: 'place', trip: T, place: P, view: 'grid' }), `#/t/${T}/p/${P}/grid`);
    assert.equal(routeHash({ screen: 'place', trip: T, place: P, view: 'grid', photo: F }), `#/t/${T}/p/${P}/grid/f/${F}`);
});

test('an invite token is read only from a join fragment of 32 hex', () => {
    const tok = '0123456789abcdef0123456789abcdef';
    assert.equal(parseJoinFragment(`#join=${tok}`), tok);
    assert.equal(parseJoinFragment(`#join=${tok.toUpperCase()}`), tok);
    assert.equal(parseJoinFragment('#join=short'), null);
    assert.equal(parseJoinFragment(`#/t/${T}`), null);
    assert.equal(parseJoinFragment(''), null);
});

// ---- naming a place ---------------------------------------------------

test('a search hit becomes a station: its own name, position, country', () => {
    const hit = {
        name: 'Bled', lat: '46.3683', lon: '14.1146', display_name: 'Bled, Upravna enota Radovljica, Slovenija',
        address: { town: 'Bled', country: 'Slovenija', country_code: 'si' },
    };
    assert.deepEqual(placeFromNominatim(hit), {
        name: 'Bled', lat: 46.3683, lon: 14.1146, country_code: 'si', detail: 'Bled, Slovenija',
    });
});

test('a reverse lookup that lands on a road is named after its locality', () => {
    const hit = {
        name: '', lat: '45.5283', lon: '13.5683', display_name: 'Tartinijev trg, Piran, Slovenija',
        address: { road: 'Tartinijev trg', town: 'Piran', country: 'Slovenija', country_code: 'si' },
    };
    assert.equal(placeFromNominatim(hit).name, 'Piran');
});

test('a hit with no usable position is dropped', () => {
    assert.equal(placeFromNominatim({ name: 'Nowhere', lat: 'x', lon: '1' }), null);
    assert.equal(placeFromNominatim(null), null);
});

// ---- reading a photo's EXIF --------------------------------------------
//
// The buffers are built here byte by byte, so the expected values come from
// the EXIF spec and plain arithmetic, never from the parser under test.

/**
 * A minimal JPEG: SOI, an optional JFIF APP0, an APP1 Exif segment whose TIFF
 * body holds IFD0 (orientation and pointers), an Exif IFD (date, offset) and a
 * GPS IFD. `le` picks Intel (II) or Motorola (MM) byte order.
 */
function jpegWithExif({ le = true, gps = null, date = null, offset = null, orientation = null, jfif = false } = {}) {
    const tiff = [];
    const u16 = (v) => le ? [v & 255, v >> 8] : [v >> 8, v & 255];
    const u32 = (v) => le ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]
        : [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
    const ascii = (str) => [...Buffer.from(str + '\0', 'latin1')];

    // Lay the TIFF out as: header, IFD0, Exif IFD, GPS IFD, then data blobs.
    const ifd0Entries = [];
    if (orientation !== null) ifd0Entries.push({ tag: 0x0112, type: 3, count: 1, inline: [...u16(orientation), 0, 0] });
    const exifEntries = [];
    if (date !== null) exifEntries.push({ tag: 0x9003, type: 2, count: date.length + 1, data: ascii(date) });
    if (offset !== null) exifEntries.push({ tag: 0x9011, type: 2, count: offset.length + 1, data: ascii(offset) });
    const gpsEntries = [];
    if (gps) {
        const rat = (pairs) => pairs.flatMap(([n, d]) => [...u32(n), ...u32(d)]);
        gpsEntries.push({ tag: 0x0001, type: 2, count: 2, inline: [...ascii(gps.latRef), 0, 0] });
        gpsEntries.push({ tag: 0x0002, type: 5, count: 3, data: rat(gps.lat) });
        gpsEntries.push({ tag: 0x0003, type: 2, count: 2, inline: [...ascii(gps.lonRef), 0, 0] });
        gpsEntries.push({ tag: 0x0004, type: 5, count: 3, data: rat(gps.lon) });
    }
    if (exifEntries.length) ifd0Entries.push({ tag: 0x8769, type: 4, count: 1, pointer: 'exif' });
    if (gpsEntries.length) ifd0Entries.push({ tag: 0x8825, type: 4, count: 1, pointer: 'gps' });

    const ifdSize = (entries) => 2 + entries.length * 12 + 4;
    const at = { ifd0: 8 };
    at.exif = at.ifd0 + ifdSize(ifd0Entries);
    at.gps = at.exif + (exifEntries.length ? ifdSize(exifEntries) : 0);
    let dataAt = at.gps + (gpsEntries.length ? ifdSize(gpsEntries) : 0);

    const blobs = [];
    const writeIfd = (entries) => {
        tiff.push(...u16(entries.length));
        for (const e of entries) {
            tiff.push(...u16(e.tag), ...u16(e.type), ...u32(e.count));
            if (e.inline) tiff.push(...e.inline.slice(0, 4));
            else if (e.pointer) tiff.push(...u32(at[e.pointer]));
            else { tiff.push(...u32(dataAt)); blobs.push(e.data); dataAt += e.data.length; }
        }
        tiff.push(...u32(0));
    };
    tiff.push(...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8));
    writeIfd(ifd0Entries);
    if (exifEntries.length) writeIfd(exifEntries);
    if (gpsEntries.length) writeIfd(gpsEntries);
    for (const b of blobs) tiff.push(...b);

    const app1Body = [...Buffer.from('Exif\0\0', 'latin1'), ...tiff];
    const app1 = [0xff, 0xe1, (app1Body.length + 2) >> 8, (app1Body.length + 2) & 255, ...app1Body];
    const app0 = jfif ? [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0] : [];
    const bytes = new Uint8Array([0xff, 0xd8, ...app0, ...app1, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
    return bytes.buffer;
}

// 46 deg 21' 50.4" N = 46.364, 14 deg 6' 52.56" E = 14.1146 (Bled).
const BLED = { latRef: 'N', lat: [[46, 1], [21, 1], [504, 10]], lonRef: 'E', lon: [[14, 1], [6, 1], [5256, 100]] };
const near = (a, b) => Math.abs(a - b) < 1e-6;

test('EXIF: Intel byte order gives position, time, zone and orientation', () => {
    const exif = readExif(jpegWithExif({ le: true, gps: BLED, date: '2026:08:14 14:32:05', offset: '+02:00', orientation: 6 }));
    assert.ok(near(exif.lat, 46.364), `lat ${exif.lat}`);
    assert.ok(near(exif.lon, 14.1146), `lon ${exif.lon}`);
    assert.equal(exif.takenAt, '2026-08-14 14:32:05');
    assert.equal(exif.offsetMin, 120);
    assert.equal(exif.orientation, 6);
});

test('EXIF: Motorola byte order reads the same', () => {
    const exif = readExif(jpegWithExif({ le: false, gps: BLED, date: '2026:08:14 14:32:05', offset: '-03:30' }));
    assert.ok(near(exif.lat, 46.364) && near(exif.lon, 14.1146));
    assert.equal(exif.offsetMin, -210);
});

test('EXIF: south and west are negative', () => {
    // 22 deg 54' 30" S, 43 deg 10' 21" W (Rio): -22.908333, -43.1725
    const gps = { latRef: 'S', lat: [[22, 1], [54, 1], [30, 1]], lonRef: 'W', lon: [[43, 1], [10, 1], [21, 1]] };
    const exif = readExif(jpegWithExif({ gps }));
    assert.ok(near(exif.lat, -22.908333) || Math.abs(exif.lat + 22.9083333) < 1e-6, `lat ${exif.lat}`);
    assert.ok(Math.abs(exif.lon + 43.1725) < 1e-6, `lon ${exif.lon}`);
});

test('EXIF: found after a JFIF APP0 segment', () => {
    const exif = readExif(jpegWithExif({ jfif: true, gps: BLED }));
    assert.ok(near(exif.lat, 46.364));
});

test('EXIF: a photo with a date but no GPS has no position', () => {
    const exif = readExif(jpegWithExif({ date: '2026:08:14 09:00:00' }));
    assert.equal(exif.lat, null);
    assert.equal(exif.lon, null);
    assert.equal(exif.takenAt, '2026-08-14 09:00:00');
    assert.equal(exif.offsetMin, null);
});

test('EXIF: a zero denominator or a 0,0 fix is no position at all', () => {
    const zeroDen = { ...BLED, lat: [[46, 0], [21, 1], [504, 10]] };
    assert.equal(readExif(jpegWithExif({ gps: zeroDen })).lat, null);
    const nullIsland = { latRef: 'N', lat: [[0, 1], [0, 1], [0, 1]], lonRef: 'E', lon: [[0, 1], [0, 1], [0, 1]] };
    assert.equal(readExif(jpegWithExif({ gps: nullIsland })).lat, null);
});

test('EXIF: a blank camera date is no date', () => {
    assert.equal(readExif(jpegWithExif({ date: '0000:00:00 00:00:00' })).takenAt, null);
});

test('EXIF: not a JPEG, or no EXIF, is null and never a throw', () => {
    assert.equal(readExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).buffer), null);
    assert.equal(readExif(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]).buffer), null);
    assert.equal(readExif(new ArrayBuffer(0)), null);
});

test('EXIF: a truncated file never throws', () => {
    const full = new Uint8Array(jpegWithExif({ gps: BLED, date: '2026:08:14 14:32:05' }));
    for (let cut = 4; cut < full.length; cut += 7) {
        assert.doesNotThrow(() => readExif(full.slice(0, cut).buffer), `cut at ${cut}`);
    }
});

// ---- resizing ---------------------------------------------------------

test('a large photo is scaled to 2048 on its long edge', () => {
    assert.deepEqual(fitWithin(4032, 3024), { width: 2048, height: 1536, scale: 2048 / 4032 });
    assert.deepEqual(fitWithin(3024, 4032), { width: 1536, height: 2048, scale: 2048 / 4032 });
});

test('a photo already small enough is never upscaled', () => {
    assert.deepEqual(fitWithin(1600, 1200), { width: 1600, height: 1200, scale: 1 });
});

test('a sliver never rounds down to zero', () => {
    assert.equal(fitWithin(10000, 2).height, 1);
});

test('JPEG quality steps down to a floor, then gives up', () => {
    assert.equal(nextJpegQuality(0.82), 0.72);
    assert.equal(nextJpegQuality(0.72), 0.62);
    assert.equal(nextJpegQuality(0.62), 0.52);
    assert.equal(nextJpegQuality(0.52), null);
});

// ---- where and when a photo was taken ------------------------------------

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);
const PLACE = { lat: 46.3683, lon: 14.1146 };
const FIX = { lat: 46.3701, lon: 14.1102, accuracy: 18, timestamp: NOW - 30_000 };

test('a file modified a moment ago was just taken; an old one was not', () => {
    assert.equal(isJustTaken(NOW - 2 * 60_000, NOW), true);
    assert.equal(isJustTaken(NOW - 3 * 3600_000, NOW), false);
    // A clock far in the future is a broken clock, not a new photo.
    assert.equal(isJustTaken(NOW + 10 * 60_000, NOW), false);
    assert.equal(isJustTaken(undefined, NOW), false);
});

test('a position fix is usable only when fresh and tight', () => {
    assert.equal(isUsableFix(FIX, NOW), true);
    assert.equal(isUsableFix({ ...FIX, accuracy: 900 }, NOW), false);
    assert.equal(isUsableFix({ ...FIX, timestamp: NOW - 20 * 60_000 }, NOW), false);
    assert.equal(isUsableFix(null, NOW), false);
});

test('location: the photo\'s own GPS wins', () => {
    const r = resolvePhotoLocation({ exif: { lat: 46.364, lon: 14.1146 }, fix: FIX, place: PLACE, fileLastModified: NOW, now: NOW });
    assert.deepEqual(r, { lat: 46.364, lon: 14.1146, source: 'exif', approximate: false });
});

test('location: a photo just taken with no GPS uses where you are', () => {
    const r = resolvePhotoLocation({ exif: { lat: null, lon: null }, fix: FIX, place: PLACE, fileLastModified: NOW - 5_000, now: NOW });
    assert.deepEqual(r, { lat: 46.3701, lon: 14.1102, source: 'device', approximate: false });
});

test('location: an old gallery photo with no GPS sits at the place, flagged approximate', () => {
    const r = resolvePhotoLocation({ exif: null, fix: FIX, place: PLACE, fileLastModified: NOW - 86400_000, now: NOW });
    assert.deepEqual(r, { lat: 46.3683, lon: 14.1146, source: 'place', approximate: true });
});

test('location: a photo taken in the app counts as just taken whatever its file says', () => {
    const r = resolvePhotoLocation({ exif: null, fix: FIX, place: PLACE, fileLastModified: 0, now: NOW, capturedInApp: true });
    assert.equal(r.source, 'device');
});

test('location: a stale or loose fix falls back to the place', () => {
    const r = resolvePhotoLocation({ exif: null, fix: { ...FIX, accuracy: 2000 }, place: PLACE, fileLastModified: NOW, now: NOW });
    assert.equal(r.source, 'place');
});

test('time: the camera clock wins, with its zone', () => {
    assert.deepEqual(
        resolveTakenAt({ exif: { takenAt: '2026-08-14 14:32:05', offsetMin: 120 }, fileLastModified: NOW, tzOffsetMin: 60 }),
        { takenAt: '2026-08-14 14:32:05', offsetMin: 120 });
});

test('time: without EXIF, the file time in the phone\'s own zone', () => {
    // 12:00 UTC seen from UTC+2 is 14:00 on the wall clock.
    assert.deepEqual(resolveTakenAt({ exif: null, fileLastModified: NOW, tzOffsetMin: 120 }),
        { takenAt: '2026-08-14 14:00:00', offsetMin: 120 });
});

test('time: no EXIF and no file time is no time', () => {
    assert.deepEqual(resolveTakenAt({ exif: null, fileLastModified: 0, tzOffsetMin: 120 }), { takenAt: null, offsetMin: null });
});

// ---- the grid: a timetable of photos ------------------------------------

test('photos group by the day they were taken, oldest day first, undated last', () => {
    const photos = [
        { uuid: 'c', taken_at: '2026-08-15 09:10:00' },
        { uuid: 'x', taken_at: null },
        { uuid: 'a', taken_at: '2026-08-14 18:02:00' },
        { uuid: 'b', taken_at: '2026-08-14 07:45:30' },
    ];
    assert.deepEqual(groupByDay(photos).map(g => [g.day, g.photos.map(p => p.uuid)]), [
        ['2026-08-14', ['b', 'a']],
        ['2026-08-15', ['c']],
        [null, ['x']],
    ]);
});

test('no photos is no groups', () => {
    assert.deepEqual(groupByDay([]), []);
});

test('dates print day first and clocks as hh:mm', () => {
    assert.equal(toDmy('2026-08-14'), '14.08.2026');
    assert.equal(toDmy('2026-08-14 07:45:30'), '14.08.2026');
    assert.equal(toDmy(null), '');
    assert.equal(clockOf('2026-08-14 07:45:30'), '07:45');
    assert.equal(clockOf(null), '');
});

test('a date span reads as one day or first to last', () => {
    assert.equal(dateSpan([]), '');
    assert.equal(dateSpan([{ taken_at: '2026-08-14 10:00:00' }, { taken_at: null }]), '14.08.2026');
    assert.equal(dateSpan([{ taken_at: '2026-08-16 10:00:00' }, { taken_at: '2026-08-14 09:00:00' }]), '14.08.2026 to 16.08.2026');
});

// ---- the offline outbox ----------------------------------------------------
//
// Creates made without signal wait here in order. A place waits for its trip,
// a photo for its place; the server's answer decides done, retry, pause, or
// ask the person.

const TRIP = 'aaaaaaaa-0000-4000-8000-000000000001';
const PL = 'aaaaaaaa-0000-4000-8000-000000000002';
const PH1 = 'aaaaaaaa-0000-4000-8000-000000000003';
const PH2 = 'aaaaaaaa-0000-4000-8000-000000000004';
const op = (seq, kind, uuid, extra = {}) => ({
    seq, kind, uuid, userId: 7, state: 'pending', attempts: 0, nextAt: 0, ...extra,
});

test('a place waits for its trip, a photo for its place', () => {
    assert.deepEqual(opDeps(op(1, 'trip', TRIP)), []);
    assert.deepEqual(opDeps(op(2, 'place', PL, { trip: TRIP })), [TRIP]);
    assert.deepEqual(opDeps(op(3, 'photo', PH1, { trip: TRIP, place: PL })), [PL]);
});

test('the next op is the oldest one that is due and has nothing to wait for', () => {
    const ops = [
        op(3, 'photo', PH1, { trip: TRIP, place: PL }),
        op(2, 'place', PL, { trip: TRIP }),
    ];
    assert.equal(nextRunnable(ops, { now: 1000, viewerId: 7 }).seq, 2);
    // Once the place is done the photo is free to go.
    assert.equal(nextRunnable([ops[0]], { now: 1000, viewerId: 7 }).seq, 3);
});

test('an op still backing off is not due yet', () => {
    const ops = [op(1, 'photo', PH1, { place: PL, nextAt: 5000 })];
    assert.equal(nextRunnable(ops, { now: 1000, viewerId: 7 }), null);
    assert.equal(nextRunnable(ops, { now: 5000, viewerId: 7 }).seq, 1);
});

test('only the signed-in person\'s own ops are sent', () => {
    const ops = [op(1, 'photo', PH1, { place: PL, userId: 9 })];
    assert.equal(nextRunnable(ops, { now: 0, viewerId: 7 }), null);
});

test('stalled, failed and orphaned ops wait for the person, not the timer', () => {
    for (const state of ['stalled', 'failed', 'orphaned', 'blocked']) {
        assert.equal(nextRunnable([op(1, 'place', PL, { trip: TRIP, state })], { now: 0, viewerId: 7 }), null, state);
    }
});

test('one photo over the quota holds back every photo, but places still go', () => {
    const ops = [
        op(1, 'photo', PH1, { place: 'elsewhere', state: 'blocked' }),
        op(2, 'photo', PH2, { place: 'elsewhere' }),
        op(3, 'place', PL, { trip: TRIP }),
    ];
    assert.equal(nextRunnable(ops, { now: 0, viewerId: 7 }).seq, 3);
});

// Every answer the controller can give, and what the outbox does with it. The
// drift test below fails when the PHP grows a code this table does not decide.
const OUTCOMES = [
    [{ status: 201 }, 'done'],
    [{ status: 200 }, 'done'],
    [{ offline: true, status: 0 }, 'retry'],
    [{ status: 500, code: 'server' }, 'retry'],
    [{ status: 503 }, 'retry'],
    [{ status: 429 }, 'retry'],
    [{ status: 408 }, 'retry'],
    [{ status: 401 }, 'auth'],
    [{ status: 507, code: 'quota' }, 'blocked'],
    [{ status: 410, code: 'gone' }, 'gone'],
    [{ status: 410, code: 'place_gone' }, 'orphaned'],
    [{ status: 410, code: 'trip_gone' }, 'orphaned'],
    [{ status: 404, code: 'not_found' }, 'orphaned'],
    [{ status: 409, code: 'conflict' }, 'failed'],
    [{ status: 409, code: 'full' }, 'failed'],
    [{ status: 409, code: 'stale_order' }, 'failed'],
    [{ status: 413, code: 'too_large' }, 'failed'],
    [{ status: 415, code: 'unsupported_type' }, 'failed'],
    [{ status: 422, code: 'bad_image' }, 'failed'],
    [{ status: 422, code: 'invalid' }, 'failed'],
    [{ status: 403, code: 'client_header' }, 'failed'],
    [{ status: 403, code: 'forbidden' }, 'failed'],
    [{ status: 400, code: 'invalid' }, 'failed'],
];

test('the server\'s answer decides what happens next', () => {
    for (const [res, want] of OUTCOMES) assert.equal(classifyResponse(res), want, JSON.stringify(res));
});

test('drift: every status and code the controller sends has a decided outcome', () => {
    const php = read('app/controllers/trips-controller.php');
    const sent = new Set([...php.matchAll(/sendError\([^;]*?,\s*(\d{3}),\s*'([a-z_]+)'\)/g)].map(m => `${m[1]}:${m[2]}`));
    sent.add('404:not_found'); // notFound()
    assert.ok(sent.size > 10, `only found ${sent.size} codes; did the sendError shape change?`);
    const decided = new Set(OUTCOMES.map(([r]) => `${r.status}:${r.code}`));
    for (const pair of sent) assert.ok(decided.has(pair), `${pair} is sent by the PHP but has no outcome in OUTCOMES`);
});

test('drift: the photo size the app sends fits under the server\'s limit', () => {
    const php = read('app/controllers/trips-controller.php');
    const serverMax = Number(php.match(/const MAX_EDGE = (\d+);/)[1]);
    assert.ok(MAX_EDGE <= serverMax, `client ${MAX_EDGE} > server ${serverMax}`);
});

test('drift: the location sources agree across SQL, PHP and JS', () => {
    const sql = read('app/models/trips-model.sql').match(/loc_source ENUM\(([^)]+)\)/)[1];
    const php = read('app/controllers/trips-controller.php').match(/const LOC_SOURCES = \[([^\]]+)\]/)[1];
    const keys = (txt) => [...txt.matchAll(/'([a-z]+)'/g)].map(m => m[1]);
    assert.deepEqual(keys(sql), LOC_SOURCES);
    assert.deepEqual(keys(php), LOC_SOURCES);
});

test('retries back off from 5 seconds, doubling, capped at 15 minutes, with jitter', () => {
    assert.equal(backoffMs(0, 0.5), 5000);
    assert.equal(backoffMs(1, 0.5), 10000);
    assert.equal(backoffMs(3, 0.5), 40000);
    assert.equal(backoffMs(20, 0.5), 15 * 60_000);
    assert.equal(backoffMs(0, 0), 3750);
    assert.equal(backoffMs(0, 1), 6250);
});

test('done or gone takes the op off the queue', () => {
    const ops = [op(1, 'photo', PH1, { place: PL })];
    for (const outcome of ['done', 'gone']) {
        const r = applyOutcome(ops, 1, outcome, 0, 0.5);
        assert.deepEqual(r.ops, []);
        assert.deepEqual(r.removed, [PH1]);
    }
});

test('a retry is rescheduled, and stalls after too many tries', () => {
    let ops = [op(1, 'photo', PH1, { place: PL })];
    ops = applyOutcome(ops, 1, 'retry', 1000, 0.5).ops;
    assert.equal(ops[0].attempts, 1);
    assert.equal(ops[0].nextAt, 1000 + 5000);
    assert.equal(ops[0].state, 'pending');
    ops = [op(1, 'photo', PH1, { place: PL, attempts: MAX_ATTEMPTS - 1 })];
    assert.equal(applyOutcome(ops, 1, 'retry', 0, 0.5).ops[0].state, 'stalled');
});

test('a place that cannot be created takes its waiting photos with it', () => {
    const ops = [
        op(1, 'place', PL, { trip: TRIP }),
        op(2, 'photo', PH1, { trip: TRIP, place: PL }),
        op(3, 'photo', PH2, { trip: TRIP, place: 'other-place' }),
    ];
    const r = applyOutcome(ops, 1, 'orphaned', 0, 0.5).ops;
    assert.deepEqual(r.map(o => o.state), ['orphaned', 'orphaned', 'pending']);
    const f = applyOutcome(ops, 1, 'failed', 0, 0.5).ops;
    assert.deepEqual(f.map(o => o.state), ['failed', 'orphaned', 'pending']);
});

test('an auth pause leaves the op exactly as it was', () => {
    const ops = [op(1, 'photo', PH1, { place: PL })];
    assert.deepEqual(applyOutcome(ops, 1, 'auth', 0, 0.5).ops, ops);
});

test('photos stranded by a deleted place can be moved to another one', () => {
    const ops = [
        op(2, 'photo', PH1, { trip: TRIP, place: PL, state: 'orphaned', attempts: 3, nextAt: 99 }),
        op(3, 'photo', PH2, { trip: TRIP, place: PL, state: 'orphaned' }),
    ];
    const moved = rehome(ops, [PH1], 'new-place', 'new-trip');
    assert.deepEqual(moved[0], { ...ops[0], place: 'new-place', trip: 'new-trip', state: 'pending', attempts: 0, nextAt: 0 });
    assert.deepEqual(moved[1], ops[1]);
});

test('queued places and photos show up in the trip they belong to, marked pending', () => {
    const tree = {
        trip: { uuid: TRIP },
        places: [{ uuid: 'p0', name: 'Ljubljana' }],
        photos: [{ uuid: 'ph0', place: 'p0' }],
    };
    const ops = [
        op(1, 'place', PL, { trip: TRIP, body: { uuid: PL, trip: TRIP, name: 'Bled', lat: 46.3, lon: 14.1 } }),
        op(2, 'photo', PH1, { trip: TRIP, place: PL, body: { uuid: PH1, place: PL, lat: 46.3, lon: 14.1, loc_source: 'device', taken_at: null } }),
        op(3, 'photo', PH2, { trip: 'another-trip', place: 'x', body: { uuid: PH2, place: 'x' } }),
        // Already on the server: the server's copy wins.
        op(4, 'photo', 'ph0', { trip: TRIP, place: 'p0', body: { uuid: 'ph0', place: 'p0' } }),
    ];
    const view = mergePending(tree, ops);
    assert.deepEqual(view.places.map(p => [p.uuid, !!p.pending]), [['p0', false], [PL, true]]);
    assert.deepEqual(view.photos.map(p => [p.uuid, !!p.pending]), [['ph0', false], [PH1, true]]);
    assert.equal(view.photos[1].state, 'pending');
    assert.equal(tree.places.length, 1, 'the snapshot itself is not touched');
});

test('a trip started offline is in the atlas, marked pending', () => {
    const trips = [{ uuid: 'old', name: 'Old', places: [] }];
    const ops = [op(1, 'trip', TRIP, { body: { uuid: TRIP, name: 'New', line: 'blue' } })];
    const view = mergePendingTrips(trips, ops);
    assert.deepEqual(view.map(t => [t.uuid, !!t.pending]), [[TRIP, true], ['old', false]]);
    assert.equal(view[0].role, 'owner');
});

// ---- photos on the map --------------------------------------------------

test('photos with no location of their own are counted on the station, not pinned', () => {
    const photos = [
        { uuid: 'a', loc_source: 'exif' }, { uuid: 'b', loc_source: 'place' },
        { uuid: 'c', loc_source: 'device' }, { uuid: 'd', loc_source: 'manual' },
    ];
    const { exact, approximate } = splitMarkers(photos);
    assert.deepEqual(exact.map(p => p.uuid), ['a', 'c', 'd']);
    assert.deepEqual(approximate.map(p => p.uuid), ['b']);
});

test('photos taken on the same spot become one cluster', () => {
    const pts = [{ uuid: 'a', lat: 46.3683, lon: 14.1146 }, { uuid: 'b', lat: 46.3683, lon: 14.1146 }];
    const c = clusterPoints(pts, 15);
    assert.equal(c.length, 1);
    assert.deepEqual(c[0].members.map(p => p.uuid), ['a', 'b']);
    assert.ok(Math.abs(c[0].lat - 46.3683) < 1e-9 && Math.abs(c[0].lon - 14.1146) < 1e-9);
});

test('photos in different towns stay apart close up and merge from far away', () => {
    // Bled and Bohinj are about 19 km apart.
    const pts = [{ uuid: 'bled', lat: 46.3683, lon: 14.1146 }, { uuid: 'bohinj', lat: 46.2836, lon: 13.8869 }];
    assert.equal(clusterPoints(pts, 13).length, 2);
    assert.equal(clusterPoints(pts, 4).length, 1);
});

test('a cluster sits at the middle of its members', () => {
    const pts = [{ uuid: 'a', lat: 46.0, lon: 14.0 }, { uuid: 'b', lat: 46.001, lon: 14.001 }];
    const [c] = clusterPoints(pts, 3);
    assert.ok(Math.abs(c.lat - 46.0005) < 1e-9 && Math.abs(c.lon - 14.0005) < 1e-9);
});

test('no photos is no clusters', () => {
    assert.deepEqual(clusterPoints([], 10), []);
});

// ---- who may do what ------------------------------------------------------
//
// The controller is the authority; this only decides which controls to offer.

test('the owner may do everything to their trip', () => {
    for (const action of ['add', 'editPhoto', 'deletePhoto', 'editPlace', 'deletePlace', 'manage']) {
        assert.equal(can('owner', action, { mine: false }), true, action);
    }
    assert.equal(can('owner', 'leave'), false);
});

test('a traveller adds, and edits or deletes only what they added', () => {
    assert.equal(can('traveller', 'add'), true);
    assert.equal(can('traveller', 'deletePhoto', { mine: true }), true);
    assert.equal(can('traveller', 'deletePhoto', { mine: false }), false);
    assert.equal(can('traveller', 'editPhoto', { mine: false }), false);
    assert.equal(can('traveller', 'editPlace', { mine: true }), true);
    assert.equal(can('traveller', 'deletePlace', { mine: true }), false);
    assert.equal(can('traveller', 'manage'), false);
    assert.equal(can('traveller', 'leave'), true);
});

test('a showcase visitor only looks', () => {
    for (const action of ['add', 'editPhoto', 'deletePhoto', 'editPlace', 'deletePlace', 'manage', 'leave']) {
        assert.equal(can('viewer', action, { mine: true }), false, action);
    }
});

// ---- the offline shell ------------------------------------------------------

test('drift: every file the page needs offline is in the service worker\'s precache', () => {
    const sw = read('views/trips/sw.js');
    const shell = new Set([...sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]));
    const base = 'views/trips/';
    const rel = (repoPath) => {
        // A repo path back to how the service worker names it, relative to views/trips/.
        if (repoPath.startsWith(base)) return repoPath.slice(base.length);
        if (repoPath.startsWith('views/')) return '../' + repoPath.slice('views/'.length);
        return '../../' + repoPath;
    };
    const resolve = (from, spec) => {
        const parts = (dirname(from) + '/' + spec).split('/');
        const out = [];
        for (const p of parts) {
            if (p === '..') out.pop();
            else if (p !== '.' && p !== '') out.push(p);
        }
        return out.join('/');
    };

    // Every module reachable from script.js.
    const seen = new Set();
    const walk = (file) => {
        if (seen.has(file)) return;
        seen.add(file);
        for (const m of read(file).matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) walk(resolve(file, m[1]));
    };
    walk(base + 'script.js');

    // Every local script and stylesheet the page loads itself.
    const html = read(base + 'index.html');
    for (const m of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"#]+)"/g)) {
        const u = m[1];
        if (/^https?:|^\/\//.test(u) || u === './manifest.json') continue;
        if (u.startsWith('../../components/google-analytics') || u.startsWith('../../components/consent')) continue;
        seen.add(resolve(base + 'index.html', u));
    }

    // And the Overpass faces, since the page is set in nothing else.
    const fonts = read('assets/fonts/fonts.css');
    for (const m of fonts.matchAll(/url\((files\/overpass[^)]+)\)/g)) seen.add('assets/fonts/' + m[1]);

    const missing = [...seen].map(rel).filter(p => !shell.has(p));
    assert.deepEqual(missing, [], `not precached: ${missing.join(', ')}`);
});

// ---- station names on the map ------------------------------------------------

test('station names that would overlap give way to the ones placed first', () => {
    const boxes = [
        { x: 100, y: 100, w: 60, h: 16 },   // Bled, the selected station: placed first
        { x: 110, y: 104, w: 70, h: 16 },   // Vintgar, right on top of it
        { x: 300, y: 100, w: 60, h: 16 },   // Piran, far away
    ];
    assert.deepEqual(labelsThatFit(boxes), [true, false, true]);
});

test('names a hair apart still count as touching', () => {
    assert.deepEqual(labelsThatFit([{ x: 0, y: 0, w: 50, h: 16 }, { x: 51, y: 0, w: 50, h: 16 }]), [true, false]);
    assert.deepEqual(labelsThatFit([{ x: 0, y: 0, w: 50, h: 16 }, { x: 60, y: 0, w: 50, h: 16 }]), [true, true]);
});
