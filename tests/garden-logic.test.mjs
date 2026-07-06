import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOLDEN_ANGLE,
  lerp,
  clamp,
  easeOutCubic,
  jitter,
  rosePetals,
  tulipPetals,
  daisyPetals,
  coneFaces,
} from '../views/garden/logic.js';

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
