/* BEARING / logic.js
   DOM-free, so tests/bearing-logic.test.mjs can hold it.

   Nothing in here decides what happened in a room. The server owns the
   valley, the animals, the bearings and the scoring; this file only knows
   how to draw and describe what the server already decided, plus the
   room-code and name rules it mirrors from the controller.

   The one exception is the practice trainer, which is a single-device
   instrument with no room behind it. Its antenna pattern lives here
   because nothing on the server ever needs to agree with it. */

/* ---- room codes and names: mirrored in bearing-controller.php ---- */

export const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const CODE_LENGTH = 4;
export const NAME_MAX = 20;

export function normalizeCode(raw) {
  return String(raw == null ? '' : raw)
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, CODE_LENGTH);
}

export function isValidCode(raw) {
  const code = normalizeCode(raw);
  if (code.length !== CODE_LENGTH) return false;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}

export function cleanName(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

export function isValidName(raw) {
  const n = cleanName(raw);
  return n.length >= 1 && n.length <= NAME_MAX;
}

/* ---- strings ---- */

export const DEFAULT_LANG = 'en';

export function fillTemplate(str, vars) {
  return String(str).replace(/\{(\w+)\}/g, (m, k) =>
    (vars && Object.prototype.hasOwnProperty.call(vars, k)) ? String(vars[k]) : m);
}

export function resolveString(table, key, lang = DEFAULT_LANG) {
  const row = table && table[key];
  if (!row) return key;
  return row[lang] != null ? row[lang] : (row[DEFAULT_LANG] != null ? row[DEFAULT_LANG] : key);
}

export function createTranslator(table, lang = DEFAULT_LANG) {
  return (key, vars) => fillTemplate(resolveString(table, key, lang), vars);
}

/* ---- poll pacing ----
   Same shape as seam's. The cheapest phase is the one where you have
   already committed and nothing can change until your partner does; the
   most expensive is waiting for them, because that is the moment a
   change actually arrives. */

export function pollDelay({ status, hidden, failures, waiting } = {}) {
  if (failures > 0) return Math.min(10000, 800 * Math.pow(2, failures));
  if (hidden) return 4000;
  if (status === 'lobby') return 1000;
  if (status === 'night') return waiting ? 900 : 3000;
  if (status === 'dawn') return 5000;
  return 2500;
}

/* ---- geometry ----
   Presentational only. The client draws these; the server scores. */

export const DEG = Math.PI / 180;

/** Signed smallest difference a - b, in (-180, 180]. */
export function angleDelta(a, b) {
  return ((a - b) % 360 + 540) % 360 - 180;
}

/** Compass bearing from one grid point to another. 0 is north, y grows down. */
export function bearingBetween(from, to) {
  return (Math.atan2(to.x - from.x, -(to.y - from.y)) / DEG + 360) % 360;
}

/** A point `dist` along `deg` from an origin, for drawing a ray. */
export function alongBearing(origin, deg, dist) {
  const a = (deg - 90) * DEG;
  return { x: origin.x + Math.cos(a) * dist, y: origin.y + Math.sin(a) * dist };
}

/** Where two bearings cross, or null when they are parallel. */
export function crossing(a, b) {
  const ax = Math.sin(a.deg * DEG), ay = -Math.cos(a.deg * DEG);
  const bx = Math.sin(b.deg * DEG), by = -Math.cos(b.deg * DEG);
  const det = ax * by - ay * bx;
  if (Math.abs(det) < 1e-9) return null;
  const dx = b.from.x - a.from.x, dy = b.from.y - a.from.y;
  const t = (dx * by - dy * bx) / det;
  return { x: a.from.x + ax * t, y: a.from.y + ay * t, ahead: t > 0 };
}

/** The angle two bearings cut at: 0 is parallel and useless, 90 is ideal. */
export function crossingAngle(a, b) {
  let d = Math.abs(angleDelta(a, b));
  if (d > 90) d = 180 - d;
  return d;
}

/* A bearing pins position only ACROSS the line of sight, never along it.
   Stack both constraints as a Fisher information matrix and invert:
   square crossings give a small round covariance, near-parallel ones
   leave the along-track direction almost free, which is the cigar. The
   shape falls out of the geometry, so there is no fudge factor to tune. */
export function errorEllipse(stations, target, sigmaDeg = 4, confidence = 2.45) {
  let Jxx = 0, Jxy = 0, Jyy = 0;
  const sigma = sigmaDeg * DEG;
  for (const s of stations) {
    const dx = target.x - s.x, dy = target.y - s.y;
    const d = Math.max(0.4, Math.hypot(dx, dy));
    const ux = -dy / d, uy = dx / d;
    const w = 1 / Math.pow(d * sigma, 2);
    Jxx += w * ux * ux; Jxy += w * ux * uy; Jyy += w * uy * uy;
  }
  let det = Jxx * Jyy - Jxy * Jxy;
  if (Math.abs(det) < 1e-12) det = 1e-12;
  const a = Jyy / det, b = -Jxy / det, c = Jxx / det;
  const tr = a + c;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - (a * c - b * b)));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(1e-9, tr / 2 - disc);
  return {
    major: confidence * Math.sqrt(l1),
    minor: confidence * Math.sqrt(l2),
    rotation: 0.5 * Math.atan2(2 * b, a - c) / DEG
  };
}

