/* logic.js : pure math for Wild Flowers, the WebGL regrowth of views/flowers.
   No DOM and no three.js in here; everything runs in node
   (tests/wildflowers-logic.test.mjs).

   The flower DNA is imported from ../flowers/logic.js so both renderers grow
   from the same numbers: petal spec functions, the dome seating relaxation,
   the stem bind constants, the head radii. This file only adds what a mesh
   renderer needs and a DOM renderer never did: parametric petal surfaces,
   the meadow scatter, wind phases, and frame statistics. */

import {
  GOLDEN_ANGLE, jitter, lerp, clamp, mixHex,
  rosePetals, peonyPetals, tulipPetals, daisyPetals, sunflowerPetals,
  poppyPetals, lilyPetals, lavenderWhorls,
  bouquetSeats, HEAD_RADII, DEFAULT_HEAD_R, MAX_STEMS,
  seatPoint, STEM_BIND, tierPetals, surpriseCounts,
} from '../flowers/logic.js';

export { jitter, lerp, clamp, mixHex, MAX_STEMS, GOLDEN_ANGLE };

/* The CSS scene's vertical convention is y-down with the ground plane at
   y = 150 (the wrap cone's base). The GL world is y-up with the ground at 0,
   so worldY = CSS_GROUND_Y - cssY everywhere a CSS-frame number crosses over. */
export const CSS_GROUND_Y = 150;

/* ==========================================================================
   Petal surfaces. The CSS version fakes curvature with hinged segment
   chains; here a petal is a real parametric sheet. u runs across the width
   (0..1), v along the length from the hinge (0..1). The hinge is at the
   origin, the petal grows up +y, and its "sky" face looks toward +z, so
   opening a petal is a rotation about +x (the GPU does that per instance).
   ========================================================================== */

export const PETAL_SHAPES = {
  /* w/h: size at scale 1. baseW/tipW: width fractions at the ends; belly:
     where the outline is widest. cup: edges lift toward +z (negative wraps
     them inward, for bud-shaped petals). curl: quadratic bend of the tip
     toward +z (negative folds inward). crumple: baked tissue ripple. */
  rose:      { w: 46, h: 46, baseW: 0.52, belly: 0.55, tipW: 0.72, cup: 0.34, curl: 0.55 },
  peony:     { w: 40, h: 48, baseW: 0.44, belly: 0.50, tipW: 0.62, cup: 0.42, curl: 0.50, crumple: 0.5 },
  tulip:     { w: 30, h: 52, baseW: 0.52, belly: 0.45, tipW: 0.14, cup: -0.5, curl: -0.35 },
  daisy:     { w: 10.5, h: 34, baseW: 0.55, belly: 0.50, tipW: 0.28, cup: 0.16, curl: 0.22 },
  sunflower: { w: 11.5, h: 36, baseW: 0.50, belly: 0.45, tipW: 0.10, cup: 0.20, curl: 0.28 },
  poppy:     { w: 40, h: 44, baseW: 0.42, belly: 0.60, tipW: 0.80, cup: 0.50, curl: 0.30, crumple: 1 },
  lily:      { w: 19, h: 56, baseW: 0.40, belly: 0.45, tipW: 0.08, cup: 0.25, curl: 0.90 },
  bud:       { w: 7, h: 9, baseW: 0.70, belly: 0.50, tipW: 0.40, cup: -0.6, curl: -0.30 },
  leafRound: { w: 19, h: 22, baseW: 0.75, belly: 0.50, tipW: 0.70, cup: 0.10, curl: 0.25 },
  leafBlade: { w: 27, h: 86, baseW: 0.50, belly: 0.40, tipW: 0.10, cup: 0.35, curl: 0.40 },
  tissue:    { w: 58, h: 64, baseW: 0.60, belly: 0.55, tipW: 0.85, cup: 0.22, curl: 0.18, crumple: 0.6 },
  blade:     { w: 2.6, h: 30, baseW: 1.00, belly: 0.30, tipW: 0.06, cup: 0, curl: 0.55 },
};

const smooth = (t) => t * t * (3 - 2 * t);

