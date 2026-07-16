/* Unit tests for views/wildflowers/logic.js (pure math for the WebGL
   regrowth of the flowers bouquet). Run: node --test tests/ */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PETAL_SHAPES, petalPoint, petalGeometryData, petalVertexColors,
  rampHex, hexToRgb,
  SPECIES, speciesIndex, orderInstances, bouquetPlan, stemPlan,
  WRAP, wrapPoint, CSS_GROUND_Y,
  scatterPoints, meadowField, grassField, MEADOW_PATTERN,
  fpsStats, cssPlaneEquivalent, fmtCount,
  PRESETS, MEADOW_STEPS, surpriseOrder,
  MAX_STEMS,
} from '../views/wildflowers/logic.js';

import { HEAD_RADII, seatPoint, STEM_BIND } from '../views/flowers/logic.js';

const HEX = /^#[0-9a-f]{6}$/i;

/* ------------------------------------------------------------------ */
/* Petal surfaces                                                      */

test('petalPoint: hinge line is flat and anchored at the origin', () => {
  for (const [name, shape] of Object.entries(PETAL_SHAPES)) {
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const p = petalPoint(u, 0, shape);
      assert.equal(p.y, 0, `${name} y at v=0`);
      assert.ok(Math.abs(p.z) < 1e-9, `${name} z at v=0 (got ${p.z})`);
    }
  }
});

test('petalPoint: surface is mirror-symmetric across the midrib', () => {
  for (const [name, shape] of Object.entries(PETAL_SHAPES)) {
    if (shape.crumple) continue; // crumple is deliberately asymmetric
    for (const v of [0.2, 0.5, 0.9]) {
      const a = petalPoint(0.2, v, shape);
      const b = petalPoint(0.8, v, shape);
      assert.ok(Math.abs(a.x + b.x) < 1e-9, `${name} x mirror at v=${v}`);
      assert.ok(Math.abs(a.z - b.z) < 1e-9, `${name} z mirror at v=${v}`);
    }
  }
});

test('petalPoint: length grows monotonically and stays near h', () => {
  for (const [name, shape] of Object.entries(PETAL_SHAPES)) {
    let prev = -1;
    for (let i = 0; i <= 10; i++) {
      const p = petalPoint(0.5, i / 10, shape);
      assert.ok(p.y > prev, `${name} y monotone`);
      prev = p.y;
    }
    assert.ok(prev <= shape.h && prev > shape.h * 0.7, `${name} tip length ${prev} vs h ${shape.h}`);
  }
});

test('petalGeometryData: grid sizes, index bounds, finite values', () => {
  const data = petalGeometryData(PETAL_SHAPES.rose, 6, 8);
  const verts = 7 * 9;
  assert.equal(data.positions.length, verts * 3);
  assert.equal(data.uvs.length, verts * 2);
  assert.equal(data.indices.length, 6 * 8 * 6);
  assert.equal(data.rows, 9);
  assert.equal(data.cols, 7);
  assert.ok(data.positions.every(Number.isFinite));
  assert.ok(data.indices.every((i) => i >= 0 && i < verts));
});

test('petalVertexColors: one rgb per vertex, ramp ends on the right tones', () => {
  const tones = ['#a83f5c', '#e2839a', '#f6c9d3'];
  const colors = petalVertexColors(3, 2, tones);
  assert.equal(colors.length, 3 * 2 * 3);
  assert.ok(colors.every((c) => c >= 0 && c <= 1));
  assert.equal(rampHex(tones, 0), tones[0]);
  assert.equal(rampHex(tones, 0.5), tones[1]);
  assert.equal(rampHex(tones, 1), tones[2]);
});

test('hexToRgb: converts channels to 0..1', () => {
  assert.deepEqual(hexToRgb('#ff0080'), [1, 0, 128 / 255]);
});

/* ------------------------------------------------------------------ */
/* Species catalogue                                                   */

