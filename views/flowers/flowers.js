/* flowers.js : grows the bouquet out of css3d planes.
   All the math comes from logic.js; all the DOM comes from css3d.js;
   all the paint (gradients, shapes) lives in style.css under the
   variant classes used here. Sign convention: a NEGATIVE rotateX leans
   a hinged plane outward, toward its own face normal, so specs keep
   openness positive and the calc below flips it. */

import { node, face, seg, ring } from './css3d.js';
import {
  rosePetals, tulipPetals, daisyPetals, sunflowerPetals, peonyPetals,
  poppyPetals, lilyPetals, carnationPetals, lavenderWhorls, spherePoints,
  coneFaces, bouquetSeats, waveEdgePoints, jitter, MAX_STEMS,
} from './logic.js';

export { MAX_STEMS };

/* Petal openness and curl are multiplied by --bloom (0 = closed bud,
   1 = full bloom), which the page animates on the stage node. */
const OPEN_RX = 'calc(var(--open) * var(--bloom, 1) * -1)';
const TIP_BEND = 'calc(var(--tip) * var(--bloom, 1) * -1)';

function sized(el, w, h) {
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  return el;
}

/* A y position that rides the bloom: `closed` while the bud is shut,
   easing to `open` at full bloom. Flat flowers (sunflower, daisy) need
   this for their seed cores: the core caps the closed bud high up, but
   must settle down onto the petal disc as the petals fold flat, or it
   hovers in mid-air over the open flower. */
function bloomY(open, closed) {
  return `calc(${open}px + ${closed - open}px * (1 - var(--bloom, 1)))`;
}

function petal(parent, spec, cls, dims) {
  const p = face(parent, {
    ry: `${spec.azimuth}deg`,
    open: `${spec.open}deg`,
    rx: OPEN_RX,
    rz: `${spec.twist ?? 0}deg`,
    s: spec.size,
    y: `${spec.lift ?? 0}px`,
    oz: `${dims.push ?? 2}px`,
  }, `petal-base ${cls}`, 'hinge');
  sized(p, dims.w, dims.h);
  if (dims.tipH) {
    const t = seg(p, { tip: `${spec.bend}deg`, bend: TIP_BEND }, `petal-tip ${cls}`);
    sized(t, dims.w, dims.tipH);
  }
  return p;
}

export function rose(parent, variant = 'rose--blush', petals = 18) {
  const g = node(parent, {}, `flower rose ${variant}`);
  for (const spec of rosePetals(petals, { maxOpen: 66, curl: 24 })) {
    petal(g, spec, 'p-rose', { w: 50, h: 26, tipH: 22 });
  }
  sized(face(g, { rx: '90deg', y: '-4px' }, 'rose-core'), 15, 15);
  return g;
}

export function tulip(parent, variant = 'tulip--butter') {
  const g = node(parent, {}, `flower tulip ${variant}`);
  for (const spec of tulipPetals()) {
    petal(g, spec, 'p-tulip', { w: 30, h: 30, tipH: 24 });
  }
  return g;
}

export function daisy(parent, variant = 'daisy--white', petals = 15) {
  const g = node(parent, {}, `flower daisy ${variant}`);
  for (const spec of daisyPetals(petals)) {
    petal(g, spec, 'p-daisy', { w: 11, h: 22, tipH: 14, push: 7 });
  }
  sized(face(g, { rx: '90deg', y: bloomY(-0.5, -3) }, 'daisy-core'), 24, 24);
  sized(face(g, { rx: '90deg', y: bloomY(-3, -7), s: 0.62 }, 'daisy-core'), 24, 24);
  sized(face(g, { ry: '0deg', y: bloomY(-0.5, -3) }, 'daisy-core-side'), 16, 9);
  sized(face(g, { ry: '90deg', y: bloomY(-0.5, -3) }, 'daisy-core-side'), 16, 9);
  return g;
}

export function sunflower(parent, variant = 'sunflower--gold') {
  const g = node(parent, {}, `flower sunflower ${variant}`);
  for (const spec of sunflowerPetals()) {
    petal(g, spec, 'p-sun', { w: 12, h: 22, tipH: 16, push: 13 });
  }
  sized(face(g, { rx: '90deg', y: bloomY(-1, -6) }, 'sun-core'), 34, 34);
  sized(face(g, { rx: '90deg', y: bloomY(-4, -9), s: 0.82 }, 'sun-core sun-core--top'), 34, 34);
  ring(8, (i, a) => {
    sized(face(g, { ry: `${a}deg`, y: bloomY(-1, -6), oz: '16px' }, 'sun-core-side'), 13, 6);
  });
  return g;
}