export function petalPoint(u, v, shape) {
  const { w, h, baseW = 0.4, belly = 0.5, tipW = 0.5, cup = 0.25, curl = 0.3, crumple = 0 } = shape;
  const width = v <= belly
    ? lerp(baseW, 1, smooth(belly <= 0 ? 1 : v / belly))
    : lerp(1, tipW, smooth((v - belly) / (1 - belly)));
  const x = (u - 0.5) * w * width;
  /* All three z terms vanish at v = 0 so the hinge line stays flat where the
     petal meets the flower. */
  let z = 0.5 * curl * h * v * v;
  z += cup * w * 0.5 * (2 * u - 1) * (2 * u - 1) * Math.sin(Math.PI * clamp(v, 0, 1));
  if (crumple) {
    z += crumple * w * 0.06
      * Math.sin(9.4 * u + 2.1 * v) * Math.sin(7.3 * v + 3.1 * u)
      * Math.sin(Math.PI * clamp(v, 0, 1));
  }
  /* Curled petals get a touch shorter, like an arc chord. */
  const y = v * h * (1 - 0.15 * Math.min(1, curl * curl) * v * v);
  return { x, y, z };
}

/* Sample the surface into flat arrays a renderer can wrap in a buffer
   geometry. Returns positions (xyz triplets), uvs, triangle indices, and the
   grid dimensions for anything that needs per-vertex derived data. */
export function petalGeometryData(shape, segU = 8, segV = 10) {
  const positions = [];
  const uvs = [];
  for (let j = 0; j <= segV; j++) {
    for (let i = 0; i <= segU; i++) {
      const u = i / segU;
      const v = j / segV;
      const p = petalPoint(u, v, shape);
      positions.push(p.x, p.y, p.z);
      uvs.push(u, v);
    }
  }
  const indices = [];
  const row = segU + 1;
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * row + i;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return { positions, uvs, indices, rows: segV + 1, cols: segU + 1 };
}

/* The CSS petals paint a three-stop gradient (--c1 deep base, --c2 body,
   --c3 light rim); here the same ramp is baked into vertex colors. */
export function rampHex(tones, t) {
  const [c1, c2, c3] = tones;
  return t < 0.5 ? mixHex(c1, c2, t * 2) : mixHex(c2, c3, (t - 0.5) * 2);
}

export function hexToRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}

/* Per-vertex colors for a petalGeometryData grid: the tone ramp runs along
   the length, and the outer edges darken a whisper so packed petals separate. */
export function petalVertexColors(rows, cols, tones) {
  const colors = [];
  for (let j = 0; j < rows; j++) {
    const t = rows === 1 ? 1 : j / (rows - 1);
    const rgb = hexToRgb(rampHex(tones, t));
    for (let i = 0; i < cols; i++) {
      const u = cols === 1 ? 0.5 : i / (cols - 1);
      const edge = 1 - 0.16 * Math.abs(2 * u - 1);
      colors.push(rgb[0] * edge, rgb[1] * edge, rgb[2] * edge);
    }
  }
  return colors;
}

/* ==========================================================================
   The species catalogue. Spec functions are the SAME ones the CSS bouquet
   calls; variants carry the same hexes style.css paints with. planesCSS is
   the paper version's per-head plane estimate, kept for the "what this
   would cost in divs" line. Eight of the ten species made the crossing:
   the carnation's fringe and the dandelion's fog are still cheaper to fake
   with CSS masks than to mesh honestly.
   ========================================================================== */