test('SPECIES: every entry is renderable and shares flowers DNA', () => {
  const keys = new Set();
  for (const def of SPECIES) {
    assert.ok(!keys.has(def.key), `duplicate key ${def.key}`);
    keys.add(def.key);
    assert.ok(PETAL_SHAPES[def.shape], `${def.key} shape ${def.shape}`);
    assert.ok(HEAD_RADII[def.key], `${def.key} has a HEAD_RADII entry in flowers/logic.js`);
    assert.ok(def.planesCSS > 0, `${def.key} planesCSS`);
    assert.ok(def.meadow.h[0] > 0 && def.meadow.h[1] >= def.meadow.h[0], `${def.key} meadow heights`);
    assert.ok(def.variants.length >= 1);
    for (const v of def.variants) {
      assert.equal(v.tones.length, 3);
      for (const t of v.tones) assert.match(t, HEX);
    }
    const specs = def.specs(0, 'full');
    assert.ok(specs.length > 0, `${def.key} specs`);
    for (const s of specs) {
      assert.ok(Number.isFinite(s.azimuth), `${def.key} azimuth`);
      assert.ok(Number.isFinite(s.size ?? 1), `${def.key} size`);
    }
  }
});

test('speciesIndex: looks up by key, -1 for unknown', () => {
  assert.equal(speciesIndex('rose'), 0);
  assert.equal(SPECIES[speciesIndex('lavender')].key, 'lavender');
  assert.equal(speciesIndex('carnation'), -1);
});

/* ------------------------------------------------------------------ */
/* Bouquet assembly                                                    */

test('orderInstances: round-robins, promotes a focal head, caps at MAX_STEMS', () => {
  const out = orderInstances([
    { type: 'tulip', count: 2 },
    { type: 'rose', count: 3 },
    { type: 'daisy', count: 2 },
  ]);
  assert.equal(out.length, 7);
  assert.ok(SPECIES[out[0].species].focal, 'seat 0 is focal');
  const roses = out.filter((o) => SPECIES[o.species].key === 'rose');
  assert.equal(roses.length, 3);
  /* variants cycle per instance */
  assert.deepEqual(roses.map((r) => r.variant), [0, 1, 2]);

  const capped = orderInstances([{ type: 'daisy', count: 30 }]);
  assert.equal(capped.length, MAX_STEMS);

  assert.deepEqual(orderInstances([{ type: 'carnation', count: 4 }]), []);
});

test('bouquetPlan: one relaxed seat per instance, lavender sinks its seat', () => {
  const plan = bouquetPlan([
    { type: 'rose', count: 2 },
    { type: 'lavender', count: 1 },
    { type: 'daisy', count: 2 },
  ]);
  assert.equal(plan.length, 5);
  for (const rec of plan) {
    assert.ok(Number.isFinite(rec.seat.a) && Number.isFinite(rec.seat.r));
    assert.ok(rec.seat.y < 0, 'seats sit above the wrap (CSS y up is negative)');
    assert.ok(rec.seat.s > 0);
  }
  const lav = plan.find((r) => SPECIES[r.species].key === 'lavender');
  const other = plan.find((r) => SPECIES[r.species].key === 'daisy');
  assert.ok(lav.seat.y > other.seat.y - 60, 'lavender seatAdjust applied (sunk by 44)');
  assert.deepEqual(bouquetPlan([]), []);
});

test('stemPlan: starts at the seat point, gathers to the deep bind, runs downward', () => {
  const seat = { a: 40, r: 60, y: -80, tilt: 25, s: 1 };
  const pts = stemPlan(seat, { samples: 10, seed: 3, footY: 0 });
  assert.equal(pts.length, 11);
  const p0 = seatPoint(seat, 0);
  assert.ok(Math.abs(pts[0].z - p0.z) < 1e-9 && Math.abs(pts[0].y - p0.y) < 1e-9);
  const end = pts.at(-1);
  assert.ok(Math.abs(end.z) <= STEM_BIND.rMax + 1e-9, 'ties near the axis');
  assert.ok(end.y >= STEM_BIND.yMin - 1e-9, 'ties deep in the wrap');
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i].y >= pts[i - 1].y - 1e-9, 'y (down) never reverses');
  }
});

test('wrapPoint: rim dips by the scallop, radius follows the slope', () => {
  const crest = wrapPoint(0, 1);
  const dip = wrapPoint(0.5 / WRAP.waves, 1);
  assert.ok(Math.abs(crest.y - WRAP.height) < 1e-9);
  assert.ok(Math.abs(crest.y - dip.y - WRAP.waveDepth) < 1e-9, 'full wave depth at mid-facet');
  const base = wrapPoint(0.3, 0);
  assert.equal(base.y, 0);
  assert.ok(Math.abs(base.r - WRAP.rBottom) < 1e-9);
  assert.ok(crest.r <= WRAP.rTop && crest.r > WRAP.rBottom);
  assert.ok(CSS_GROUND_Y > 0);
});