export function peony(parent, variant = 'peony--pink') {
  const g = node(parent, {}, `flower peony ${variant}`);
  for (const spec of peonyPetals(24)) {
    petal(g, spec, 'p-peony', { w: 42, h: 26, tipH: 24 });
  }
  sized(face(g, { rx: '90deg', y: '-4px' }, 'peony-core'), 12, 12);
  return g;
}

export function poppy(parent, variant = 'poppy--scarlet') {
  const g = node(parent, {}, `flower poppy ${variant}`);
  for (const spec of poppyPetals()) {
    petal(g, spec, 'p-poppy', { w: 38, h: 30, tipH: 18 });
  }
  sized(face(g, { rx: '90deg', y: '-5px' }, 'poppy-eye'), 16, 16);
  ring(8, (i, a) => {
    sized(face(g, {
      ry: `${a + jitter(i, 6)}deg`,
      open: `${26 + jitter(i, 5, 3)}deg`,
      rx: OPEN_RX,
      y: '-2px',
    }, 'poppy-stamen', 'hinge'), 1.6, 13);
  }, 10);
  return g;
}

export function lily(parent, variant = 'lily--white') {
  const g = node(parent, {}, `flower lily ${variant}`);
  for (const spec of lilyPetals()) {
    petal(g, spec, 'p-lily', { w: 20, h: 32, tipH: 24 });
  }
  ring(6, (i, a) => {
    const st = face(g, {
      ry: `${a + jitter(i, 6)}deg`,
      open: `${20 + jitter(i, 5, 3)}deg`,
      rx: OPEN_RX,
    }, 'lily-stamen', 'hinge');
    sized(st, 1.4, 24);
    sized(seg(st, {}, 'lily-anther'), 4.5, 7);
  }, 14);
  return g;
}

export function carnation(parent, variant = 'carnation--crimson') {
  const g = node(parent, {}, `flower carnation ${variant}`);
  for (const spec of carnationPetals(24)) {
    /* push 6 keeps the twisted petal planes off the shared center axis,
       where they would otherwise all intersect (see carnationPetals). */
    petal(g, spec, 'p-carn', { w: 26, h: 16, tipH: 14, push: 6 });
  }
  return g;
}

/* The dandelion clock: a sphere of downy tufts on a bare stem, with a few
   fine spokes through the middle so the ball reads as seeds, not fog. */
export function dandelion(parent, variant = 'dandelion--moon', seed = 0) {
  const g = node(parent, {}, `flower dandelion ${variant}`);
  stemCross(g, 76, -70);
  const head = node(g, { y: '-70px' });
  sized(face(head, { ry: '0deg' }, 'dand-heart'), 9, 9);
  sized(face(head, { ry: '90deg' }, 'dand-heart'), 9, 9);
  spherePoints(16, 19).forEach((pt, i) => {
    const p = node(head, { x: `${pt.x}px`, y: `${pt.y}px`, z: `${pt.z}px` });
    const d = 8.5 + jitter(i + seed, 1.5, 7);
    sized(face(p, { ry: '0deg' }, 'dand-tuft'), d, d);
    sized(face(p, { ry: '90deg' }, 'dand-tuft'), d, d);
  });
  for (let i = 0; i < 7; i++) {
    sized(face(head, { ry: `${i * 26}deg`, rz: `${(i * 47) % 180}deg` }, 'dand-spoke'), 1.2, 38);
  }
  return g;
}

/* A lavender spike: whorls of tiny buds up a tall stem, tip bud on top,
   two thin leaves at the base. */
