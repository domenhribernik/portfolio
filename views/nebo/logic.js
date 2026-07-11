// Pure, DOM-free celestial mechanics for the Nebo sky chart. Imported by the
// page (render.js / script.js) and by tests/nebo-logic.test.mjs.
//
// Sun, Moon and planet positions follow Paul Schlyter's low-precision
// algorithms ("How to compute planetary positions", stjarnhimlen.se), good to
// a few arcminutes: far below one pixel on this chart. Angles are degrees
// unless a name says otherwise.

const DEG = Math.PI / 180;

export function sind(x) { return Math.sin(x * DEG); }
export function cosd(x) { return Math.cos(x * DEG); }
export function tand(x) { return Math.tan(x * DEG); }
export function atan2d(y, x) { return Math.atan2(y, x) / DEG; }
export function asind(x) { return Math.asin(Math.max(-1, Math.min(1, x))) / DEG; }

export function norm360(x) {
    const r = x % 360;
    return r < 0 ? r + 360 : r;
}

// ---------------------------------------------------------------- time scales

export function julianDay(date) {
    return date.getTime() / 86400000 + 2440587.5;
}

// Schlyter's day number: 0.0 at 2000 Jan 0.0 UT (1999-12-31 00:00 UT).
export function schlyterD(jd) {
    return jd - 2451543.5;
}

// Greenwich mean sidereal time, degrees. USNO approximation.
export function gmst(jd) {
    const D = jd - 2451545.0;
    return norm360((18.697374558 + 24.06570982441908 * D) * 15);
}

// Local sidereal time, degrees. East longitude positive.
export function lst(jd, lonDeg) {
    return norm360(gmst(jd) + lonDeg);
}

// ------------------------------------------------------------ frame rotations

function obliquity(d) {
    return 23.4393 - 3.563e-7 * d;
}

function eclipticToEquatorial(lon, lat, r, d) {
    const ecl = obliquity(d);
    const x = r * cosd(lon) * cosd(lat);
    const y = r * sind(lon) * cosd(lat);
    const z = r * sind(lat);
    const xe = x;
    const ye = y * cosd(ecl) - z * sind(ecl);
    const ze = y * sind(ecl) + z * cosd(ecl);
    return {
        ra: norm360(atan2d(ye, xe)),
        dec: atan2d(ze, Math.sqrt(xe * xe + ye * ye)),
        r: Math.sqrt(xe * xe + ye * ye + ze * ze),
    };
}

// Equatorial to horizontal. Azimuth is compass style: 0 = N, 90 = E.
export function raDecToAltAz(raDeg, decDeg, lstDeg, latDeg) {
    const ha = lstDeg - raDeg;
    const sinAlt = sind(decDeg) * sind(latDeg) + cosd(decDeg) * cosd(latDeg) * cosd(ha);
    const alt = asind(sinAlt);
    // atan2 form measured from south, westward positive; shift to compass north.
    const az = norm360(atan2d(sind(ha), cosd(ha) * sind(latDeg) - tand(decDeg) * cosd(latDeg)) + 180);
    return { alt, az };
}

// Stereographic projection of the sky dome onto a disc of the given radius.
// Zenith maps to the origin, the horizon to the rim. Planisphere convention:
// you are looking UP, so with north at the top east sits on the LEFT.
export function project(altDeg, azDeg, radius) {
    const r = radius * tand((90 - altDeg) / 2);
    return { x: -r * sind(azDeg), y: -r * cosd(azDeg), r };
}

// ------------------------------------------------------------------- the Sun

// Geocentric Sun. Returns ecliptic longitude plus RA/Dec (r in AU).
export function sunPosition(d) {
    const w = 282.9404 + 4.70935e-5 * d;
    const e = 0.016709 - 1.151e-9 * d;
    const M = norm360(356.0470 + 0.9856002585 * d);

    const E = M + e * (180 / Math.PI) * sind(M) * (1 + e * cosd(M));
    const xv = cosd(E) - e;
    const yv = Math.sqrt(1 - e * e) * sind(E);
    const v = atan2d(yv, xv);
    const r = Math.sqrt(xv * xv + yv * yv);
    const lon = norm360(v + w);

    const eq = eclipticToEquatorial(lon, 0, r, d);
    return { lonEcl: lon, ra: eq.ra, dec: eq.dec, r, meanAnomaly: M, meanLon: norm360(M + w) };
}

// ------------------------------------------------------------------ the Moon