/* ------------------------------------------------------------------ */
/* Meadow scatter                                                      */

test('scatterPoints: deterministic, inside the field ring', () => {
  const a = scatterPoints(200);
  const b = scatterPoints(200);
  assert.deepEqual(a, b);
  for (const p of a) {
    const r = Math.hypot(p.x, p.z);
    assert.ok(r >= 90 - 15 && r <= 1250 + 15, `radius ${r}`);
  }
});

test('meadowField: stable, well-typed, covers every species', () => {
  const field = meadowField(120);
  assert.equal(field.length, 120);
  assert.deepEqual(field, meadowField(120));
  const seen = new Set();
  for (const f of field) {
    const def = SPECIES[f.species];
    assert.ok(def, 'species index valid');
    seen.add(def.key);
    assert.ok(f.variant >= 0 && f.variant < def.variants.length);
    assert.ok(f.height >= def.meadow.h[0] - 1e-9 && f.height <= def.meadow.h[1] + 1e-9);
    assert.ok(f.s >= def.meadow.s[0] - 1e-9 && f.s <= def.meadow.s[1] + 1e-9);
    assert.ok(f.phase >= 0 && f.phase < Math.PI * 2);
  }
  assert.equal(seen.size, SPECIES.length, 'all species grow in a 120-flower field');
  assert.equal(MEADOW_PATTERN.length, SPECIES.reduce((s, d) => s + d.meadow.weight, 0));
});

test('grassField: deterministic with finite blades', () => {
  const g = grassField(50);
  assert.equal(g.length, 50);
  assert.deepEqual(g, grassField(50));
  for (const b of g) {
    assert.ok(Number.isFinite(b.x + b.z + b.s + b.lean + b.phase));
    assert.ok(b.s > 0);
  }
});

/* ------------------------------------------------------------------ */
/* HUD math                                                            */

test('fpsStats: mean fps and 1% lows', () => {
  const steady = fpsStats(new Array(99).fill(10).concat([50]));
  assert.ok(Math.abs(steady.fps - 1000 / 10.4) < 0.5);
  assert.ok(Math.abs(steady.low - 20) < 1e-9, '1% low is the worst frame');
  assert.deepEqual(fpsStats([]), { fps: 0, low: 0 });
  assert.deepEqual(fpsStats([NaN, -5]), { fps: 0, low: 0 });
});

test('cssPlaneEquivalent: sums the paper per-head estimates', () => {
  const stems = [{ species: speciesIndex('rose') }, { species: speciesIndex('sunflower') }];
  assert.equal(cssPlaneEquivalent(stems), 36 + 60);
  assert.equal(cssPlaneEquivalent([]), 0);
});

test('fmtCount: humane numbers for the HUD', () => {
  assert.equal(fmtCount(950), '950');
  assert.equal(fmtCount(1200), '1,200');
  assert.equal(fmtCount(48213), '48k');
  assert.equal(fmtCount(2_310_000), '2.3M');
});

/* ------------------------------------------------------------------ */
/* Presets and surprises                                               */

test('PRESETS: every order is valid and inside the wrap cap', () => {
  for (const p of PRESETS) {
    let total = 0;
    for (const { type, count } of p.order) {
      assert.ok(speciesIndex(type) >= 0, `${p.key} sells ${type}`);
      assert.ok(count > 0);
      total += count;
    }
    assert.ok(total >= 1 && total <= MAX_STEMS, `${p.key} total ${total}`);
    assert.ok(orderInstances(p.order).length === Math.min(total, MAX_STEMS));
  }
  assert.ok(MEADOW_STEPS.every((n, i) => n > 0 && (i === 0 || n > MEADOW_STEPS[i - 1])));
});

test('surpriseOrder: injectable rand, valid species, capped total', () => {
  let calls = 0;
  const rand = () => {
    calls += 1;
    return (calls % 10) / 10;
  };
  const order = surpriseOrder(rand);
  assert.ok(order.length >= 2);
  let total = 0;
  for (const { type, count } of order) {
    assert.ok(speciesIndex(type) >= 0);
    total += count;
  }
  assert.ok(total >= 6 && total <= MAX_STEMS);
});
