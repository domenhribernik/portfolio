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
  dandelionTufts,
  domeProfile,
  DOME_ANCHORS,
  SEAT_RMAX,
  PACK_FACTOR,
  SHRINK_FLOOR,
  HEAD_RADII,
  DEFAULT_HEAD_R,
  bouquetSeats,
  seatPoint,
  spineSeat,
  stemPath,
  STEM_BIND,
  OVERLAP_EPS,
  mixHex,
  renderTier,
  tierPetals,
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
    assert.ok(s.open >= 70.2 - 6 && s.open <= 70.2 + 6, `droop out of range at ${i}`);
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

/* Plan-view (looking straight down the axis) position of a seat. */
function planXZ(seat) {
  const rad = (seat.a * Math.PI) / 180;
  return { x: seat.r * Math.cos(rad), z: seat.r * Math.sin(rad) };
}

/* The tightest pair's separation as a fraction of what the pack requires.
   >= 1 means no pair is closer than PACK_FACTOR * summed visual radii. */
function minGapRatio(seats, sizes) {
  let worst = Infinity;
  for (let i = 0; i < seats.length; i++) {
    for (let j = i + 1; j < seats.length; j++) {
      const a = planXZ(seats[i]);
      const b = planXZ(seats[j]);
      const dist = Math.hypot(a.x - b.x, a.z - b.z);
      const required = (sizes[i] * seats[i].s + sizes[j] * seats[j].s) * PACK_FACTOR;
      if (required > 0) worst = Math.min(worst, dist / required);
    }
  }
  return worst;
}

test('domeProfile pins the focal center of the dome', () => {
  const c = domeProfile(0);
  assert.equal(c.y, -100, 'center head sits highest');
  assert.equal(c.tilt, 0, 'center head stands upright');
  assert.equal(c.s, 1.4, 'center head is the largest');
});

test('domeProfile flattens and shrinks toward the rim', () => {
  let prevY = -Infinity;
  let prevTilt = -Infinity;
  let prevS = Infinity;
  for (let r = 0; r <= SEAT_RMAX; r += 4) {
    const p = domeProfile(r);
    assert.ok(p.y >= prevY - 1e-9, `heads must not rise going outward at r=${r}`);
    assert.ok(p.tilt >= prevTilt - 1e-9, `tilt must not decrease going outward at r=${r}`);
    assert.ok(p.s <= prevS + 1e-9, `heads must not grow going outward at r=${r}`);
    assert.ok(p.tilt >= 0 && p.tilt <= 40, `tilt out of band at r=${r}`);
    assert.ok(p.s >= 0.9 && p.s <= 1.4, `scale out of band at r=${r}`);
    assert.ok(p.y < 0, `every head sits above the wrap at r=${r}`);
    prevY = p.y;
    prevTilt = p.tilt;
    prevS = p.s;
  }
});

test('domeProfile clamps outside the dome', () => {
  assert.deepEqual(domeProfile(-5), domeProfile(0), 'below zero clamps to the center');
  assert.deepEqual(domeProfile(200), domeProfile(SEAT_RMAX), 'past the rim clamps to the edge');
  const anchors = DOME_ANCHORS;
  assert.ok(Array.isArray(anchors) && anchors.length >= 2, 'anchors must be a table');
  assert.equal(anchors[0].r, 0, 'first anchor is the center');
  assert.equal(anchors.at(-1).r, SEAT_RMAX, 'last anchor is the rim');
});

test('bouquetSeats keeps the literal 1, 2 and 3 stem arrangements', () => {
  assert.deepEqual(bouquetSeats(1), [{ a: 0, r: 0, y: -100, tilt: 0, s: 1.42 }]);
  const two = bouquetSeats(2);
  assert.equal(two.length, 2);
  assert.deepEqual(
    two.map((s) => ({ r: s.r, y: s.y, tilt: s.tilt, s: s.s })),
    [{ r: 34, y: -90, tilt: 16, s: 1.32 }, { r: 34, y: -90, tilt: 16, s: 1.32 }],
  );
  assert.equal(two[0].a, 0 + jitter(0, 8));
  assert.equal(two[1].a, 180 + jitter(1, 8));
  const three = bouquetSeats(3);
  assert.equal(three.length, 3);
  for (const s of three) {
    assert.deepEqual({ r: s.r, y: s.y, tilt: s.tilt, s: s.s }, { r: 44, y: -86, tilt: 20, s: 1.28 });
  }
  assert.deepEqual(three.map((s, i) => s.a), [0, 120, 240].map((a, i) => a + jitter(i, 10)));
});