export const FIX_GRADE = { tight: 180, usable: 450, loose: 900 };

/** Grade a fix by the major axis of its envelope, in metres. */
export function fixGrade(metres) {
  if (metres < FIX_GRADE.tight) return 'tight';
  if (metres < FIX_GRADE.usable) return 'usable';
  if (metres < FIX_GRADE.loose) return 'loose';
  return 'worthless';
}

export function formatMetres(m) {
  return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
}

/* ---- the practice trainer only ----
   A single-device instrument with no room behind it, so nothing on the
   server has to agree with any of this. */

function hash32(x) {
  x = (x ^ 61) ^ (x >>> 16);
  x = x + (x << 3);
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  return (x >>> 0) / 4294967296;
}

/* Smooth value noise keyed to the angle, so the trace wanders like a pen
   instead of jittering, and re-reading an angle always gives the same
   number back. An instrument that answers differently each time you look
   at it reads as broken rather than as noisy. */
export function antennaNoise(angle, seed) {
  const octave = (period, k) => {
    const s = angle / period, i = Math.floor(s), f = s - i;
    const h0 = hash32(i * 7919 + seed * 104729 + k);
    const h1 = hash32((i + 1) * 7919 + seed * 104729 + k);
    const t = f * f * (3 - 2 * f);
    return h0 + (h1 - h0) * t;
  };
  return (octave(9, 13) * 0.62 + octave(3.2, 29) * 0.38) - 0.5;
}

export function antennaStrength(angle, trueBearing, distance, seed) {
  const d = Math.abs(angleDelta(angle, trueBearing));
  const main = Math.pow(Math.max(0, Math.cos(d * DEG)), 5);
  const back = 0.13 * Math.pow(Math.max(0, Math.cos((180 - d) * DEG)), 8);
  const reach = 1 - Math.min(0.5, distance / 36);
  const s = (main + back) * reach + 0.06 + antennaNoise(angle, seed) * (0.09 + 0.16 * (1 - reach));
  return Math.max(0, Math.min(1, s));
}

/* ---- bracketing: the technique the instrument is actually for --------
   The top of the lobe is flat, so eyeballing its centre is imprecise no
   matter how carefully you look. The FLANKS are steep, so the two angles
   where the signal crosses a chosen level are sharply located, and their
   midpoint is a far better bearing than the peak ever was.

   That gives the gate an optimum rather than a preference. Set it low and
   the bracket swallows the side lobes and drifts; set it near the peak and
   the crossings land on flat ground where noise moves them around. Around
   half power the flanks are steepest and the reading is tightest, which is
   a real thing a person can get good at. */

const FULL = 360;

/** Loudest swept angle: where the main lobe is. Null if nothing is swept. */
export function lobePeak(readings) {
  let best = -1, at = null;
  for (let i = 0; i < FULL; i++) {
    if (readings[i] != null && readings[i] > best) { best = readings[i]; at = i; }
  }
  return at === null ? null : { at, level: best };
}

/** How noisy this trace is, measured well away from the lobe so the lobe
    itself never inflates it. This is what bounds the achievable precision. */
export function noiseFloor(readings, peakAt) {
  const away = [];
  for (let i = 0; i < FULL; i++) {
    if (readings[i] == null) continue;
    if (Math.abs(angleDelta(i, peakAt)) > 70) away.push(readings[i]);
  }
  if (away.length < 8) return 0.05;
  const mean = away.reduce((a, b) => a + b, 0) / away.length;
  const varr = away.reduce((a, b) => a + (b - mean) * (b - mean), 0) / away.length;
  return Math.max(0.008, Math.sqrt(varr));
}

/** Walk out from the peak until the trace drops through `gate` on each
    side. Returns null when the sweep has a hole in the lobe, because a
    bracket measured across unswept ground is not a measurement. */