export function lavender(parent, variant = 'lavender--violet', seed = 0) {
  const g = node(parent, {}, `flower lavender ${variant}`);
  stemCross(g, 96, -86);
  for (const spec of lavenderWhorls()) {
    sized(face(g, {
      ry: `${spec.azimuth + jitter(seed, 8)}deg`,
      y: `${spec.y}px`,
      oz: '3.5px',
      s: spec.size,
    }, 'lav-bud'), 7, 9);
  }
  sized(face(g, { y: '-90px' }, 'lav-bud lav-bud--tip'), 6, 10);
  for (const a of [80, 260]) {
    sized(face(g, {
      ry: `${a + jitter(seed, 12, 3)}deg`,
      open: '52deg',
      rx: OPEN_RX,
      y: '-8px',
    }, 'lav-leaf', 'hinge'), 4.5, 20);
  }
  return g;
}

/* Baby's breath: a stem that ends in a loose cloud of tiny white puffs.
   Each puff is two crossed soft circles so it reads from every angle. */
export function sprig(parent, seed = 0) {
  const g = node(parent, {}, 'flower sprig');
  stemCross(g, 70, -10);
  for (let i = 0; i < 7; i++) {
    const p = node(g, {
      x: `${jitter(i + seed, 19)}px`,
      y: `${-(48 + i * 9 + jitter(i + seed, 7, 3))}px`,
      z: `${jitter(i + seed, 19, 5)}px`,
    });
    const d = 9 + jitter(i + seed, 2.5, 7);
    sized(face(p, { ry: '0deg' }, 'puff'), d, d);
    sized(face(p, { ry: '90deg' }, 'puff'), d, d);
  }
  return g;
}

/* Eucalyptus-ish greenery: a tall stem with pairs of small round leaves. */
export function greenery(parent, seed = 0) {
  const g = node(parent, {}, 'flower euca');
  stemCross(g, 78, -12);
  for (let k = 0; k < 7; k++) {
    const leafSpec = {
      ry: `${(k % 2 ? 100 : 262) + jitter(k + seed, 18)}deg`,
      open: `${58 + jitter(k + seed, 10, 3)}deg`,
      rx: OPEN_RX,
      y: `${-(16 + k * 14)}px`,
    };
    sized(face(g, leafSpec, 'euca-leaf', 'hinge'), 19, 22);
  }
  return g;
}

/* A single big leaf tucked between flower heads. */
export function bigLeaf(parent, spec = {}) {
  const g = node(parent, {}, 'flower');
  stemCross(g, 46, -2);
  const l = face(g, {
    ry: `${spec.azimuth ?? 0}deg`,
    open: `${spec.open ?? 40}deg`,
    rx: OPEN_RX,
    rz: `${spec.twist ?? 0}deg`,
  }, 'leaf-blade', 'hinge');
  sized(l, 30, 66);
  const t = seg(l, { tip: '18deg', bend: TIP_BEND }, 'leaf-blade leaf-blade--tip');
  sized(t, 30, 26);
  return g;
}

function stemCross(parent, h, top) {
  sized(face(parent, { ry: '0deg', y: `${top + h / 2}px` }, 'stem'), 2.5, h);
  sized(face(parent, { ry: '90deg', y: `${top + h / 2}px` }, 'stem'), 2.5, h);
}

/* ==========================================================================
   The stall's catalogue: everything the menu can order. `planes` is a
   rough per-head estimate for the live counter; `focal` heads compete for
   the center seat; `seatAdjust` sinks the tall self-stemmed ones so their
   heads don't tower over the dome; `preview` frames the menu-card scene.
   ========================================================================== */