test('bouquetSeats pins seat 0 at the center and caps at MAX_STEMS', () => {
  assert.equal(bouquetSeats(20).length, MAX_STEMS);
  for (let n = 4; n <= 12; n++) {
    const seats = bouquetSeats(n);
    assert.equal(seats.length, n, `wrong count at n=${n}`);
    assert.equal(seats[0].r, 0, `seat 0 must be centered (n=${n})`);
    assert.equal(seats[0].tilt, 0, `seat 0 must stand upright (n=${n})`);
    assert.equal(seats[0].y, -100, `seat 0 must sit highest (n=${n})`);
  }
});

test('bouquetSeats stays inside the wrap', () => {
  for (let n = 4; n <= 12; n++) {
    for (const seat of bouquetSeats(n)) {
      assert.ok(seat.r <= SEAT_RMAX + 1e-9, `r ${seat.r} exceeds SEAT_RMAX (n=${n})`);
      assert.ok(seat.r >= 0, `r must be non-negative (n=${n})`);
      assert.ok(Number.isFinite(seat.a), `azimuth must be finite (n=${n})`);
    }
  }
});

test('bouquetSeats keeps every pair of heads apart for n 4 to 12', () => {
  for (let n = 4; n <= 12; n++) {
    const sizes = Array.from({ length: n }, (_, i) => 24 + (i % 3) * 5); // 24, 29, 34 mix
    const seats = bouquetSeats(n, sizes);
    assert.ok(minGapRatio(seats, sizes) >= 1 - 1e-6, `heads overlap at n=${n}`);
  }
});

test('bouquetSeats separates mixed species by their head sizes', () => {
  const mixes = [
    [33, 18, 24, 33, 18, 24, 33],          // default-order rose/tulip/daisy sizes
    [33, 33, 24, 12, 33, 24, 12, 26, 33],  // bloom hero mix of 9
    [35, 30, 26, 24, 18, 34, 24, 33],      // 8-stem spread
    [24, 24, 12, 12, 33, 33],              // dandelion + lavender + roses
  ];
  for (const sizes of mixes) {
    const seats = bouquetSeats(sizes.length, sizes);
    assert.ok(minGapRatio(seats, sizes) >= 1 - 1e-6, `overlap in mix of ${sizes.length}`);
  }
});

test('bouquetSeats shrinks a crush of big heads instead of overlapping them', () => {
  const n = 12;
  const sizes = Array(n).fill(35); // twelve sunflowers, the worst real order
  const seats = bouquetSeats(n, sizes);
  assert.ok(minGapRatio(seats, sizes) >= 1 - 1e-6, 'must not overlap even when crushed');
  for (let i = 0; i < n; i++) {
    const dome = domeProfile(seats[i].r).s;
    assert.ok(seats[i].s >= SHRINK_FLOOR * dome - 1e-9, `seat ${i} shrank below the floor`);
    assert.ok(seats[i].s <= dome + 1e-9, `seat ${i} grew past its dome scale`);
  }
  for (let i = 1; i < n; i++) {
    assert.ok(seats[0].s >= seats[i].s - 1e-9, 'the center head must stay the largest');
  }
});

test('bouquetSeats is deterministic', () => {
  for (const n of [4, 7, 9, 12]) {
    const sizes = Array.from({ length: n }, (_, i) => 20 + i);
    assert.deepEqual(bouquetSeats(n, sizes), bouquetSeats(n, sizes), `n=${n} not deterministic`);
  }
});

