import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOLDEN_ANGLE,
  MAX_STEMS,
  lerp,
  clamp,
  easeOutCubic,
  jitter,
  rosePetals,
  tulipPetals,
  daisyPetals,
  sunflowerPetals,
  peonyPetals,
  poppyPetals,
  lilyPetals,
  carnationPetals,
  lavenderWhorls,
  spherePoints,
  bouquetSeats,
  coneFaces,
  waveEdgePoints,
  stepCount,
  orderTotal,
  surpriseCounts,
  hashId,
  normalizeShareOrder,
} from '../views/flowers/logic.js';

test('lerp interpolates and clamp bounds', () => {
  assert.equal(lerp(0, 10, 0.5), 5);
  assert.equal(lerp(2, 2, 0.9), 2);
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
});

test('easeOutCubic stays in [0, 1] and is monotonic', () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  let prev = -Infinity;
  for (let t = 0; t <= 1.001; t += 0.05) {
    const v = easeOutCubic(t);
    assert.ok(v >= prev, `not monotonic at t=${t}`);
    prev = v;
  }
});

test('jitter is deterministic and bounded', () => {
  for (let i = 0; i < 50; i++) {
    const a = jitter(i, 4);
    assert.equal(a, jitter(i, 4), 'same input must give same wobble');
    assert.ok(Math.abs(a) <= 4, `|jitter| exceeded amount at i=${i}`);
  }
  assert.notEqual(jitter(1, 4), jitter(1, 4, 2), 'salt should change the wobble');
});

test('rosePetals follows the golden angle from bud to open', () => {
  const specs = rosePetals(16);
  assert.equal(specs.length, 16);
  specs.forEach((s, i) => {
    const expected = (i * GOLDEN_ANGLE) % 360;
    assert.ok(Math.abs(s.azimuth - expected) < 1e-9, `azimuth off at petal ${i}`);
    assert.ok(s.open >= 8 - 3 && s.open <= 76 + 3, `open out of range at petal ${i}`);
    assert.ok(s.size >= 0.42 && s.size <= 1, `size out of range at petal ${i}`);
  });
  assert.ok(specs[0].open < specs.at(-1).open, 'outer petals must open wider than the bud');
  for (let i = 1; i < specs.length; i++) {
    assert.ok(specs[i].size >= specs[i - 1].size, 'petal size must grow outward');
  }
});

test('tulipPetals is two offset rings, cupped inward', () => {
  const specs = tulipPetals();
  assert.equal(specs.length, 6);
  const inner = specs.slice(0, 3);
  const outer = specs.slice(3);
  assert.deepEqual(inner.map((s) => s.azimuth), [0, 120, 240]);
  assert.deepEqual(outer.map((s) => s.azimuth), [60, 180, 300]);
  const maxInnerOpen = Math.max(...inner.map((s) => s.open));
  const minOuterOpen = Math.min(...outer.map((s) => s.open));
  assert.ok(maxInnerOpen < minOuterOpen, 'inner ring must stay tighter than outer ring');
  for (const s of specs) assert.ok(s.bend < 0, 'tulip tips must bend inward');
});

test('daisyPetals spreads petals evenly with bounded wobble', () => {
  const count = 15;
  const step = 360 / count;
  const specs = daisyPetals(count);
  assert.equal(specs.length, count);
  specs.forEach((s, i) => {
    assert.ok(Math.abs(s.azimuth - i * step) <= step * 0.12 + 1e-9, `azimuth wobble too big at ${i}`);
    assert.ok(s.open >= 78 - 6 && s.open <= 78 + 6, `droop out of range at ${i}`);
    assert.ok(s.size > 0.9 && s.size < 1.1, `size wobble out of range at ${i}`);
  });
});

test('sunflowerPetals lays a raised inner ring inside a flatter outer ring', () => {
  const specs = sunflowerPetals(14, 11);
  assert.equal(specs.length, 25);
  const outer = specs.filter((s) => s.ring === 0);
  const inner = specs.filter((s) => s.ring === 1);
  assert.equal(outer.length, 14);
  assert.equal(inner.length, 11);
  const minOuterOpen = Math.min(...outer.map((s) => s.open));
  const maxInnerOpen = Math.max(...inner.map((s) => s.open));
  assert.ok(maxInnerOpen < minOuterOpen, 'inner ring must sit steeper than the outer ring');
  const maxInnerSize = Math.max(...inner.map((s) => s.size));
  const minOuterSize = Math.min(...outer.map((s) => s.size));
  assert.ok(maxInnerSize < minOuterSize, 'inner rays must stay shorter than outer rays');
});