export const SPECIES = [
  { key: 'rose', label: 'Rose', latin: 'Rosa', focal: true, shape: 'rose', push: 2,
    specs: (seed = 0, tier = 'full') => rosePetals(tierPetals(tier, 15 + (seed % 3) * 2), { maxOpen: 66, curl: 24 }),
    variants: [
      { key: 'blush', tones: ['#a83f5c', '#e2839a', '#f6c9d3'] },
      { key: 'cream', tones: ['#bd8f52', '#e8d3a8', '#f9efd8'] },
      { key: 'coral', tones: ['#b04832', '#e8825f', '#f8c4a4'] },
    ],
    core: { kind: 'ball', r: 5.5, color: '#c4536f' },
    planesCSS: 36, meadow: { h: [82, 118], s: [0.66, 0.9], weight: 2 } },

  { key: 'peony', label: 'Peony', latin: 'Paeonia', focal: true, shape: 'peony', push: 2,
    specs: (seed = 0, tier = 'full') => peonyPetals(tierPetals(tier, 24)),
    variants: [
      { key: 'pink', tones: ['#b34a70', '#e995b2', '#fbd9e5'] },
      { key: 'ivory', tones: ['#c2a267', '#efdfba', '#fdf7e6'] },
    ],
    core: { kind: 'ball', r: 5, color: '#e995b2' },
    planesCSS: 49, meadow: { h: [78, 110], s: [0.62, 0.85], weight: 1 } },

  { key: 'sunflower', label: 'Sunflower', latin: 'Helianthus', focal: true, shape: 'sunflower', push: 13,
    specs: (seed = 0, tier = 'full') => sunflowerPetals(tierPetals(tier, 14), tierPetals(tier, 11)),
    variants: [
      { key: 'gold', tones: ['#a86a12', '#eab63a', '#f9e084'] },
      { key: 'rust', tones: ['#7e3a10', '#c25f28', '#eda45c'] },
    ],
    core: { kind: 'button', r: 16, squash: 0.42, color: '#33200a', dotted: true },
    planesCSS: 60, meadow: { h: [120, 165], s: [0.75, 1], weight: 1 } },

  { key: 'lily', label: 'Lily', latin: 'Lilium', focal: true, shape: 'lily', push: 2,
    specs: () => lilyPetals(),
    variants: [
      { key: 'white', tones: ['#b9c78e', '#f0efdd', '#fffef2'] },
      { key: 'star', tones: ['#a2265a', '#e786ab', '#f8d3e0'] },
    ],
    stamens: { count: 6, len: 24, open: 20, color: '#efe9cf', anther: '#8f4a1c' },
    planesCSS: 24, meadow: { h: [95, 130], s: [0.7, 0.95], weight: 1 } },

  { key: 'poppy', label: 'Poppy', latin: 'Papaver', focal: true, shape: 'poppy', push: 2,
    specs: () => poppyPetals(),
    variants: [
      { key: 'scarlet', tones: ['#33060c', '#c22b20', '#ef5c33'] },
      { key: 'coral', tones: ['#3a0d08', '#d4562e', '#f68f55'] },
    ],
    core: { kind: 'ball', r: 6.5, squash: 0.72, color: '#241330' },
    stamens: { count: 8, len: 13, open: 26, color: '#3a2a48', anther: '#d8cfae' },
    planesCSS: 21, meadow: { h: [72, 108], s: [0.72, 0.98], weight: 2 } },

  { key: 'tulip', label: 'Tulip', latin: 'Tulipa', shape: 'tulip', push: 2,
    specs: () => tulipPetals(),
    variants: [
      { key: 'plum', tones: ['#571f40', '#8e3f6a', '#c76d94'] },
      { key: 'butter', tones: ['#bf7f22', '#ecbf58', '#f8e2a0'] },
    ],
    planesCSS: 13, meadow: { h: [72, 104], s: [0.78, 1], weight: 2 } },

  { key: 'daisy', label: 'Daisy', latin: 'Bellis', shape: 'daisy', push: 7,
    specs: (seed = 0, tier = 'full') => daisyPetals(tierPetals(tier, 13 + (seed % 2) * 2, 9)),
    variants: [
      { key: 'white', tones: ['#cfc4ac', '#efe9da', '#fdfbf3'] },
      { key: 'lavender', tones: ['#7a63a8', '#a98fd0', '#d7c8ef'] },
    ],
    core: { kind: 'button', r: 8.5, squash: 0.45, color: '#d9c26e' },
    planesCSS: 34, meadow: { h: [52, 84], s: [0.85, 1.1], weight: 3 } },

  { key: 'lavender', label: 'Lavender', latin: 'Lavandula', kind: 'spike', shape: 'bud', push: 3.5,
    specs: () => lavenderWhorls(),
    variants: [
      { key: 'violet', tones: ['#584397', '#8a72c4', '#c3b1ea'] },
    ],
    seatAdjust: { y: 44, r: 10, tilt: 4, s: -0.15 }, stemFoot: 10,
    planesCSS: 31, meadow: { h: [86, 122], s: [0.9, 1.15], weight: 3 } },
];

const speciesIndexByKey = new Map(SPECIES.map((s, i) => [s.key, i]));

export function speciesIndex(key) {
  return speciesIndexByKey.get(key) ?? -1;
}

/* ==========================================================================
   Bouquet assembly: order -> instances -> relaxed dome seats. Mirrors
   flowers.js orderToInstances (round-robin so neighbours differ, a focal
   flower promoted to the center seat), but stays pure: the output is data
   the GL builder turns into instance matrices.
   ========================================================================== */