test('HEAD_RADII covers the whole stall', () => {
  const keys = ['rose', 'peony', 'sunflower', 'lily', 'poppy', 'tulip', 'daisy', 'carnation', 'dandelion', 'lavender'];
  for (const k of keys) {
    assert.equal(typeof HEAD_RADII[k], 'number', `missing head radius for ${k}`);
    assert.ok(HEAD_RADII[k] >= 10 && HEAD_RADII[k] <= 40, `head radius out of range for ${k}`);
  }
  assert.equal(Object.keys(HEAD_RADII).length, keys.length, 'no stray species in HEAD_RADII');
  assert.ok(DEFAULT_HEAD_R >= 10 && DEFAULT_HEAD_R <= 40, 'default head radius out of range');
});

test('bouquetSeats keeps the dome silhouette', () => {
  for (let n = 4; n <= 12; n++) {
    const seats = bouquetSeats(n);
    for (const seat of seats) {
      assert.ok(seat.y < 0, `head must sit above the wrap (n=${n})`);
      assert.ok(seat.tilt >= 0 && seat.tilt <= 40, `tilt out of band (n=${n})`);
      assert.ok(seat.s >= 0.7 && seat.s <= 1.45, `scale out of band (n=${n})`);
    }
    // Heads further from the axis sit lower (dome, not a flat disc), allowing
    // for the small upward stagger.
    for (let i = 0; i < seats.length; i++) {
      for (let j = 0; j < seats.length; j++) {
        if (seats[j].r >= seats[i].r + 20) {
          assert.ok(seats[j].y >= seats[i].y - 3, `dome inverted at n=${n} (${i} vs ${j})`);
        }
      }
    }
  }
});

test('bouquetSeats staggers seats upward only', () => {
  for (let n = 4; n <= 12; n++) {
    for (const seat of bouquetSeats(n)) {
      assert.ok(seat.y <= domeProfile(seat.r).y + 1e-9, `seat dropped below the dome (n=${n})`);
    }
  }
});

test('bouquetSeats never leaves two heads at one height', () => {
  for (let n = 4; n <= 12; n++) {
    const seats = bouquetSeats(n);
    for (let i = 0; i < seats.length; i++) {
      for (let j = i + 1; j < seats.length; j++) {
        const a = planXZ(seats[i]);
        const b = planXZ(seats[j]);
        if (Math.hypot(a.x - b.x, a.z - b.z) <= 60) {
          assert.ok(
            Math.abs(seats[i].y - seats[j].y) >= 1,
            `neighbours share a plane at n=${n} (seats ${i}, ${j})`,
          );
        }
      }
    }
  }
});

test('bouquetSeats fills the dome without voids', () => {
  for (let n = 8; n <= 12; n++) {
    const R = 30;
    const sizes = Array(n).fill(R);
    const seats = bouquetSeats(n, sizes);
    // Walk the heads outward by radius: each head's disc must start covering
    // before the previous coverage ends, so no empty ring band is left. This
    // is edge-to-edge (the big center head fills the moat around the axis),
    // not a naive gap between seat-center radii.
    const sorted = [...seats].sort((a, b) => a.r - b.r);
    let reach = 0;
    for (const seat of sorted) {
      const vis = R * seat.s;
      assert.ok(seat.r - vis <= reach + 1e-6, `radial void before r=${seat.r.toFixed(1)} at n=${n}`);
      reach = Math.max(reach, seat.r + vis);
    }
    assert.ok(reach >= SEAT_RMAX, `dome edge unreached at n=${n}`);
  }
});

test('seatPoint projects a seat local point into the bouquet frame', () => {
  // Upright seat: stepping down the local stem is a pure y drop, scaled.
  const up = seatPoint({ r: 40, y: -80, tilt: 0, s: 1 }, 10);
  assert.ok(Math.abs(up.z - 40) < 1e-9, 'no radial shift when upright');
  assert.ok(Math.abs(up.y - (-70)) < 1e-9, 'y drops by localY when upright');
  const scaled = seatPoint({ r: 40, y: -80, tilt: 0, s: 1.5 }, 10);
  assert.ok(Math.abs(scaled.y - (-65)) < 1e-9, 'scale multiplies the drop');
  // Tilted seat leans the drop inward: the dandelion seat, 6 down its spine.
  const d = seatPoint({ r: 76, y: -34, tilt: 30, s: 0.91 }, 6);
  assert.ok(Math.abs(d.z - 73.27) < 0.05, `z was ${d.z}`);
  assert.ok(Math.abs(d.y - -29.27) < 0.05, `y was ${d.y}`);
});

