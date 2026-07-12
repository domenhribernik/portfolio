// Tests for views/nebo/geo.js, the pure helpers behind the location picker:
// coordinate math and the parsing of OpenStreetMap/Nominatim responses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampLat, wrapLon, formatCoords, placeLabel, parseSearchResult } from '../views/nebo/geo.js';

test('clampLat: holds latitude inside the map projection band', () => {
    assert.equal(clampLat(10), 10);
    assert.equal(clampLat(90), 85.05);
    assert.equal(clampLat(-91), -85.05);
});

test('wrapLon: folds a dragged world map into [-180, 180)', () => {
    assert.equal(wrapLon(14.5), 14.5);
    assert.equal(wrapLon(200), -160);
    assert.equal(wrapLon(-190), 170);
    assert.equal(wrapLon(180), -180);
});

test('formatCoords: signs become cardinal letters', () => {
    assert.equal(formatCoords(46.0569, 14.5058), '46.06° N · 14.51° E');
    assert.equal(formatCoords(-33.8688, 151.2093), '33.87° S · 151.21° E');
    assert.equal(formatCoords(40.7128, -74.006, ['N', 'S', 'E', 'W']), '40.71° N · 74.01° W');
});

test('formatCoords: honours translated cardinals', () => {
    assert.equal(formatCoords(46.06, 14.51, ['S', 'J', 'V', 'Z']), '46.06° S · 14.51° V');
});

test('placeLabel: prefers the most local named place, plus country', () => {
    const result = { address: { city: 'Ljubljana', county: 'Osrednjeslovenska', country: 'Slovenia' } };
    assert.equal(placeLabel(result), 'Ljubljana, Slovenia');
});

test('placeLabel: falls back through village, state, then display_name', () => {
    assert.equal(placeLabel({ address: { village: 'Bohinj', country: 'Slovenia' } }), 'Bohinj, Slovenia');
    assert.equal(placeLabel({ address: { state: 'Bavaria', country: 'Germany' } }), 'Bavaria, Germany');
    assert.equal(placeLabel({ display_name: 'Somewhere, Middle, Nowhere Land' }), 'Somewhere, Nowhere Land');
    assert.equal(placeLabel(null, 'the pin'), 'the pin');
});

test('parseSearchResult: takes the first hit with usable coordinates', () => {
    const list = [
        { lat: 'not-a-number', lon: '5', display_name: 'junk' },
        { lat: '48.8566', lon: '2.3522', display_name: 'Paris, France', address: { city: 'Paris', country: 'France' } },
    ];
    const hit = parseSearchResult(list);
    assert.equal(hit.lat, 48.8566);
    assert.equal(hit.lon, 2.3522);
    assert.equal(hit.label, 'Paris, France');
});

test('parseSearchResult: empty or non-array input is null', () => {
    assert.equal(parseSearchResult([]), null);
    assert.equal(parseSearchResult(undefined), null);
});