export function orderInstances(order) {
  const queues = [];
  for (const { type, count } of order) {
    const si = speciesIndexByKey.get(type);
    if (si == null || count <= 0) continue;
    const q = [];
    for (let i = 0; i < count; i++) {
      q.push({ species: si, variant: i % SPECIES[si].variants.length });
    }
    queues.push(q);
  }
  const out = [];
  while (queues.length) {
    for (let qi = queues.length - 1; qi >= 0; qi--) {
      out.push(queues[qi].shift());
      if (!queues[qi].length) queues.splice(qi, 1);
    }
  }
  const fi = out.findIndex((inst) => SPECIES[inst.species].focal);
  if (fi > 0) out.unshift(...out.splice(fi, 1));
  return out.slice(0, MAX_STEMS);
}

export function bouquetPlan(order) {
  const instances = orderInstances(order);
  if (!instances.length) return [];
  const seats = bouquetSeats(
    instances.length,
    instances.map((inst) => HEAD_RADII[SPECIES[inst.species].key] ?? DEFAULT_HEAD_R),
  );
  return instances.map((inst, i) => {
    const def = SPECIES[inst.species];
    const seat = { ...seats[i] };
    if (def.seatAdjust) {
      seat.y += def.seatAdjust.y ?? 0;
      seat.r += def.seatAdjust.r ?? 0;
      seat.tilt += def.seatAdjust.tilt ?? 0;
      seat.s += def.seatAdjust.s ?? 0;
    }
    return { ...inst, seat, seed: i };
  });
}

/* The same quadratic Bezier stemPath (flowers/logic.js) walks, but sampled
   as raw points for a tube instead of chord segments for divs. Same STEM_BIND
   constants and the same jitter salts, so a seat's stem lands on the same tie
   point in both renderers. Points are in the seat's azimuth plane, CSS frame
   (z = radius from the axis, y down; the GL side maps y through CSS_GROUND_Y). */
export function stemPlan(seat, opts = {}) {
  const { samples = 14, seed = 0, footY = 0 } = opts;
  const p0 = seatPoint(seat, footY);
  const bindMag = STEM_BIND.rMin + Math.abs(jitter(seed, STEM_BIND.rMax - STEM_BIND.rMin, 31));
  const bindZ = (jitter(seed, 1, 29) < 0 ? -1 : 1) * bindMag;
  let bindY = STEM_BIND.yMin + Math.abs(jitter(seed, STEM_BIND.yMax - STEM_BIND.yMin, 37));
  bindY = Math.max(bindY, p0.y + STEM_BIND.minDrop);
  const p2 = { z: bindZ, y: bindY };
  const t = (seat.tilt * Math.PI) / 180;
  const dist = Math.hypot(p2.z - p0.z, p2.y - p0.y);
  const reach = Math.min(0.5 * dist, (p2.y - p0.y) / Math.max(Math.cos(t), 0.2));
  const p1 = { z: p0.z - reach * Math.sin(t), y: p0.y + reach * Math.cos(t) };
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const tt = i / samples;
    const mt = 1 - tt;
    pts.push({
      z: mt * mt * p0.z + 2 * mt * tt * p1.z + tt * tt * p2.z,
      y: mt * mt * p0.y + 2 * mt * tt * p1.y + tt * tt * p2.y,
    });
  }
  return pts;
}

/* The paper wrap as one round surface instead of 13 flat facets: radius
   follows the cone slope, and the rim dips with the same cosine scallop the
   CSS clip-path cuts. thetaFrac 0..1 around, vFrac 0..1 base to rim. */
export const WRAP = { rTop: 96, rBottom: 30, height: 168, waves: 13, waveDepth: 13 };

export function wrapPoint(thetaFrac, vFrac, spec = WRAP, phase = 0) {
  const { rTop, rBottom, height, waves, waveDepth } = spec;
  const dip = waveDepth * 0.5 * (1 - Math.cos(2 * Math.PI * (waves * thetaFrac + phase)));
  const y = vFrac * (height - dip);
  const r = rBottom + (rTop - rBottom) * (y / height);
  return { r, y };
}

/* ==========================================================================
   The meadow: what the 12-stem wrap can never hold. A deterministic
   golden-angle scatter (even density, no clumps, stable across reloads),
   species drawn from a weighted pattern so the cheap flowers outnumber the
   showpieces, plus a per-flower wind phase from the low-discrepancy
   golden-ratio sequence so no two neighbours sway in step.
   ========================================================================== */

export function scatterPoints(count, opts = {}) {
  const { rMin = 90, rMax = 1250, salt = 1 } = opts;
  const pts = [];
  const n = Math.max(1, Math.floor(count));
  for (let i = 0; i < n; i++) {
    const r = lerp(rMin, rMax, Math.sqrt((i + 0.5) / n)) + jitter(i, 14, salt);
    const a = (((i * GOLDEN_ANGLE + jitter(i, 5, salt + 1)) % 360) * Math.PI) / 180;
    pts.push({ x: r * Math.cos(a), z: r * Math.sin(a), i });
  }
  return pts;
}