test('seatPoint is identity at the origin', () => {
  const p = seatPoint({ r: 55, y: -60, tilt: 33, s: 1.2 }, 0);
  assert.equal(p.z, 55);
  assert.equal(p.y, -60);
});

test('spineSeat lands a self-stemmed head exactly on its dome seat', () => {
  // A spine species (dandelion, lavender) carries its head `lift` up its own
  // stalk. Sinking the seat straight down (the old static seatAdjust) throws
  // the head radially outside the wrap on tilted rim seats (70 * sin(40deg)
  // is ~45px of overshoot: the "white dots in the sky" bug). spineSeat sinks
  // the seat along the tilted spine axis instead, so the head comes back to
  // the exact point the dome packer reserved for it.
  const seats = [
    { a: 20, r: 0, stag: 0, y: -100, tilt: 0, s: 1.2 },
    { a: 130, r: 54, stag: 4, y: -88, tilt: 22, s: 1.22 },
    { a: 250, r: 76, stag: 0, y: -60, tilt: 38, s: 0.78 },
    { a: 305, r: SEAT_RMAX, stag: 8, y: -62, tilt: 40, s: 0.94 },
  ];
  for (const seat of seats) {
    for (const lift of [70, 62]) {
      const planted = spineSeat(seat, lift);
      const head = seatPoint(planted, -lift);
      assert.ok(near(head.z, seat.r, 1e-9), `head z ${head.z} misses dome r ${seat.r}`);
      assert.ok(near(head.y, seat.y, 1e-9), `head y ${head.y} misses dome y ${seat.y}`);
      // Everything but the planting point is untouched, and the input seat
      // is not mutated (the packer's seats are shared state).
      assert.equal(planted.a, seat.a);
      assert.equal(planted.stag, seat.stag);
      assert.equal(planted.tilt, seat.tilt);
      assert.equal(planted.s, seat.s);
      assert.notEqual(planted, seat);
    }
  }
});

test('dandelionTufts spreads sized tufts over the clock sphere', () => {
  const tufts = dandelionTufts(22, 17, 3);
  assert.equal(tufts.length, 22);
  for (const t of tufts) {
    const rr = Math.hypot(t.x, t.y, t.z);
    assert.ok(near(rr, 17, 1e-6), `tuft off the sphere shell: ${rr}`);
    assert.ok(t.d >= 8 && t.d <= 13, `tuft size ${t.d} out of range`);
  }
  // Deterministic per seed, varied across seeds (per-instance variety).
  assert.deepEqual(dandelionTufts(22, 17, 3), tufts);
  assert.notDeepEqual(dandelionTufts(22, 17, 4).map((t) => t.d), tufts.map((t) => t.d));
});

test('dandelionTufts covers the shell densely enough to read as down', () => {
  // The "white dots in the sky" half of the bug: tufts whose ink covers a
  // few percent of the sphere read as loose specks, not a downy ball. Each
  // crossed tuft pair inks roughly a d-sized disc; the defaults must keep
  // that total above a third of the shell's area.
  const tufts = dandelionTufts();
  const shell = 4 * Math.PI * 17 * 17;
  const ink = tufts.reduce((sum, t) => sum + Math.PI * (t.d / 2) ** 2, 0);
  assert.ok(tufts.length >= 20, `only ${tufts.length} tufts`);
  assert.ok(ink / shell >= 0.34, `ink covers only ${(ink / shell * 100).toFixed(0)}% of the shell`);
});

