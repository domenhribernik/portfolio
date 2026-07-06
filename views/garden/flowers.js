/* flowers.js : grows the bouquet out of css3d planes.
   All the math comes from logic.js; all the DOM comes from css3d.js;
   all the paint (gradients, shapes) lives in style.css under the
   variant classes used here. Sign convention: a NEGATIVE rotateX leans
   a hinged plane outward, toward its own face normal, so specs keep
   openness positive and the calc below flips it. */

import { node, face, seg, ring } from './css3d.js';
import { rosePetals, tulipPetals, daisyPetals, coneFaces, jitter } from './logic.js';

/* Petal openness and curl are multiplied by --bloom (0 = closed bud,
   1 = full bloom), which the page animates on the stage node. */
const OPEN_RX = 'calc(var(--open) * var(--bloom, 1) * -1)';
const TIP_BEND = 'calc(var(--tip) * var(--bloom, 1) * -1)';

function sized(el, w, h) {
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  return el;
}

function petal(parent, spec, cls, dims) {
  const p = face(parent, {
    ry: `${spec.azimuth}deg`,
    open: `${spec.open}deg`,
    rx: OPEN_RX,
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
  sized(face(g, { rx: '90deg', y: '-3px' }, 'daisy-core'), 24, 24);
  sized(face(g, { rx: '90deg', y: '-7px', s: 0.62 }, 'daisy-core'), 24, 24);
  sized(face(g, { ry: '0deg', y: '-3px' }, 'daisy-core-side'), 16, 9);
  sized(face(g, { ry: '90deg', y: '-3px' }, 'daisy-core-side'), 16, 9);
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

/* The kraft paper wrap: an outer cone, a darker liner just inside it,
   and a satin ribbon band with a bow at the front. */
const CONE = { n: 13, rTop: 96, rBottom: 30, height: 168 };

function zigzagClip(teeth, depthPct, bottomFrac) {
  const pts = [];
  for (let i = teeth * 2; i >= 0; i--) {
    const x = (i / (teeth * 2)) * 100;
    pts.push(`${x.toFixed(1)}% ${i % 2 === 0 ? depthPct : 0}%`);
  }
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
  const clip = zigzagClip(3, 10, CONE.rBottom / CONE.rTop);
  cone(parent, CONE, 'wrap-face', clip);
  cone(parent, { ...CONE, rTop: CONE.rTop - 5, rBottom: CONE.rBottom - 4, height: CONE.height - 8 }, 'wrap-face wrap-face--liner', clip);

  const bandY = 78;
  const rBand = CONE.rTop - (bandY / CONE.height) * (CONE.rTop - CONE.rBottom) + 2;
  const coneTilt = (Math.atan2(CONE.rTop - CONE.rBottom, CONE.height) * 180) / Math.PI;
  for (const f of coneFaces(CONE.n, rBand, rBand, 1)) {
    const el = face(parent, {
      y: `${bandY}px`,
      ry: `${f.angle}deg`,
      rx: `${-coneTilt}deg`,
      oz: `${f.push}px`,
    }, 'ribbon');
    sized(el, f.width, 15);
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

/* Blush tissue paper collaring the flowers inside the wrap rim. */
function tissue(parent) {
  ring(9, (i, a) => {
    const el = face(parent, {
      ry: `${a + jitter(i, 8)}deg`,
      rx: `${-(26 + jitter(i, 7, 3))}deg`,
      rz: `${jitter(i, 9, 5)}deg`,
      oz: '62px',
      y: '8px',
    }, 'tissue', 'hinge');
    sized(el, 58, 70);
  }, 11);
}

function stems(parent) {
  ring(7, (i, a) => {
    const g = node(parent, { ry: `${a}deg`, rz: `${jitter(i, 5)}deg` });
    sized(face(g, { oz: `${8 + jitter(i, 9, 3)}px`, y: '-4px' }, 'stem'), 3, 84);
  }, 23);
}

function groundShadow(parent) {
  sized(face(parent, { rx: '90deg', y: `${CONE.height - 14}px` }, 'ground-shadow'), 270, 270);
}

function fallenPetals(parent) {
  const spots = [
    { x: -104, z: 44, rz: 24, v: 'rose--blush' },
    { x: 96, z: -20, rz: -50, v: 'rose--coral' },
    { x: 60, z: 88, rz: 130, v: 'rose--cream' },
  ];
  for (const s of spots) {
    const el = face(parent, {
      x: `${s.x}px`, y: `${CONE.height - 15}px`, z: `${s.z}px`,
      rx: '90deg', rz: `${s.rz}deg`,
    }, `petal-tip p-rose fallen ${s.v}`);
    sized(el, 30, 24);
  }
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

export function buildBouquet(root) {
  const bq = node(root, { y: '-30px' }, 'bq');

  groundShadow(bq);
  fallenPetals(bq);
  wrap(bq);
  stems(bq);
  tissue(bq);

  plant(bq, (p) => rose(p, 'rose--blush', 17), { a: 0, r: 0, y: -100, tilt: 0, s: 1.45, seed: 1 });
  plant(bq, (p) => rose(p, 'rose--cream', 15), { a: 62, r: 58, y: -78, tilt: 26, s: 1.3, seed: 2 });
  plant(bq, (p) => tulip(p, 'tulip--plum'), { a: 118, r: 62, y: -88, tilt: 28, s: 1.3, seed: 3 });
  plant(bq, (p) => daisy(p, 'daisy--white', 15), { a: 168, r: 62, y: -70, tilt: 34, s: 1.28, seed: 4 });
  plant(bq, (p) => rose(p, 'rose--coral', 15), { a: 222, r: 58, y: -76, tilt: 27, s: 1.25, seed: 5 });
  plant(bq, (p) => tulip(p, 'tulip--butter'), { a: 275, r: 60, y: -86, tilt: 26, s: 1.28, seed: 6 });
  plant(bq, (p) => daisy(p, 'daisy--lavender', 13), { a: 322, r: 56, y: -68, tilt: 31, s: 1.15, seed: 7 });
  plant(bq, (p) => rose(p, 'rose--blush', 13), { a: 4, r: 64, y: -62, tilt: 32, s: 1.05, seed: 17 });

  plant(bq, (p) => sprig(p, 1), { a: 34, r: 68, y: -40, tilt: 28, s: 1, seed: 8 });
  plant(bq, (p) => sprig(p, 5), { a: 145, r: 70, y: -36, tilt: 30, s: 1, seed: 9 });
  plant(bq, (p) => sprig(p, 9), { a: 250, r: 68, y: -38, tilt: 29, s: 1, seed: 10 });
  plant(bq, (p) => greenery(p, 2), { a: 92, r: 66, y: -38, tilt: 34, s: 1, seed: 11 });
  plant(bq, (p) => greenery(p, 6), { a: 200, r: 68, y: -36, tilt: 36, s: 1, seed: 12 });
  plant(bq, (p) => greenery(p, 11), { a: 300, r: 66, y: -38, tilt: 34, s: 1, seed: 13 });
  plant(bq, (p) => bigLeaf(p, { azimuth: 10, open: 52, twist: 8 }), { a: 40, r: 64, y: -50, tilt: 30, s: 1.15, seed: 14 });
  plant(bq, (p) => bigLeaf(p, { azimuth: -14, open: 56, twist: -10 }), { a: 196, r: 62, y: -48, tilt: 32, s: 1.05, seed: 15 });
  plant(bq, (p) => bigLeaf(p, { azimuth: 6, open: 50, twist: 12 }), { a: 286, r: 66, y: -46, tilt: 30, s: 1.1, seed: 16 });

  return {
    planes: root.querySelectorAll('.c3d-face, .c3d-seg').length,
    nodes: root.querySelectorAll('.c3d, .c3d-face, .c3d-seg').length,
  };
}