function keplerE(M, e) {
    let E = M + e * (180 / Math.PI) * sind(M) * (1 + e * cosd(M));
    for (let i = 0; i < 10; i++) {
        const dE = (E - e * (180 / Math.PI) * sind(E) - M) / (1 - e * cosd(E));
        E -= dE;
        if (Math.abs(dE) < 0.0005) break;
    }
    return E;
}

// Geocentric Moon with Schlyter's major perturbation terms.
// r is in Earth radii; latEcl/lonEcl are geocentric ecliptic coordinates.
export function moonPosition(d) {
    const N = 125.1228 - 0.0529538083 * d;
    const i = 5.1454;
    const w = 318.0634 + 0.1643573223 * d;
    const a = 60.2666;
    const e = 0.054900;
    const M = norm360(115.3654 + 13.0649929509 * d);

    const E = keplerE(M, e);
    const xv = a * (cosd(E) - e);
    const yv = a * Math.sqrt(1 - e * e) * sind(E);
    const v = atan2d(yv, xv);
    const r0 = Math.sqrt(xv * xv + yv * yv);

    const xh = r0 * (cosd(N) * cosd(v + w) - sind(N) * sind(v + w) * cosd(i));
    const yh = r0 * (sind(N) * cosd(v + w) + cosd(N) * sind(v + w) * cosd(i));
    const zh = r0 * sind(v + w) * sind(i);

    let lon = norm360(atan2d(yh, xh));
    let lat = atan2d(zh, Math.sqrt(xh * xh + yh * yh));
    let r = r0;

    // Perturbations need the Sun's mean elements too.
    const sun = sunPosition(d);
    const Ms = sun.meanAnomaly;
    const Ls = sun.meanLon;
    const Lm = norm360(M + w + N);
    const D = Lm - Ls;   // mean elongation
    const F = Lm - N;    // argument of latitude

    lon += -1.274 * sind(M - 2 * D)
         + 0.658 * sind(2 * D)
         - 0.186 * sind(Ms)
         - 0.059 * sind(2 * M - 2 * D)
         - 0.057 * sind(M - 2 * D + Ms)
         + 0.053 * sind(M + 2 * D)
         + 0.046 * sind(2 * D - Ms)
         + 0.041 * sind(M - Ms)
         - 0.035 * sind(D)
         - 0.031 * sind(M + Ms)
         - 0.015 * sind(2 * F - 2 * D)
         + 0.011 * sind(M - 4 * D);
    lat += -0.173 * sind(F - 2 * D)
         - 0.055 * sind(M - F - 2 * D)
         - 0.046 * sind(M + F - 2 * D)
         + 0.033 * sind(F + 2 * D)
         + 0.017 * sind(2 * M + F);
    r += -0.58 * cosd(M - 2 * D) - 0.46 * cosd(2 * D);

    const eq = eclipticToEquatorial(norm360(lon), lat, 1, d);
    return { lonEcl: norm360(lon), latEcl: lat, rEarthRadii: r, ra: eq.ra, dec: eq.dec };
}

// Drop from geocentric to topocentric altitude: lunar parallax is up to a
// degree, which is visible on the chart. Good-enough flat correction.
export function moonTopocentricAlt(altDeg, rEarthRadii) {
    return altDeg - asind(1 / rEarthRadii) * cosd(altDeg);
}

// Phase from the Sun-Moon elongation. Illumination 0 (new) to 1 (full).
export function moonPhase(d) {
    const sun = sunPosition(d);
    const moon = moonPosition(d);
    const elong = Math.acos(Math.max(-1, Math.min(1,
        cosd(moon.lonEcl - sun.lonEcl) * cosd(moon.latEcl)))) / DEG;
    const illumination = (1 - Math.cos(elong * DEG)) / 2;
    const waxing = sind(moon.lonEcl - sun.lonEcl) > 0;
    return { elongation: elong, illumination, waxing, name: phaseName(illumination, waxing) };
}

export function phaseName(illumination, waxing) {
    if (illumination < 0.02) return 'New Moon';
    if (illumination > 0.98) return 'Full Moon';
    if (Math.abs(illumination - 0.5) < 0.04) return waxing ? 'First Quarter' : 'Last Quarter';
    if (illumination < 0.5) return waxing ? 'Waxing Crescent' : 'Waning Crescent';
    return waxing ? 'Waxing Gibbous' : 'Waning Gibbous';
}

// ----------------------------------------------------------------- planets

