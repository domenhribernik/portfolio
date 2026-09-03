/* BEARING: the instrument, the geometry, and the two rules the view is
   built on.

   The load-bearing test here is the gate curve. Bracketing only earns its
   place in the game if setting the gate well is measurably better than
   eyeballing the peak AND setting it badly is measurably worse. If either
   half stops being true, the instrument has stopped being a skill and is
   back to being a dice roll, which is what this suite exists to catch. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeCode, isValidCode, cleanName, isValidName, CODE_ALPHABET,
  createTranslator, pollDelay, angleDelta, bearingBetween, crossingAngle,
  errorEllipse, fixGrade, formatMetres,
  antennaStrength, lobePeak, noiseFloor, bracketLobe, bracketSigma, readBearing,
  antennaNoise, lobeSnr, LOBE_SNR_MIN, MOVE_MAX, walkCost, withinWalk,
  PROFILES, CYCLES, INTERCEPT_RADIUS, attendCost
} from '../views/bearing/logic.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI = JSON.parse(readFileSync(join(ROOT, 'views/bearing/ui.json'), 'utf8'));

/* ---- helpers ---- */
const traceFor = (truth, dist, seed) => {
  const r = new Array(360);
  for (let i = 0; i < 360; i++) r[i] = antennaStrength(i, truth, dist, seed);
  return r;
};
const trials = 400;
function rmsAtGate(frac) {
  let sq = 0, n = 0;
  for (let seed = 1; seed <= trials; seed++) {
    const truth = (seed * 37) % 360, dist = 8 + (seed % 20);
    const r = traceFor(truth, dist, seed);
    const read = readBearing(r, frac * lobePeak(r).level);
    if (!read || !read.bracket) continue;
    const e = angleDelta(read.bearing, truth);
    sq += e * e; n++;
  }
  return { rms: Math.sqrt(sq / n), n };
}
function rmsNaivePeak() {
  let sq = 0;
  for (let seed = 1; seed <= trials; seed++) {
    const truth = (seed * 37) % 360, dist = 8 + (seed % 20);
    const e = angleDelta(lobePeak(traceFor(truth, dist, seed)).at, truth);
    sq += e * e;
  }
  return Math.sqrt(sq / trials);
}

/* ---- room codes and names, mirrored in the controller ---- */

test('room codes carry no vowels and no lookalike characters', () => {
  for (const ch of 'AEIOU01') assert.ok(!CODE_ALPHABET.includes(ch), `${ch} must stay out of the alphabet`);
  assert.equal(normalizeCode(' bc-df '), 'BCDF');
  assert.equal(normalizeCode('bcdfgh'), 'BCDF', 'a code is exactly four characters');
  assert.ok(isValidCode('bcdf'));
  assert.ok(!isValidCode('AEIO'), 'vowels can spell words, so they are not codes');
  assert.ok(!isValidCode('BCD'));
});

test('names are trimmed, collapsed and capped', () => {
  assert.equal(cleanName('  Domen   H  '), 'Domen H');
  assert.equal(cleanName('x'.repeat(40)).length, 20);
  assert.ok(!isValidName('   '));
  assert.ok(isValidName('D'));
});

/* ---- poll pacing ---- */

test('the poll leans in only while waiting on the other seat', () => {
  assert.equal(pollDelay({ status: 'night', waiting: true }), 900);
  assert.equal(pollDelay({ status: 'night', waiting: false }), 3000,
    'once you have committed, nothing can change until they do');
  assert.equal(pollDelay({ status: 'night', hidden: true }), 4000);
  assert.equal(pollDelay({ failures: 3 }), 6400, 'failures back off exponentially');
  assert.equal(pollDelay({ failures: 20 }), 10000, 'and are capped');
});

/* ---- the instrument ---- */

test('a reading is repeatable: the same angle always answers the same', () => {
  const a = antennaStrength(123, 40, 12, 7);
  const b = antennaStrength(123, 40, 12, 7);
  assert.equal(a, b, 'an instrument that answers differently each look reads as broken');
});

test('bracketing beats eyeballing the peak, by a lot', () => {
  const naive = rmsNaivePeak();
  const best = rmsAtGate(0.5);
  assert.ok(best.n > trials * 0.95, 'the gate should resolve on essentially every trace');
  assert.ok(best.rms * 2 < naive,
    `bracketing at half power (${best.rms.toFixed(2)}) must beat peak-reading (${naive.toFixed(2)}) by 2x or the technique is not worth teaching`);
});

test('the gate has a real optimum, so setting it badly costs you', () => {
  const low = rmsAtGate(0.10).rms;
  const mid = rmsAtGate(0.50).rms;
  const high = rmsAtGate(0.92).rms;
  assert.ok(mid < low, `a gate set too low (${low.toFixed(2)}) must be worse than half power (${mid.toFixed(2)})`);
  assert.ok(mid < high, `a gate set too high (${high.toFixed(2)}) must be worse than half power (${mid.toFixed(2)})`);
  assert.ok(low > rmsNaivePeak(),
    'a badly set gate should be worse than not bracketing at all, or there is no skill to learn');
});