test('peonyPetals is a golden-angle ruffle with bounded twist', () => {
  const specs = peonyPetals(24);
  assert.equal(specs.length, 24);
  specs.forEach((s, i) => {
    const expected = (i * GOLDEN_ANGLE) % 360;
    assert.ok(Math.abs(s.azimuth - expected) < 1e-9, `azimuth off at petal ${i}`);
    assert.ok(Math.abs(s.twist) <= 12, `twist out of range at petal ${i}`);
    assert.ok(s.size >= 0.52 && s.size <= 1, `size out of range at petal ${i}`);
  });
  assert.ok(specs[0].open < specs.at(-1).open, 'outer petals must open wider than the heart');
});

test('poppyPetals is two small inner petals inside four big ones', () => {
  const specs = poppyPetals();
  assert.equal(specs.length, 6);
  const inner = specs.slice(0, 2);
  const outer = specs.slice(2);
  const maxInnerOpen = Math.max(...inner.map((s) => s.open));
  const minOuterOpen = Math.min(...outer.map((s) => s.open));
  assert.ok(maxInnerOpen < minOuterOpen, 'inner petals must stay tighter');
  for (const s of inner) assert.ok(s.size < outer[0].size, 'inner petals must be smaller');
});

test('lilyPetals throws six petals wide with recurved tips', () => {
  const specs = lilyPetals();
  assert.equal(specs.length, 6);
  const ringA = specs.slice(0, 3).map((s) => s.azimuth);
  const ringB = specs.slice(3).map((s) => s.azimuth);
  assert.deepEqual(ringA, [0, 120, 240]);
  assert.deepEqual(ringB, [60, 180, 300]);
  for (const s of specs) assert.ok(s.bend >= 25, 'lily tips must recurve hard');
});

test('carnationPetals ruffles harder than a rose, but stays renderable', () => {
  const specs = carnationPetals(24);
  assert.equal(specs.length, 24);
  specs.forEach((s, i) => {
    // Twist above ~8deg makes every petal plane slice its neighbours and
    // the compositor's plane-splitting goes quadratic (found the hard way:
    // two carnations wedged the renderer for minutes).
    assert.ok(Math.abs(s.twist) <= 8, `twist out of range at petal ${i}`);
    assert.ok(s.size >= 0.6 && s.size <= 1, `size out of range at petal ${i}`);
  });
  assert.ok(specs.some((s) => Math.abs(s.twist) > 4), 'the ruffle must still twist');
});

test('lavenderWhorls climbs the stem and shrinks toward the tip', () => {
  const levels = 6;
  const per = 4;
  const specs = lavenderWhorls(levels, per);
  assert.equal(specs.length, levels * per);
  for (let k = 1; k < levels; k++) {
    const below = specs[(k - 1) * per];
    const here = specs[k * per];
    assert.ok(here.y < below.y, `whorl ${k} must sit higher (more negative y)`);
    assert.ok(here.size < below.size, `whorl ${k} must be smaller`);
  }
  for (const s of specs) assert.ok(s.y < 0, 'buds must sit above the seat');
});

test('spherePoints spreads n points on the sphere surface', () => {
  const n = 16;
  const radius = 19;
  const pts = spherePoints(n, radius);
  assert.equal(pts.length, n);
  for (const p of pts) {
    const d = Math.hypot(p.x, p.y, p.z);
    assert.ok(Math.abs(d - radius) < 1e-9, 'every point must sit on the sphere');
  }
  assert.deepEqual(pts, spherePoints(n, radius), 'must be deterministic');
});

test('bouquetSeats spreads, shrinks and staggers a crowded ring', () => {
  // A fuller ring must push heads further out and make them smaller,
  // so neighbours stop slicing through each other.
  const sparse = bouquetSeats(4);
  const crowded = bouquetSeats(7);
  assert.ok(crowded[1].r > sparse[1].r, 'crowded ring must sit wider');
  assert.ok(crowded[1].s < sparse[1].s, 'crowded ring heads must shrink');
  // Adjacent heads in a ring must not sit at the same height: the stagger
  // interleaves them vertically instead of letting petals share a plane.
  for (let i = 2; i <= 6; i++) {
    assert.notEqual(crowded[i].y, crowded[i - 1].y, `no stagger between ring seats ${i - 1} and ${i}`);
  }
  // The outer ring staggers too.
  const full = bouquetSeats(12);
  const outer = full.slice(8);
  for (let i = 1; i < outer.length; i++) {
    assert.notEqual(outer[i].y, outer[i - 1].y, `no stagger in outer ring at ${i}`);
  }
});