// Schlyter's osculating elements. Linear in d, angles in degrees, a in AU.
const PLANET_ELEMENTS = {
    mercury: { N: [48.3313, 3.24587e-5], i: [7.0047, 5.00e-8], w: [29.1241, 1.01444e-5], a: [0.387098, 0], e: [0.205635, 5.59e-10], M: [168.6562, 4.0923344368] },
    venus:   { N: [76.6799, 2.46590e-5], i: [3.3946, 2.75e-8], w: [54.8910, 1.38374e-5], a: [0.723330, 0], e: [0.006773, -1.302e-9], M: [48.0052, 1.6021302244] },
    mars:    { N: [49.5574, 2.11081e-5], i: [1.8497, -1.78e-8], w: [286.5016, 2.92961e-5], a: [1.523688, 0], e: [0.093405, 2.516e-9], M: [18.6021, 0.5240207766] },
    jupiter: { N: [100.4542, 2.76854e-5], i: [1.3030, -1.557e-7], w: [273.8777, 1.64505e-5], a: [5.20256, 0], e: [0.048498, 4.469e-9], M: [19.8950, 0.0830853001] },
    saturn:  { N: [113.6634, 2.38980e-5], i: [2.4886, -1.081e-7], w: [339.3939, 2.97661e-5], a: [9.55475, 0], e: [0.055546, -9.499e-9], M: [316.9670, 0.0334442282] },
};

export const PLANET_NAMES = { mercury: 'Mercury', venus: 'Venus', mars: 'Mars', jupiter: 'Jupiter', saturn: 'Saturn' };

function heliocentric(el, d) {
    const N = el.N[0] + el.N[1] * d;
    const i = el.i[0] + el.i[1] * d;
    const w = el.w[0] + el.w[1] * d;
    const a = el.a[0];
    const e = el.e[0] + el.e[1] * d;
    const M = norm360(el.M[0] + el.M[1] * d);

    const E = keplerE(M, e);
    const xv = a * (cosd(E) - e);
    const yv = a * Math.sqrt(1 - e * e) * sind(E);
    const v = atan2d(yv, xv);
    const r = Math.sqrt(xv * xv + yv * yv);

    const xh = r * (cosd(N) * cosd(v + w) - sind(N) * sind(v + w) * cosd(i));
    const yh = r * (sind(N) * cosd(v + w) + cosd(N) * sind(v + w) * cosd(i));
    const zh = r * sind(v + w) * sind(i);
    return { lon: norm360(atan2d(yh, xh)), lat: atan2d(zh, Math.sqrt(xh * xh + yh * yh)), r, M };
}

// Geocentric RA/Dec of one planet.
export function planetPosition(key, d) {
    const h = heliocentric(PLANET_ELEMENTS[key], d);
    let { lon, lat, r } = h;

    // Jupiter and Saturn tug on each other enough to show up at chart scale.
    if (key === 'jupiter' || key === 'saturn') {
        const Mj = heliocentric(PLANET_ELEMENTS.jupiter, d).M;
        const Msat = heliocentric(PLANET_ELEMENTS.saturn, d).M;
        if (key === 'jupiter') {
            lon += -0.332 * sind(2 * Mj - 5 * Msat - 67.6)
                 - 0.056 * sind(2 * Mj - 2 * Msat + 21)
                 + 0.042 * sind(3 * Mj - 5 * Msat + 21)
                 - 0.036 * sind(Mj - 2 * Msat)
                 + 0.022 * cosd(Mj - Msat)
                 + 0.023 * sind(2 * Mj - 3 * Msat + 52)
                 - 0.016 * sind(Mj - 5 * Msat - 69);
        } else {
            lon += 0.812 * sind(2 * Mj - 5 * Msat - 67.6)
                 - 0.229 * cosd(2 * Mj - 4 * Msat - 2)
                 + 0.119 * sind(Mj - 2 * Msat - 3)
                 + 0.046 * sind(2 * Mj - 6 * Msat - 69)
                 + 0.014 * sind(Mj - 3 * Msat + 32);
            lat += -0.020 * cosd(2 * Mj - 4 * Msat - 2)
                 + 0.018 * sind(2 * Mj - 6 * Msat - 49);
        }
    }

    // Heliocentric ecliptic -> geocentric: add the Sun's rectangular position.
    const sun = sunPosition(d);
    const xh = r * cosd(lon) * cosd(lat);
    const yh = r * sind(lon) * cosd(lat);
    const zh = r * sind(lat);
    const xg = xh + sun.r * cosd(sun.lonEcl);
    const yg = yh + sun.r * sind(sun.lonEcl);
    const zg = zh;

    const lonG = norm360(atan2d(yg, xg));
    const latG = atan2d(zg, Math.sqrt(xg * xg + yg * yg));
    const eq = eclipticToEquatorial(lonG, latG, 1, d);
    return { key, name: PLANET_NAMES[key], ra: eq.ra, dec: eq.dec, lonEcl: lonG, latEcl: latG };
}