test('the stated uncertainty is honest, never flattering', () => {
  /* The plus-or-minus is computed from the trace alone and is what the
     player works to shrink, so it must not promise better than it delivers. */
  let stated = 0, actual = 0, n = 0;
  for (let seed = 1; seed <= trials; seed++) {
    const truth = (seed * 37) % 360, dist = 8 + (seed % 20);
    const r = traceFor(truth, dist, seed);
    const read = readBearing(r, 0.5 * lobePeak(r).level);
    if (!read || !read.bracket || read.sigma == null) continue;
    stated += read.sigma; actual += Math.abs(angleDelta(read.bearing, truth)); n++;
  }
  assert.ok(stated / n >= actual / n,
    `stated ${(stated/n).toFixed(2)} must not undersell real error ${(actual/n).toFixed(2)}`);
});

test('a sweep of pure hiss reports no bearing at all', () => {
  /* The regression this exists to stop: lobePeak happily returns the
     loudest NOISE sample, so without an SNR gate the instrument sets the
     gate at half of a bump and reports a confident bearing off nothing.
     On screen that is an orange ray whipping around the plate. */
  const hiss = new Array(360);
  for (let i = 0; i < 360; i++) hiss[i] = 0.06 + antennaNoise(i, 5) * 0.1;
  assert.ok(lobeSnr(hiss) < LOBE_SNR_MIN, 'hiss must not clear the lobe threshold');
  const read = readBearing(hiss, 0.5 * lobePeak(hiss).level);
  assert.equal(read.bracket, null);
  assert.equal(read.bearing, null, 'no lobe means no bearing, not a guess');
});

test('a real lobe clears the threshold comfortably', () => {
  const r = traceFor(200, 12, 5);
  assert.ok(lobeSnr(r) > LOBE_SNR_MIN * 2, 'a genuine collar should not be marginal');
  assert.ok(Math.abs(angleDelta(readBearing(r, 0.5 * lobePeak(r).level).bearing, 200)) < 5);
});

test('a bracket measured across unswept ground is refused', () => {
  const r = traceFor(90, 12, 3);
  for (let i = 80; i < 100; i++) r[i] = null;      /* a hole through the lobe */
  assert.equal(bracketLobe(r, 0.4), null, 'a hole in the sweep is not a measurement');
});

test('the noise floor is measured away from the lobe, not through it', () => {
  const r = traceFor(200, 10, 11);
  const n = noiseFloor(r, lobePeak(r).at);
  assert.ok(n > 0 && n < 0.2, `noise floor ${n} should be small and positive`);
});

/* ---- the geometry ---- */

test('bearings are compass bearings: zero is north, y grows down', () => {
  assert.equal(Math.round(bearingBetween({ x: 0, y: 0 }, { x: 0, y: -1 })), 0);
  assert.equal(Math.round(bearingBetween({ x: 0, y: 0 }, { x: 1, y: 0 })), 90);
  assert.equal(Math.round(bearingBetween({ x: 0, y: 0 }, { x: 0, y: 1 })), 180);
});

test('a wide baseline is worth far more than a narrow one', () => {
  const target = { x: 15, y: 8 };
  const wide = errorEllipse([{ x: 5, y: 22 }, { x: 26, y: 22 }], target);
  const narrow = errorEllipse([{ x: 13, y: 25 }, { x: 17, y: 26 }], target);
  assert.ok(narrow.major > wide.major * 4,
    'standing together must visibly rot the fix, or the game has no reason to separate you');
  assert.ok(wide.minor / wide.major > 0.4, 'a square crossing should be roughly round');
  assert.ok(narrow.minor / narrow.major < 0.2, 'a shallow crossing should be a cigar');
});

test('crossing angle is symmetric and never above ninety', () => {
  assert.equal(Math.round(crossingAngle(10, 100)), 90);
  assert.equal(Math.round(crossingAngle(100, 10)), 90);
  assert.equal(Math.round(crossingAngle(10, 170)), 20, 'a reciprocal bearing crosses shallowly');
  for (let a = 0; a < 360; a += 17) for (let b = 0; b < 360; b += 23) {
    const c = crossingAngle(a, b);
    assert.ok(c >= 0 && c <= 90.0001, `crossingAngle(${a},${b}) = ${c}`);
  }
});

test('fix grades follow the thresholds the report prints', () => {
  assert.equal(fixGrade(100), 'tight');
  assert.equal(fixGrade(300), 'usable');
  assert.equal(fixGrade(600), 'loose');
  assert.equal(fixGrade(1500), 'worthless');
  assert.equal(formatMetres(340), '340 m');
  assert.equal(formatMetres(1900), '1.9 km');
});

/* ---- the constants that exist twice ---- */