export const FLOWER_TYPES = [
  { key: 'rose', label: 'Rose', latin: 'Rosa', focal: true,
    build: (p, v, seed = 0) => rose(p, v, 15 + (seed % 3) * 2),
    variants: ['rose--blush', 'rose--cream', 'rose--coral'],
    planes: 36, preview: { s: 0.62, y: 8 } },
  { key: 'peony', label: 'Peony', latin: 'Paeonia', focal: true,
    build: (p, v) => peony(p, v),
    variants: ['peony--pink', 'peony--ivory'],
    planes: 49, preview: { s: 0.6, y: 8 } },
  { key: 'sunflower', label: 'Sunflower', latin: 'Helianthus', focal: true,
    build: (p, v) => sunflower(p, v),
    variants: ['sunflower--gold', 'sunflower--rust'],
    planes: 60, preview: { s: 0.62, y: 8 } },
  { key: 'lily', label: 'Lily', latin: 'Lilium', focal: true,
    build: (p, v) => lily(p, v),
    variants: ['lily--white', 'lily--star'],
    planes: 24, preview: { s: 0.62, y: 12 } },
  { key: 'poppy', label: 'Poppy', latin: 'Papaver', focal: true,
    build: (p, v) => poppy(p, v),
    variants: ['poppy--scarlet', 'poppy--coral'],
    planes: 21, preview: { s: 0.68, y: 8 } },
  { key: 'tulip', label: 'Tulip', latin: 'Tulipa',
    build: (p, v) => tulip(p, v),
    variants: ['tulip--plum', 'tulip--butter'],
    planes: 13, preview: { s: 0.72, y: 12 } },
  { key: 'daisy', label: 'Daisy', latin: 'Bellis',
    build: (p, v, seed = 0) => daisy(p, v, 13 + (seed % 2) * 2),
    variants: ['daisy--white', 'daisy--lavender'],
    planes: 34, preview: { s: 0.78, y: 8 } },
  { key: 'carnation', label: 'Carnation', latin: 'Dianthus',
    build: (p, v) => carnation(p, v),
    variants: ['carnation--crimson', 'carnation--snow'],
    planes: 48, preview: { s: 0.68, y: 8 } },
  { key: 'dandelion', label: 'Dandelion', latin: 'Taraxacum',
    build: (p, v, seed = 0) => dandelion(p, v, seed),
    variants: ['dandelion--moon'],
    planes: 45, seatAdjust: { y: 44, r: 10, tilt: 4, s: -0.2 },
    preview: { s: 0.62, y: 42 } },
  { key: 'lavender', label: 'Lavender', latin: 'Lavandula',
    build: (p, v, seed = 0) => lavender(p, v, seed),
    variants: ['lavender--violet'],
    planes: 31, seatAdjust: { y: 44, r: 10, tilt: 4, s: -0.15 },
    preview: { s: 0.62, y: 44 } },
];

export const DEFAULT_ORDER = [
  { type: 'rose', count: 3 },
  { type: 'tulip', count: 2 },
  { type: 'daisy', count: 2 },
];

const typeByKey = new Map(FLOWER_TYPES.map((t) => [t.key, t]));

/* The kraft paper wrap: an outer cone, a darker liner just inside it,
   and a satin ribbon band with a bow at the front. */
const CONE = { n: 13, rTop: 96, rBottom: 30, height: 168 };

/* The rim cut: a smooth scallop arc per facet instead of razor teeth.
   Top edge traced right to left, then the bottom chord closes the shape. */
function scallopClip(depthPct, bottomFrac, phase = 0) {
  const pts = waveEdgePoints(1, depthPct, 20, phase)
    .reverse()
    .map((p) => `${p.x.toFixed(1)}% ${p.y.toFixed(2)}%`);
  const halfB = bottomFrac * 50;
  return `polygon(${pts.join(',')},${(50 - halfB).toFixed(1)}% 100%,${(50 + halfB).toFixed(1)}% 100%)`;
}

function cone(parent, { n, rTop, rBottom, height }, cls, clip) {
  const slant = Math.hypot(height, rTop - rBottom);
  for (const f of coneFaces(n, rTop, rBottom, height)) {
    const el = face(parent, {
      y: `${height / 2 - 18}px`,
      ry: `${f.angle}deg`,
      rx: `${-f.tilt}deg`,
      oz: `${f.push}px`,
    }, cls);
    sized(el, f.width, slant);
    if (clip) el.style.clipPath = clip;
  }
}

