// Tests for views/nebo/logic.js, the celestial mechanics behind the sky chart.
// Anchors are published values: Meeus's GMST example, Schlyter's worked Sun
// example, and real eclipses/oppositions (an eclipse is an exact new or full
// moon, an opposition an exact 180 degree elongation), so nothing here is
// eyeballed from our own output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    julianDay, schlyterD, gmst, lst, raDecToAltAz, project,
    sunPosition, moonPosition, moonPhase, moonTopocentricAlt, phaseName,
    planetPosition, planetPositions, elongation,
    twilightKind, skyDarkness, magnitudeLimit, riseSet,
    parseStars, bvToColor, norm360,
} from '../views/nebo/logic.js';

const LJUBLJANA = { lat: 46.0569, lon: 14.5058 };
const utc = (...args) => new Date(Date.UTC(...args));
const dOf = (date) => schlyterD(julianDay(date));

test('julianDay: J2000 epoch', () => {
    assert.equal(julianDay(utc(2000, 0, 1, 12)), 2451545.0);
});

test('schlyterD: 1990-04-19 00:00 UT is exactly -3543 (Schlyter worked example)', () => {
    assert.equal(dOf(utc(1990, 3, 19)), -3543);
});

test('gmst: Meeus example 12.a, 1987-04-10 00:00 UT', () => {
    // Meeus: GMST = 13h 10m 46.3668s = 197.693195 degrees
    assert.ok(Math.abs(gmst(julianDay(utc(1987, 3, 10))) - 197.693195) < 0.01);
});

test('sun: Schlyter worked example, 1990-04-19 00:00 UT', () => {
    const sun = sunPosition(-3543);
    // His published result: RA 26.6580, Decl 11.0084
    assert.ok(Math.abs(sun.ra - 26.658) < 0.05, `ra ${sun.ra}`);
    assert.ok(Math.abs(sun.dec - 11.0084) < 0.05, `dec ${sun.dec}`);
});

test('sun: March 2025 equinox crosses the equator', () => {
    const sun = sunPosition(dOf(utc(2025, 2, 20, 9, 1)));
    assert.ok(Math.abs(sun.dec) < 0.05, `dec ${sun.dec}`);
    const ra = sun.ra > 180 ? sun.ra - 360 : sun.ra;
    assert.ok(Math.abs(ra) < 0.5, `ra ${sun.ra}`);
});

test('sun: June 2025 solstice sits at maximum declination', () => {
    const sun = sunPosition(dOf(utc(2025, 5, 21, 2, 42)));
    assert.ok(Math.abs(sun.dec - 23.437) < 0.05, `dec ${sun.dec}`);
});

test('moon: total lunar eclipse 2025-03-14 06:59 UT is an exact full moon', () => {
    const d = dOf(utc(2025, 2, 14, 6, 59));
    const phase = moonPhase(d);
    assert.ok(phase.elongation > 178.5, `elongation ${phase.elongation}`);
    assert.ok(phase.illumination > 0.995, `illumination ${phase.illumination}`);
    assert.equal(phase.name, 'Full Moon');
});

test('moon: total solar eclipse 2024-04-08 18:18 UT is an exact new moon', () => {
    const phase = moonPhase(dOf(utc(2024, 3, 8, 18, 18)));
    assert.ok(phase.elongation < 1.5, `elongation ${phase.elongation}`);
    assert.ok(phase.illumination < 0.005, `illumination ${phase.illumination}`);
    assert.equal(phase.name, 'New Moon');
});

test('moon: distance and latitude stay physical across a year', () => {
    for (let day = 0; day < 366; day += 3) {
        const m = moonPosition(dOf(utc(2025, 0, 1)) + day);
        assert.ok(m.rEarthRadii > 54 && m.rEarthRadii < 64.5, `r ${m.rEarthRadii} at +${day}d`);
        assert.ok(Math.abs(m.latEcl) < 5.6, `lat ${m.latEcl} at +${day}d`);
    }
});

test('moon: topocentric correction lowers by about one degree at the horizon', () => {
    const corrected = moonTopocentricAlt(0, 60.27);
    assert.ok(corrected < -0.9 && corrected > -1.0, `${corrected}`);
    assert.ok(Math.abs(moonTopocentricAlt(90, 60.27) - 90) < 1e-9);
});