export function planetPositions(d) {
    return Object.keys(PLANET_ELEMENTS).map((key) => planetPosition(key, d));
}

// Angular separation between two ecliptic longitudes, 0..180.
export function elongation(lonA, lonB) {
    const diff = Math.abs(norm360(lonA - lonB));
    return diff > 180 ? 360 - diff : diff;
}

// ------------------------------------------------------------ sky brightness

export function twilightKind(sunAltDeg) {
    if (sunAltDeg > 0) return 'day';
    if (sunAltDeg > -6) return 'civil';
    if (sunAltDeg > -12) return 'nautical';
    if (sunAltDeg > -18) return 'astronomical';
    return 'night';
}

// 0 at (or above) sunset line, 1 in full astronomical night; smooth in between.
export function skyDarkness(sunAltDeg) {
    if (sunAltDeg >= 0) return 0;
    if (sunAltDeg <= -18) return 1;
    const t = -sunAltDeg / 18;
    return t * t * (3 - 2 * t); // smoothstep
}

// Faintest magnitude worth drawing for a given darkness (fades stars in as
// twilight deepens; bright planets/stars survive into civil twilight).
export function magnitudeLimit(darkness, magLimit = 5) {
    return -1 + (magLimit + 1) * darkness;
}

// --------------------------------------------------------------- rise & set

// Scan a UT day for altitude crossings of h0 and refine them by bisection.
// altAt(date) must return degrees. Returns { rise, set } as Dates or null,
// plus alwaysUp/alwaysDown flags for polar edge cases.
export function riseSet(altAt, dayStartUtc, h0 = -0.833, stepMinutes = 10) {
    const start = dayStartUtc.getTime();
    const stepMs = stepMinutes * 60000;
    const n = Math.ceil(86400000 / stepMs);
    let rise = null;
    let set = null;
    let anyAbove = false;
    let anyBelow = false;

    let prevT = start;
    let prevV = altAt(new Date(prevT)) - h0;
    if (prevV > 0) anyAbove = true; else anyBelow = true;

    for (let s = 1; s <= n; s++) {
        const t = Math.min(start + s * stepMs, start + 86400000);
        const v = altAt(new Date(t)) - h0;
        if (v > 0) anyAbove = true; else anyBelow = true;
        if (prevV <= 0 && v > 0 && !rise) rise = bisect(altAt, prevT, t, h0, true);
        if (prevV > 0 && v <= 0 && !set) set = bisect(altAt, prevT, t, h0, false);
        prevT = t;
        prevV = v;
    }
    return { rise, set, alwaysUp: anyAbove && !anyBelow, alwaysDown: anyBelow && !anyAbove };
}

function bisect(altAt, tLo, tHi, h0, rising) {
    for (let i = 0; i < 22; i++) {
        const mid = (tLo + tHi) / 2;
        const above = altAt(new Date(mid)) - h0 > 0;
        if (above === rising) tHi = mid; else tLo = mid;
    }
    return new Date(Math.round((tLo + tHi) / 2));
}

// ------------------------------------------------------------------- catalog

export function parseStars(json) {
    return json.stars.map(([ra, dec, mag, bv, name, con]) => ({
        ra, dec, mag, bv,
        name: name === 0 ? null : name,
        con: con === 0 ? null : con,
    }));
}

// B-V color index to an rgb() string. Piecewise fit: hot blue-white through
// yellow to cool orange; subtle on purpose, these are 2-3px dots.
export function bvToColor(bv) {
    const t = Math.max(-0.4, Math.min(2.0, bv));
    let r;
    let g;
    let b;
    if (t < 0.4) { // blue-white
        const k = (t + 0.4) / 0.8;
        r = 0.62 + 0.38 * k; g = 0.75 + 0.23 * k; b = 1.0;
    } else if (t < 1.0) { // white to warm yellow
        const k = (t - 0.4) / 0.6;
        r = 1.0; g = 0.98 - 0.11 * k; b = 1.0 - 0.35 * k;
    } else { // orange-red
        const k = (t - 1.0) / 1.0;
        r = 1.0; g = 0.87 - 0.32 * k; b = 0.65 - 0.35 * k;
    }
    const c = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255);
    return `rgb(${c(r)},${c(g)},${c(b)})`;
}