test('the constants shared with the controller have not drifted', () => {
  /* These live in both views/bearing/logic.js and the PHP because the
     browser needs them to draw and the server needs them to decide.
     Reading the PHP as text is what turns "change them in both" from a
     comment into a guarantee. Note the two homes: the valley's own
     dimensions belong to app/controllers/bearing/valley.php, which is the
     pure world module the simulation suite runs without a server. */
  const php = readFileSync(join(ROOT, 'app/controllers/bearing-controller.php'), 'utf8');
  const valley = readFileSync(join(ROOT, 'app/controllers/bearing/valley.php'), 'utf8');
  const constant = (src, name, where) => {
    const m = src.match(new RegExp('^const\\s+' + name + '\\s*=\\s*(\\d+)\\s*;', 'm'));
    assert.ok(m, where + ' should declare ' + name);
    return Number(m[1]);
  };
  assert.equal(constant(php, 'MOVE_MAX', 'the controller'), MOVE_MAX, 'MOVE_MAX drifted between JS and PHP');
  assert.equal(constant(php, 'CYCLES', 'the controller'), CYCLES, 'the night length drifted');
  assert.equal(constant(php, 'INTERCEPT_RADIUS', 'the controller'), INTERCEPT_RADIUS,
    'the intercept radius drifted, so the ring drawn on the plate is a lie');
  assert.equal(constant(valley, 'N', 'valley.php'), 32, 'the valley size drifted');
  assert.equal(constant(valley, 'CELL_M', 'valley.php'), 100, 'the cell size drifted');

  /* The four shapes are named in three places: the movement model that
     runs them, the controller that validates a chip against them, and the
     browser that labels them. */
  const movement = readFileSync(join(ROOT, 'app/controllers/bearing/movement.php'), 'utf8');
  const listed = movement.match(/^const PROFILES = \[([^\]]+)\]/m);
  assert.ok(listed, 'movement.php should declare PROFILES');
  const phpProfiles = [...listed[1].matchAll(/'(\w+)'/g)].map(m => m[1]);
  assert.deepEqual(phpProfiles, PROFILES, 'the behaviour profiles drifted between JS and PHP');
  for (const p of PROFILES) {
    assert.ok(UI['profile.' + p], `ui.json has no name for the ${p} shape`);
    assert.ok(UI['profile.' + p + '.hint'], `ui.json has no hint for the ${p} shape`);
  }

  /* Every refusal reason the controller can send must exist as a string. */
  for (const m of php.matchAll(/'reason' => '(\w+)'/g)) {
    assert.ok(UI['refuse.' + m[1]], 'ui.json has no row for refuse.' + m[1]);
  }
});

test('a call you cannot walk to is knowable before you make it', () => {
  /* The walking sum has to be answerable in the browser, or the only way
     to learn a call was unreachable is to lose the night to it. */
  const n = 32, here = 16 * n + 16;
  assert.equal(attendCost([here], here, n), 0, 'standing on it costs nothing');
  assert.equal(attendCost([here], here + INTERCEPT_RADIUS, n), 0, 'inside the radius is already there');
  assert.equal(attendCost([here], here + INTERCEPT_RADIUS + MOVE_MAX, n), 1, 'one cycle of walking');
  assert.equal(attendCost([here], here + INTERCEPT_RADIUS + MOVE_MAX + 1, n), 2, 'one cell more is two');
  assert.equal(attendCost([here + 20, here + 1], here, n), 0, 'the nearer station answers');
});


test('walking is Chebyshev and capped', () => {
  assert.equal(walkCost(0, 0, 32), 0);
  assert.equal(walkCost(0, 32 * 3 + 2, 32), 3, 'diagonal costs the longer of the two legs');
  assert.ok(withinWalk(0, 32 * MOVE_MAX + MOVE_MAX, 32), 'exactly MOVE_MAX away is reachable');
  assert.ok(!withinWalk(0, 32 * MOVE_MAX + MOVE_MAX + 1, 32), 'one further is not');
});

/* ---- strings ---- */

test('every refusal the view can show has a row in ui.json', () => {
  const script = readFileSync(join(ROOT, 'views/bearing/script.js'), 'utf8');
  const keys = new Set();
  for (const m of script.matchAll(/refuse\('([\w.]+)'\)/g)) keys.add(m[1]);
  for (const m of script.matchAll(/'(refuse\.[\w]+)'/g)) keys.add(m[1]);
  assert.ok(keys.size > 0, 'expected the view to name some refusal codes');
  for (const k of keys) assert.ok(UI[k], `ui.json is missing a row for ${k}`);
});

test('no user-facing string contains an em dash', () => {
  for (const [key, row] of Object.entries(UI)) {
    if (key === 'meta') continue;
    for (const [lang, value] of Object.entries(row)) {
      assert.ok(!String(value).includes('—'), `${key}.${lang} contains an em dash`);
    }
  }
});

test('the translator fills templates and falls back to the key', () => {
  const t = createTranslator(UI, 'en');
  assert.match(t('train.result', { said: 1, truth: 2, err: 3 }), /^You said 1\. It was 2\./);
  assert.equal(t('nope.not.here'), 'nope.not.here');
});