test('planets: Jupiter opposition 2024-12-07', () => {
    const d = dOf(utc(2024, 11, 7, 12));
    const e = elongation(planetPosition('jupiter', d).lonEcl, sunPosition(d).lonEcl);
    assert.ok(e > 177, `elongation ${e}`);
});

test('planets: Mars opposition 2025-01-16', () => {
    const d = dOf(utc(2025, 0, 16, 12));
    const e = elongation(planetPosition('mars', d).lonEcl, sunPosition(d).lonEcl);
    assert.ok(e > 175, `elongation ${e}`);
});

test('planets: Saturn opposition 2024-09-08', () => {
    const d = dOf(utc(2024, 8, 8, 12));
    const e = elongation(planetPosition('saturn', d).lonEcl, sunPosition(d).lonEcl);
    assert.ok(e > 177, `elongation ${e}`);
});

test('planets: inner planets never stray past max elongation', () => {
    const d0 = dOf(utc(2020, 0, 1));
    for (let day = 0; day < 8 * 365; day += 10) {
        const sun = sunPosition(d0 + day);
        const venus = elongation(planetPosition('venus', d0 + day).lonEcl, sun.lonEcl);
        const mercury = elongation(planetPosition('mercury', d0 + day).lonEcl, sun.lonEcl);
        assert.ok(venus < 48.7, `venus ${venus} at +${day}d`);
        assert.ok(mercury < 29, `mercury ${mercury} at +${day}d`);
    }
});

test('planetPositions returns all five naked-eye planets', () => {
    const list = planetPositions(0);
    assert.deepEqual(list.map((p) => p.key), ['mercury', 'venus', 'mars', 'jupiter', 'saturn']);
    for (const p of list) {
        assert.ok(p.ra >= 0 && p.ra < 360 && Math.abs(p.dec) < 90);
    }
});

test('alt/az: Polaris hangs at the latitude, due north, from Ljubljana', () => {
    const polaris = { ra: 37.955, dec: 89.264 };
    for (const date of [utc(2025, 0, 15, 22), utc(2025, 6, 15, 2), utc(2026, 3, 1, 20)]) {
        const { alt, az } = raDecToAltAz(polaris.ra, polaris.dec,
            lst(julianDay(date), LJUBLJANA.lon), LJUBLJANA.lat);
        assert.ok(Math.abs(alt - LJUBLJANA.lat) < 1, `alt ${alt}`);
        const azN = az > 180 ? az - 360 : az;
        assert.ok(Math.abs(azN) < 1.5, `az ${az}`);
    }
});

test('projection: zenith center, horizon rim, planisphere east on the left', () => {
    const zenith = project(90, 123, 100);
    assert.ok(Math.abs(zenith.x) < 1e-9 && Math.abs(zenith.y) < 1e-9);
    const north = project(0, 0, 100);
    assert.ok(Math.abs(north.x) < 1e-9 && Math.abs(north.y + 100) < 1e-6);
    const east = project(0, 90, 100);
    assert.ok(Math.abs(east.x + 100) < 1e-6 && Math.abs(east.y) < 1e-9);
    const south = project(0, 180, 100);
    assert.ok(Math.abs(south.y - 100) < 1e-6);
});

test('twilight bands and darkness curve', () => {
    assert.equal(twilightKind(10), 'day');
    assert.equal(twilightKind(-3), 'civil');
    assert.equal(twilightKind(-8), 'nautical');
    assert.equal(twilightKind(-15), 'astronomical');
    assert.equal(twilightKind(-25), 'night');
    assert.equal(skyDarkness(5), 0);
    assert.equal(skyDarkness(-18), 1);
    assert.equal(skyDarkness(-30), 1);
    const mid = skyDarkness(-9);
    assert.ok(mid > 0.4 && mid < 0.6);
    assert.ok(skyDarkness(-4) < skyDarkness(-8));
    assert.equal(magnitudeLimit(0, 5), -1);
    assert.equal(magnitudeLimit(1, 5), 5);
});