function wrap(parent) {
  /* Outer paper dips mid-facet; the liner's wave is half a phase off, so
     its crests rise exactly where the outer scallop dips. The rim reads
     as two soft layers of wrapped paper instead of one cut edge. */
  const clip = scallopClip(9, CONE.rBottom / CONE.rTop);
  const linerClip = scallopClip(9, (CONE.rBottom - 4) / (CONE.rTop - 5), 0.5);
  cone(parent, CONE, 'wrap-face', clip);
  cone(parent, { ...CONE, rTop: CONE.rTop - 5, rBottom: CONE.rBottom - 4, height: CONE.height - 8 }, 'wrap-face wrap-face--liner', linerClip);

  /* The ribbon hugs the paper: each strip lies in its facet's own plane
     (same node vars as the cone face), slid up the slant to band height
     with --oy and lifted 1.4px off the paper with --oz. A separate
     cylinder of strips floats visibly off the tapering cone. */
  const bandY = 78;
  const bandFrac = bandY / CONE.height;
  const rBand = CONE.rTop - bandFrac * (CONE.rTop - CONE.rBottom);
  const slantLen = Math.hypot(CONE.height, CONE.rTop - CONE.rBottom);
  const bandW = 2 * rBand * Math.sin(Math.PI / CONE.n) + 2;
  for (const f of coneFaces(CONE.n, CONE.rTop, CONE.rBottom, CONE.height)) {
    const el = face(parent, {
      y: `${CONE.height / 2 - 18}px`,
      ry: `${f.angle}deg`,
      rx: `${-f.tilt}deg`,
      oy: `${(bandFrac - 0.5) * slantLen}px`,
      oz: `${f.push + 1.4}px`,
    }, 'ribbon');
    sized(el, bandW, 15);
  }
  bow(parent, bandY, rBand);
}

/* A simple knot where the ribbon ties off; a full bow reads as noise at
   this scale, so the band stays quiet on purpose. */
function bow(parent, y, r) {
  const g = node(parent, { y: `${y}px`, z: `${r + 2}px` }, 'bow');
  sized(face(g, { rz: '24deg' }, 'bow-knot'), 13, 13);
  sized(face(g, { x: '-7px', y: '16px', rz: '-18deg', ry: '-14deg' }, 'bow-tail'), 8, 26);
  sized(face(g, { x: '6px', y: '17px', rz: '20deg', ry: '14deg' }, 'bow-tail'), 8, 22);
}

/* Blush tissue paper collaring the flowers inside the wrap rim. Kept a
   touch shorter than the flower seats: petals crossing tissue planes are
   the most expensive intersections in the whole scene. */
function tissue(parent) {
  ring(9, (i, a) => {
    const el = face(parent, {
      ry: `${a + jitter(i, 8)}deg`,
      rx: `${-(26 + jitter(i, 7, 3))}deg`,
      rz: `${jitter(i, 9, 5)}deg`,
      oz: '62px',
      y: '8px',
    }, 'tissue', 'hinge');
    sized(el, 58, 60);
  }, 11);
}

/* Filler stems inside the throat, visible only when peering down into
   the wrap. Tops stay below the rim line (y >= -14 vs rim -18) so the
   paper always hides them from the side: a decorative stem poking into
   open air ends at nothing and reads as a snipped stalk. The real head
   stems carry the visible run from each flower down into the wrap. */
function stems(parent, count = 7) {
  ring(count, (i, a) => {
    const g = node(parent, { ry: `${a}deg`, rz: `${jitter(i, 5)}deg` });
    sized(face(g, { oz: `${8 + jitter(i, 9, 3)}px`, y: '18px' }, 'stem'), 3, 64);
  }, 23);
}

function groundShadow(parent) {
  sized(face(parent, { rx: '90deg', y: `${CONE.height - 14}px` }, 'ground-shadow'), 270, 270);
}

/* A few petals dropped on the floor, tinted like the flowers above them. */
function fallenPetals(parent, variants) {
  const spots = [
    { x: -104, z: 44, rz: 24 },
    { x: 96, z: -20, rz: -50 },
    { x: 60, z: 88, rz: 130 },
  ];
  const tints = variants.length ? variants : ['rose--blush', 'rose--coral', 'rose--cream'];
  spots.forEach((s, i) => {
    const el = face(parent, {
      x: `${s.x}px`, y: `${CONE.height - 15}px`, z: `${s.z}px`,
      rx: '90deg', rz: `${s.rz}deg`,
    }, `petal-tip p-rose fallen ${tints[i % tints.length]}`);
    sized(el, 30, 24);
  });
}

/* One flower head, planted at an azimuth around the bouquet dome and
   tilted outward so the arrangement reads as a dome, not a flat fan. */
function plant(parent, build, { a, r, y, tilt, s = 1, seed = 0 }) {
  const az = node(parent, { ry: `${a}deg` });
  const sway = node(az, {}, 'sway');
  sway.style.animationDuration = `${6.5 + jitter(seed, 1.8)}s`;
  sway.style.animationDelay = `${jitter(seed, 2, 9)}s`;
  const seat = node(sway, { z: `${r}px`, y: `${y}px`, rx: `${-tilt}deg`, s });
  return build(seat);
}