test('bouquetSeats builds a dome, center-out, capped at MAX_STEMS', () => {
  assert.equal(bouquetSeats(1).length, 1);
  assert.equal(bouquetSeats(1)[0].r, 0);
  assert.equal(bouquetSeats(7).length, 7);
  assert.equal(bouquetSeats(20).length, MAX_STEMS);
  for (const n of [2, 3, 5, 9, 12]) {
    const seats = bouquetSeats(n);
    assert.equal(seats.length, n);
    for (let i = 1; i < seats.length; i++) {
      assert.ok(seats[i].r >= seats[i - 1].r, `seats must be ordered center-out (n=${n})`);
    }
    for (const seat of seats) {
      assert.ok(seat.y < 0, 'heads must sit above the wrap');
      assert.ok(seat.s > 0.9 && seat.s < 1.6, 'seat scale must stay in range');
      assert.ok(seat.tilt >= 0 && seat.tilt <= 40, 'tilt must stay in range');
    }
  }
});

test('waveEdgePoints draws a smooth scallop, not razor teeth', () => {
  const depth = 9;
  const pts = waveEdgePoints(1, depth, 20);
  assert.equal(pts.length, 21, 'samples + 1 points');
  assert.ok(Math.abs(pts[0].y) < 1e-9, 'edge must start at the top');
  assert.ok(Math.abs(pts.at(-1).y) < 1e-9, 'edge must end at the top');
  assert.ok(Math.abs(pts[10].y - depth) < 1e-9, 'one wave must dip to full depth mid-face');
  for (const p of pts) {
    assert.ok(p.x >= 0 && p.x <= 100, 'x must be a percentage');
    assert.ok(p.y >= -1e-9 && p.y <= depth + 1e-9, 'y must stay inside the depth band');
  }
  // Smoothness is the whole point: no adjacent step may jump like a V-tooth.
  for (let i = 1; i < pts.length; i++) {
    assert.ok(Math.abs(pts[i].y - pts[i - 1].y) < depth / 4, `step too sharp at ${i}`);
  }
  // Symmetric arc for a single wave.
  for (let i = 0; i < 10; i++) {
    assert.ok(Math.abs(pts[i].y - pts[20 - i].y) < 1e-9, `asymmetric at ${i}`);
  }
});

test('waveEdgePoints phase keeps facet seams continuous', () => {
  // Faces share their clip, so the first and last point of one facet's
  // edge must land at the same height no matter the phase.
  for (const phase of [0, 0.25, 0.5]) {
    const pts = waveEdgePoints(1, 9, 20, phase);
    assert.ok(Math.abs(pts[0].y - pts.at(-1).y) < 1e-9, `seam jump at phase ${phase}`);
  }
  // A half-wave phase flips the scallop: peaks where the in-phase edge dips.
  const inPhase = waveEdgePoints(1, 9, 20, 0);
  const offset = waveEdgePoints(1, 9, 20, 0.5);
  assert.ok(Math.abs(inPhase[10].y - 9) < 1e-9);
  assert.ok(Math.abs(offset[10].y) < 1e-9, 'offset wave must peak mid-face');
});

test('stepCount steps a stem count up and down without mutating the order', () => {
  const start = { rose: 2, tulip: 0 };
  const up = stepCount(start, 'tulip', 1);
  assert.equal(up.tulip, 1);
  assert.equal(up.rose, 2);
  const down = stepCount(up, 'rose', -1);
  assert.equal(down.rose, 1);
  assert.equal(start.rose, 2, 'input must not be mutated');
  assert.equal(start.tulip, 0, 'input must not be mutated');
});

test('stepCount refuses to leave the wrap over- or under-full', () => {
  const empty = { rose: 0 };
  assert.equal(stepCount(empty, 'rose', -1), empty, 'below zero must be a no-op');
  const full = { rose: MAX_STEMS - 2, tulip: 2 };
  assert.equal(orderTotal(full), MAX_STEMS);
  assert.equal(stepCount(full, 'tulip', 1), full, 'over the cap must be a no-op');
  const almostFull = { rose: MAX_STEMS - 2, tulip: 1 };
  assert.equal(stepCount(almostFull, 'tulip', 1).tulip, 2, 'last free stem must still work');
  assert.equal(stepCount(full, 'rose', -1).rose, MAX_STEMS - 3, 'stepping down while full must work');
});