test('spineSeat keeps the stalk inside the wrap', () => {
  // The planted seat (and the spine foot just below it) must sit in the
  // throat, under the rim (y -18), not hover in the air beside the cone:
  // that is what hides the hand-off from the species' own spine to the
  // curved bundle stem.
  for (const r of [0, 40, 66, SEAT_RMAX]) {
    const p = domeProfile(r);
    const planted = spineSeat({ a: 0, r, stag: 0, y: p.y, tilt: p.tilt, s: p.s }, 70);
    assert.ok(planted.y > -18, `seat y ${planted.y} floats above the rim at r=${r}`);
    assert.ok(Math.abs(planted.r) <= 96, `seat r ${planted.r} outside the cone at r=${r}`);
  }
});

/* Reconstruct a stem chord's two ends from its stored midpoint, tilt (seat
   convention: down-axis is (-sin, cos)) and length. */
function chordEnds(ch) {
  const t = (ch.tilt * Math.PI) / 180;
  const dz = -Math.sin(t);
  const dy = Math.cos(t);
  const half = ch.len / 2;
  return {
    top: { z: ch.z - dz * half, y: ch.y - dy * half },
    bottom: { z: ch.z + dz * half, y: ch.y + dy * half },
  };
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

test('stemPath runs from the head base to the bind point', () => {
  const seat = { r: 66, y: -78, tilt: 27, s: 1.1 };
  const path = stemPath(seat, { segments: 4, seed: 3 });
  const p0 = seatPoint(seat, 0);
  const topEnd = chordEnds(path[0]).top;
  assert.ok(near(topEnd.z, p0.z, OVERLAP_EPS + 0.05), `top z ${topEnd.z} vs ${p0.z}`);
  assert.ok(near(topEnd.y, p0.y, OVERLAP_EPS + 0.05), `top y ${topEnd.y} vs ${p0.y}`);
});

test('stemPath keeps consecutive segments connected', () => {
  const seat = { r: 72, y: -60, tilt: 38, s: 1 };
  const path = stemPath(seat, { segments: 4, seed: 5 });
  for (let i = 1; i < path.length; i++) {
    const prevBottom = chordEnds(path[i - 1]).bottom;
    const thisTop = chordEnds(path[i]).top;
    assert.ok(near(prevBottom.z, thisTop.z, 2 * OVERLAP_EPS), `z gap at joint ${i}`);
    assert.ok(near(prevBottom.y, thisTop.y, 2 * OVERLAP_EPS), `y gap at joint ${i}`);
  }
});

test('stemPath bends monotonically toward the axis', () => {
  const seat = { r: 76, y: -58, tilt: 38, s: 1 };
  const path = stemPath(seat, { segments: 6, seed: 2 });
  for (let i = 1; i < path.length; i++) {
    assert.ok(path[i].z <= path[i - 1].z + 1e-6, `z rose at chord ${i}`);
    assert.ok(path[i].y > path[i - 1].y, `y did not descend at chord ${i}`);
  }
});

test('stemPath enters the flower along its tilt', () => {
  for (const tilt of [12, 27, 38]) {
    const path = stemPath({ r: 60, y: -70, tilt, s: 1 }, { segments: 4, seed: 1 });
    assert.ok(Math.abs(path[0].tilt - tilt) <= 8, `first chord ${path[0].tilt} not near ${tilt}`);
  }
});

test('stemPath ties off near the base of the wrap', () => {
  // The wrap cone runs from the rim (y -18) down to its base (y 150) in the
  // bouquet frame. The bundle gathers LOW, almost at the base: a high tie
  // point curls every stem toward the axis right under the heads (harsh
  // bends, empty throat); a deep one lets them run long and near-straight.
  for (const seed of [0, 1, 2, 3, 7]) {
    for (const seat of [{ r: 70, y: -62, tilt: 36, s: 1 }, { r: 0, y: -100, tilt: 0, s: 1.4 }]) {
      const end = chordEnds(stemPath(seat, { segments: 4, seed }).at(-1)).bottom;
      assert.ok(Math.abs(end.z) <= STEM_BIND.rMax + OVERLAP_EPS + 0.5, `bind z ${end.z} outside throat`);
      assert.ok(end.y >= 100, `bind y ${end.y} ties off too high up the throat`);
      assert.ok(end.y <= 145, `bind y ${end.y} pokes out of the wrap's base`);
    }
  }
});

test('stemPath straightens as it descends into the bundle', () => {
  // The deep tie point is what makes the bend gentle: each chord leans less
  // than the one above it, and the stem arrives at the bind near-vertical.
  // (With the old rim-high tie, stems arrived ~52deg off vertical: the harsh
  // inward curl right below the heads this locks out.)
  for (const seed of [1, 4, 8]) {
    for (const seat of [{ r: 76, y: -58, tilt: 38, s: 1 }, { r: 60, y: -80, tilt: 24, s: 1.15 }]) {
      const path = stemPath(seat, { segments: 4, seed });
      for (let i = 1; i < path.length; i++) {
        assert.ok(
          Math.abs(path[i].tilt) <= Math.abs(path[i - 1].tilt) + 1e-6,
          `chord ${i} leans harder than the one above it (seed ${seed})`,
        );
      }
      assert.ok(Math.abs(path.at(-1).tilt) <= 15, `arrives ${path.at(-1).tilt}deg off vertical (seed ${seed})`);
    }
  }
});

test('stemPath handles the upright center flower', () => {
  const path = stemPath({ r: 0, y: -100, tilt: 0, s: 1.4 }, { segments: 4, seed: 9 });
  for (const ch of path) {
    assert.ok([ch.z, ch.y, ch.tilt, ch.len].every(Number.isFinite), 'no NaN in a center stem');
  }
  assert.ok(chordEnds(path.at(-1)).bottom.y > chordEnds(path[0]).top.y, 'center stem must run downward');
});

test('stemPath handles a foot already inside the throat', () => {
  const seat = { r: 68, y: -40, tilt: 28, s: 1 };
  const path = stemPath(seat, { segments: 4, seed: 4, footY: 60 });
  const p0 = seatPoint(seat, 60);
  const end = chordEnds(path.at(-1)).bottom;
  assert.ok(end.y >= p0.y + STEM_BIND.minDrop - OVERLAP_EPS, `bind ${end.y} not below foot ${p0.y}`);
  for (let i = 1; i < path.length; i++) {
    assert.ok(path[i].y > path[i - 1].y - 1e-6, 'greenery stem still descends');
  }
});

test('stemPath emits the asked segment count', () => {
  assert.equal(stemPath({ r: 60, y: -70, tilt: 30, s: 1 }, { segments: 3, seed: 1 }).length, 3);
  assert.equal(stemPath({ r: 60, y: -70, tilt: 30, s: 1 }, { segments: 4, seed: 1 }).length, 4);
});

test('stemPath is deterministic per seed and differs across seeds', () => {
  const seat = { r: 66, y: -72, tilt: 30, s: 1 };
  assert.deepEqual(stemPath(seat, { seed: 5 }), stemPath(seat, { seed: 5 }));
  assert.notDeepEqual(stemPath(seat, { seed: 5 }), stemPath(seat, { seed: 6 }));
});

test('mixHex blends stem greens channel by channel', () => {
  assert.equal(mixHex('#000000', '#ffffff', 0), '#000000');
  assert.equal(mixHex('#000000', '#ffffff', 1), '#ffffff');
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
  assert.match(mixHex('#35522e', '#6f9457', 0.3), /^#[0-9a-f]{6}$/);
});

test('renderTier goes lite only for coarse pointers', () => {
  assert.equal(renderTier({ coarse: true }), 'lite');
  assert.equal(renderTier({ coarse: false }), 'full');
  assert.equal(renderTier({ coarse: false, reducedMotion: true }), 'full', 'reduced motion alone stays full');
  assert.equal(renderTier({}), 'full');
});

test('tierPetals trims dense heads by a third with a floor', () => {
  assert.equal(tierPetals('full', 24), 24, 'full keeps every petal');
  assert.equal(tierPetals('full', 15), 15);
  assert.equal(tierPetals('lite', 24), 16);
  assert.equal(tierPetals('lite', 15), 10);
  assert.equal(tierPetals('lite', 14), 9);
  assert.equal(tierPetals('lite', 11), 8, 'floor holds when two thirds dips under it');
  assert.equal(tierPetals('lite', 9, 6), 6, 'a lower floor is honoured');
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