test('riseSet: Ljubljana summer solstice sun times', () => {
    const sunAlt = (date) => {
        const jd = julianDay(date);
        const sun = sunPosition(schlyterD(jd));
        return raDecToAltAz(sun.ra, sun.dec, lst(jd, LJUBLJANA.lon), LJUBLJANA.lat).alt;
    };
    const { rise, set, alwaysUp } = riseSet(sunAlt, utc(2025, 5, 21));
    assert.ok(!alwaysUp && rise && set);
    // Published times for Ljubljana: sunrise 05:11, sunset 20:56 CEST (UTC+2)
    const riseH = (rise.getTime() - utc(2025, 5, 21).getTime()) / 3600000;
    const setH = (set.getTime() - utc(2025, 5, 21).getTime()) / 3600000;
    assert.ok(Math.abs(riseH - 3.18) < 0.25, `rise ${riseH}h UT`);
    assert.ok(Math.abs(setH - 18.93) < 0.25, `set ${setH}h UT`);
    const dayLength = setH - riseH;
    assert.ok(dayLength > 15.4 && dayLength < 16.1, `day ${dayLength}h`);
});

test('riseSet: midnight sun above the arctic circle', () => {
    const sunAlt = (date) => {
        const jd = julianDay(date);
        const sun = sunPosition(schlyterD(jd));
        return raDecToAltAz(sun.ra, sun.dec, lst(jd, 18.96), 69.65).alt;
    };
    const { alwaysUp } = riseSet(sunAlt, utc(2025, 5, 21));
    assert.ok(alwaysUp);
});

test('phaseName covers the wheel', () => {
    assert.equal(phaseName(0.01, true), 'New Moon');
    assert.equal(phaseName(0.99, true), 'Full Moon');
    assert.equal(phaseName(0.5, true), 'First Quarter');
    assert.equal(phaseName(0.5, false), 'Last Quarter');
    assert.equal(phaseName(0.2, true), 'Waxing Crescent');
    assert.equal(phaseName(0.2, false), 'Waning Crescent');
    assert.equal(phaseName(0.8, true), 'Waxing Gibbous');
    assert.equal(phaseName(0.8, false), 'Waning Gibbous');
});

test('norm360 wraps negatives', () => {
    assert.equal(norm360(-30), 330);
    assert.equal(norm360(370), 10);
    assert.equal(norm360(0), 0);
});

test('star catalog: shipped data holds the anchor stars', () => {
    const json = JSON.parse(readFileSync(new URL('../views/nebo/stars.json', import.meta.url), 'utf8'));
    const stars = parseStars(json);
    assert.ok(stars.length > 1500 && stars.length < 1800, `${stars.length} stars`);
    const sirius = stars.find((s) => s.name === 'Sirius');
    assert.ok(sirius && Math.abs(sirius.ra - 101.287) < 0.01 && Math.abs(sirius.dec + 16.716) < 0.01);
    assert.equal(sirius.mag, -1.44);
    const polaris = stars.find((s) => s.name === 'Polaris');
    assert.ok(polaris && polaris.dec > 89);
    // brightest-first ordering lets the renderer slice by magnitude
    for (let i = 1; i < stars.length; i++) assert.ok(stars[i].mag >= stars[i - 1].mag);
});

test('constellation catalog: 89 figures with lines and names', () => {
    const json = JSON.parse(readFileSync(new URL('../views/nebo/constellations.json', import.meta.url), 'utf8'));
    assert.equal(json.constellations.length, 89);
    const orion = json.constellations.find((c) => c.id === 'Ori');
    assert.ok(orion && orion.name === 'Orion' && orion.lines.length > 0 && orion.label);
});

test('bvToColor: hot stars blue, cool stars orange', () => {
    const hot = bvToColor(-0.3).match(/\d+/g).map(Number);
    const cool = bvToColor(1.6).match(/\d+/g).map(Number);
    assert.ok(hot[2] > hot[0], `hot ${hot}`);
    assert.ok(cool[0] > cool[2], `cool ${cool}`);
    assert.ok(/^rgb\(\d+,\d+,\d+\)$/.test(bvToColor(0.5)));
});