function buildMeadowPattern() {
  const pattern = [];
  SPECIES.forEach((def, si) => {
    for (let k = 0; k < (def.meadow?.weight ?? 1); k++) pattern.push(si);
  });
  /* Deterministic shuffle so one weighted block does not plant in stripes. */
  for (let i = pattern.length - 1; i > 0; i--) {
    const j = Math.abs(Math.floor(jitter(i, 1000, 41))) % (i + 1);
    [pattern[i], pattern[j]] = [pattern[j], pattern[i]];
  }
  return pattern;
}

export const MEADOW_PATTERN = buildMeadowPattern();

export function meadowField(count, opts = {}) {
  return scatterPoints(count, opts).map(({ x, z, i }) => {
    const si = MEADOW_PATTERN[i % MEADOW_PATTERN.length];
    const def = SPECIES[si];
    const { h, s } = def.meadow;
    return {
      x, z,
      species: si,
      variant: Math.abs(Math.floor(jitter(i, 100, 23))) % def.variants.length,
      ry: (i * 71) % 360,
      height: lerp(h[0], h[1], jitter(i, 0.5, 5) + 0.5),
      s: lerp(s[0], s[1], jitter(i, 0.5, 9) + 0.5),
      lean: jitter(i, 8, 11),
      leanDir: (i * 137) % 360,
      phase: ((i * 0.6180339887) % 1) * Math.PI * 2,
    };
  });
}

export function grassField(count, opts = {}) {
  return scatterPoints(count, { rMin: 60, rMax: 1350, salt: 7, ...opts }).map(({ x, z, i }) => ({
    x, z,
    ry: (i * 53) % 360,
    s: 0.7 + Math.abs(jitter(i, 0.75, 13)),
    lean: jitter(i, 14, 15),
    phase: ((i * 0.6180339887 + 0.37) % 1) * Math.PI * 2,
  }));
}

/* ==========================================================================
   Frame statistics for the HUD: average fps and the "1% low" (the mean of
   the worst 1% of frame times), which is what a stutter actually feels like.
   Input is frame durations in milliseconds.
   ========================================================================== */

export function fpsStats(frameMs) {
  const valid = frameMs.filter((ms) => Number.isFinite(ms) && ms > 0);
  if (!valid.length) return { fps: 0, low: 0 };
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const sorted = [...valid].sort((a, b) => a - b);
  const from = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
  const worst = sorted.slice(from);
  const worstMean = worst.reduce((a, b) => a + b, 0) / worst.length;
  return { fps: 1000 / mean, low: 1000 / worstMean };
}

/* What the paper renderer would spend on the same heads, in planes; the HUD
   sets this against the CSS version's ~500-plane practical budget. */
export function cssPlaneEquivalent(stems) {
  return stems.reduce((sum, rec) => sum + (SPECIES[rec.species]?.planesCSS ?? 0), 0);
}

export function fmtCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return `${Math.round(n)}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* ==========================================================================
   The counter: preset arrangements (the stall's greatest hits) and the
   meadow densities. The surprise button reuses the paper stall's own
   surpriseCounts so a surprise means the same thing in both shops.
   ========================================================================== */

export const PRESETS = [
  { key: 'classic', label: 'The classic', note: 'the same seven stems the paper stall seeds',
    order: [{ type: 'rose', count: 3 }, { type: 'tulip', count: 2 }, { type: 'daisy', count: 2 }] },
  { key: 'roses', label: 'A dozen roses', note: 'the wrap at its 12-stem limit',
    order: [{ type: 'rose', count: 12 }] },
  { key: 'everything', label: 'One of everything', note: 'all eight species that made the crossing',
    order: SPECIES.map((s) => ({ type: s.key, count: 1 })) },
  { key: 'moon', label: 'The moon garden', note: 'whites and violets for a dark stage',
    order: [{ type: 'daisy', count: 3 }, { type: 'lily', count: 2 }, { type: 'lavender', count: 4 }] },
];

export const MEADOW_STEPS = [300, 900, 2200, 4000];

export function surpriseOrder(rand = Math.random) {
  const counts = surpriseCounts(SPECIES.map((s) => s.key), rand);
  return SPECIES
    .map((s) => ({ type: s.key, count: counts[s.key] ?? 0 }))
    .filter((o) => o.count > 0);
}