export function bracketLobe(readings, gate) {
  const peak = lobePeak(readings);
  if (!peak || gate >= peak.level) return null;

  const walk = dir => {
    for (let step = 1; step < 180; step++) {
      const i = ((peak.at + dir * step) % FULL + FULL) % FULL;
      const v = readings[i];
      if (v == null) return null;             /* hole in the sweep */
      if (v < gate) {
        const prev = readings[((i - dir) % FULL + FULL) % FULL];
        /* land between the two samples the crossing actually falls between */
        const frac = (prev - gate) / Math.max(1e-6, prev - v);
        return { edge: peak.at + dir * (step - 1 + frac), at: i, step };
      }
    }
    return null;
  };

  const lo = walk(-1), hi = walk(1);
  if (!lo || !hi) return null;
  const width = hi.edge - lo.edge;
  if (width <= 0 || width >= 300) return null;
  return {
    peakAt: peak.at, peakLevel: peak.level, gate,
    lo: ((lo.edge % FULL) + FULL) % FULL,
    hi: ((hi.edge % FULL) + FULL) % FULL,
    width,
    bearing: (((lo.edge + hi.edge) / 2) % FULL + FULL) % FULL,
    loStep: lo.step, hiStep: hi.step
  };
}

/** The honest uncertainty of a bracketed bearing, from the data alone.
    A crossing sits where the trace cuts the gate, so noise displaces it by
    noise divided by the local slope: steep flank, small error. No truth is
    consulted, which is what lets the instrument show a live plus-or-minus
    the player can work to shrink. */
export function bracketSigma(readings, br, noise) {
  if (!br) return null;
  const slopeAt = idx => {
    const a = readings[((Math.round(idx) - 2) % FULL + FULL) % FULL];
    const b = readings[((Math.round(idx) + 2) % FULL + FULL) % FULL];
    if (a == null || b == null) return null;
    return Math.abs(b - a) / 4;
  };
  const sLo = slopeAt(br.lo), sHi = slopeAt(br.hi);
  if (!sLo || !sHi) return null;
  const eLo = noise / Math.max(1e-4, sLo);
  const eHi = noise / Math.max(1e-4, sHi);
  /* the midpoint of two independent edges averages their error down */
  return Math.max(0.3, 0.5 * Math.hypot(eLo, eHi));
}

/** How far the loudest sample stands above the surrounding noise. Below
    about four the trace has no lobe in it yet, only a sweep of hiss, and
    anything measured off it is a confident answer to nothing. */
export function lobeSnr(readings) {
  const peak = lobePeak(readings);
  if (!peak) return null;
  const away = [];
  for (let i = 0; i < FULL; i++) {
    if (readings[i] == null) continue;
    if (Math.abs(angleDelta(i, peak.at)) > 70) away.push(readings[i]);
  }
  if (away.length < 20) return null;
  const mean = away.reduce((a, b) => a + b, 0) / away.length;
  const sd = Math.sqrt(away.reduce((a, b) => a + (b - mean) * (b - mean), 0) / away.length);
  return (peak.level - mean) / Math.max(1e-4, sd);
}

export const LOBE_SNR_MIN = 4;

/** One call for the whole reading, so the view never does the maths. */
export function readBearing(readings, gate) {
  const peak = lobePeak(readings);
  if (!peak) return null;
  const snr = lobeSnr(readings);
  if (snr == null || snr < LOBE_SNR_MIN) return { peak, bracket: null, bearing: null, sigma: null, snr };
  const br = bracketLobe(readings, gate);
  if (!br) return { peak, bracket: null, bearing: null, sigma: null, snr };
  const noise = noiseFloor(readings, br.peakAt);
  return { peak, bracket: br, bearing: br.bearing, sigma: bracketSigma(readings, br, noise), noise, snr };
}

/* ---- walking ----
   MOVE_MAX is mirrored in bearing-controller.php. Change it in both;
   tests/bearing-logic.test.mjs reads the PHP and fails if they drift. */

export const MOVE_MAX = 6;

/** Chebyshev, because a station walks diagonally as easily as straight. */
export function walkCost(fromIdx, toIdx, n) {
  const fx = fromIdx % n, fy = Math.floor(fromIdx / n);
  const tx = toIdx % n, ty = Math.floor(toIdx / n);
  return Math.max(Math.abs(tx - fx), Math.abs(ty - fy));
}
export function withinWalk(fromIdx, toIdx, n) {
  return walkCost(fromIdx, toIdx, n) <= MOVE_MAX;
}