test('surpriseCounts fills the wrap with a small mixed bunch', () => {
  const keys = ['rose', 'peony', 'sunflower', 'lily', 'poppy', 'tulip', 'daisy'];
  // A tiny deterministic LCG stands in for Math.random.
  const lcg = (seed) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let seed = 1; seed <= 40; seed++) {
    const counts = surpriseCounts(keys, lcg(seed));
    const total = orderTotal(counts);
    assert.ok(total >= 6 && total <= MAX_STEMS, `total ${total} out of range (seed ${seed})`);
    const picked = Object.entries(counts).filter(([, n]) => n > 0);
    assert.ok(picked.length >= 2 && picked.length <= 4, `${picked.length} types picked (seed ${seed})`);
    for (const [key, n] of Object.entries(counts)) {
      assert.ok(keys.includes(key), `unknown key ${key}`);
      assert.ok(Number.isInteger(n) && n >= 0, `bad count for ${key}`);
    }
  }
  assert.deepEqual(surpriseCounts(keys, lcg(7)), surpriseCounts(keys, lcg(7)), 'same rand, same bunch');
});

test('coneFaces builds a matching truncated cone', () => {
  const n = 13;
  const faces = coneFaces(n, 96, 30, 168);
  assert.equal(faces.length, n);
  const chord = 2 * 96 * Math.sin(Math.PI / n);
  const tilt = (Math.atan2(96 - 30, 168) * 180) / Math.PI;
  faces.forEach((f, i) => {
    assert.equal(f.angle, (i * 360) / n);
    assert.ok(Math.abs(f.width - chord) < 1e-9, 'face width must equal the top chord');
    assert.ok(Math.abs(f.bottomFrac - 30 / 96) < 1e-9);
    assert.ok(Math.abs(f.tilt - tilt) < 1e-9);
    assert.ok(f.push > 0 && f.push < 96, 'push must sit inside the top radius');
  });
});

test('hashId is deterministic, base36, and input-sensitive', () => {
  const a = hashId('rose:3|tulip:2|hello mum|1720000000000');
  assert.equal(a, hashId('rose:3|tulip:2|hello mum|1720000000000'), 'same input, same id');
  assert.match(a, /^[a-z0-9]{1,11}$/, 'must fit the server-side [a-z0-9] sanitizer');
  assert.notEqual(a, hashId('rose:3|tulip:2|hello mum|1720000000001'), 'a changed input must move the id');
  assert.notEqual(hashId('x'), hashId('x', 1), 'the seed must matter');
});

test('normalizeShareOrder keeps only known species with sane counts', () => {
  const keys = ['rose', 'tulip', 'daisy'];
  assert.deepEqual(normalizeShareOrder(undefined, keys), []);
  assert.deepEqual(normalizeShareOrder('junk', keys), []);
  assert.deepEqual(normalizeShareOrder([{ type: 'orchid', count: 3 }], keys), []);
  assert.deepEqual(
    normalizeShareOrder(
      [
        { type: 'rose', count: 3 },
        null,
        { type: 'tulip', count: '2' },
        { type: 'daisy', count: 0 },
        { type: 'rose', count: -4 },
        { count: 2 },
      ],
      keys,
    ),
    [{ type: 'rose', count: 3 }, { type: 'tulip', count: 2 }],
    'junk entries drop, numeric strings floor to ints',
  );
});

test('normalizeShareOrder merges duplicates and caps the total at the wrap', () => {
  const keys = ['rose', 'tulip'];
  assert.deepEqual(
    normalizeShareOrder([{ type: 'rose', count: 2 }, { type: 'rose', count: 1 }], keys),
    [{ type: 'rose', count: 3 }],
  );
  const capped = normalizeShareOrder(
    [{ type: 'rose', count: 9 }, { type: 'tulip', count: 99 }],
    keys,
  );
  assert.deepEqual(capped, [{ type: 'rose', count: 9 }, { type: 'tulip', count: 3 }]);
  const flood = normalizeShareOrder([{ type: 'rose', count: 1e9 }], keys);
  assert.deepEqual(flood, [{ type: 'rose', count: 12 }], 'a crafted giant count clamps to MAX_STEMS');
});