/* Turn an order ([{type, count}]) into one flower instance per stem,
   round-robin across types so no two neighbours match, then make sure a
   focal flower (rose, peony, ...) holds the center seat if there is one. */
export function orderToInstances(order) {
  const queues = [];
  for (const { type, count } of order) {
    const def = typeByKey.get(type);
    if (!def || count <= 0) continue;
    const q = [];
    for (let i = 0; i < count; i++) q.push({ def, variant: def.variants[i % def.variants.length] });
    queues.push(q);
  }
  const instances = [];
  while (queues.length) {
    for (let qi = queues.length - 1; qi >= 0; qi--) {
      instances.push(queues[qi].shift());
      if (!queues[qi].length) queues.splice(qi, 1);
    }
  }
  const focalAt = instances.findIndex((inst) => inst.def.focal);
  if (focalAt > 0) {
    const [focal] = instances.splice(focalAt, 1);
    instances.unshift(focal);
  }
  return instances.slice(0, MAX_STEMS);
}

export function countPlanes(order) {
  let sum = 0;
  for (const { type, count } of order) {
    const def = typeByKey.get(type);
    if (def) sum += def.planes * count;
  }
  return sum;
}

export function buildBouquet(root, order = DEFAULT_ORDER, opts = {}) {
  const { greens = true } = opts;
  const bq = node(root, { y: '-30px' }, 'bq');

  const instances = orderToInstances(order);

  groundShadow(bq);
  fallenPetals(bq, instances.map((inst) => inst.variant));
  wrap(bq);
  stems(bq, Math.max(5, Math.min(9, instances.length + 2)));
  tissue(bq);

  const seats = bouquetSeats(Math.max(1, instances.length));
  instances.forEach((inst, i) => {
    const seat = { ...seats[i], seed: i + 1 };
    const adj = inst.def.seatAdjust;
    if (adj) {
      seat.y += adj.y ?? 0;
      seat.r += adj.r ?? 0;
      seat.tilt += adj.tilt ?? 0;
      seat.s += adj.s ?? 0;
    }
    plant(bq, (p) => {
      /* Drawn inside the tilted seat, the stem leans with its flower and
         runs down into the bunch; length divides by the seat scale so it
         reads the same regardless of head size. It runs the FULL seat
         height so the end lands below the wrap rim, inside the cone:
         a stem that stops short reads as a cut-off floating stick (the
         plane-splitting cost of crossing the tissue measured fine).
         Self-stemmed species (seatAdjust) bring their own. */
      if (!adj) {
        stemCross(p, -seat.y / seat.s, -2);
      }
      return inst.def.build(p, inst.variant, i);
    }, seat);
  });

  if (greens && instances.length) {
    const n = instances.length;
    const sprigs = Math.min(3, Math.max(1, Math.round(n / 3)));
    const eucas = Math.min(3, Math.max(1, Math.round(n / 4)));
    const leaves = Math.min(3, Math.max(1, Math.round(n / 4)));
    ring(sprigs, (i, a) => {
      plant(bq, (p) => sprig(p, i * 4 + 1), { a: a + jitter(i, 14), r: 68, y: -40, tilt: 28, s: 1, seed: 30 + i });
    }, 34);
    ring(eucas, (i, a) => {
      plant(bq, (p) => greenery(p, i * 4 + 2), { a: a + jitter(i, 16, 3), r: 66, y: -38, tilt: 34, s: 1, seed: 40 + i });
    }, 92);
    ring(leaves, (i, a) => {
      plant(bq, (p) => bigLeaf(p, { azimuth: jitter(i, 14, 5), open: 52 + jitter(i, 6, 7), twist: jitter(i, 10, 9) }), { a: a + jitter(i, 18, 5), r: 64, y: -48, tilt: 30, s: 1.1, seed: 50 + i });
    }, 152);
  }

  return {
    planes: root.querySelectorAll('.c3d-face, .c3d-seg').length,
    nodes: root.querySelectorAll('.c3d, .c3d-face, .c3d-seg').length,
    stems: instances.length,
  };
}
