/* logic.js : pure flower math for the Paper Garden bouquet.
   No DOM in here; everything is testable in node (tests/garden-logic.test.mjs).
   Angles are degrees, distances are unitless numbers the builders turn into px. */

export const GOLDEN_ANGLE = 137.508;

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/* Deterministic jitter: same input, same wobble, so the bouquet is stable
   across reloads and the math stays testable. Returns a value in [-amount, amount]. */
export function jitter(i, amount, salt = 1) {
  const x = Math.sin((i + 1) * 127.1 * salt) * 43758.5453;
  return (x - Math.floor(x)) * 2 * amount - amount;
}

/* A rose is one golden-angle spiral. Petal i sits at azimuth i * 137.508deg;
   openness, size and curl all grow from the tight bud in the middle to the
   loose outer petals. Returns specs ordered inner to outer. */
export function rosePetals(count, opts = {}) {
  const {
    minOpen = 8,     // deg from vertical, innermost petal
    maxOpen = 76,    // deg from vertical, outermost petal
    minSize = 0.42,  // scale of innermost petal
    maxSize = 1,
    curl = 30,       // outward bend of the outer petal tips, deg
  } = opts;
  const specs = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 1 : i / (count - 1);
    const eased = easeOutCubic(t);
    specs.push({
      azimuth: (i * GOLDEN_ANGLE) % 360,
      open: lerp(minOpen, maxOpen, eased) + jitter(i, 3),
      size: lerp(minSize, maxSize, Math.sqrt(t)),
      bend: lerp(4, curl, t) + jitter(i, 4, 2),
      lift: lerp(0, 6, t), // outer petals sit a touch lower on the stem
    });
  }
  return specs;
}

/* A tulip is two rings of three cupped petals, the outer ring offset 60deg.
   Petals stay steep and bend inward at the tip (negative bend) to close the cup. */
export function tulipPetals() {
  const specs = [];
  for (let i = 0; i < 3; i++) {
    specs.push({ azimuth: i * 120, open: 14 + jitter(i, 2), size: 0.92, bend: -16 });
  }
  for (let i = 0; i < 3; i++) {
    specs.push({ azimuth: 60 + i * 120, open: 26 + jitter(i + 3, 3), size: 1, bend: -10 });
  }
  return specs;
}

/* A daisy is one flat ring of narrow petals, opened almost horizontal,
   with a little per-petal droop and length wobble so it reads as grown,
   not stamped. */
export function daisyPetals(count, opts = {}) {
  const { open = 78, droop = 6, sizeWobble = 0.08 } = opts;
  const specs = [];
  const step = 360 / count;
  for (let i = 0; i < count; i++) {
    specs.push({
      azimuth: i * step + jitter(i, step * 0.12),
      open: open + jitter(i, droop, 3),
      size: 1 + jitter(i, sizeWobble, 5),
      bend: 8 + jitter(i, 4, 7),
    });
  }
  return specs;
}

/* Geometry of a truncated cone (the paper wrap) approximated by n flat
   trapezoid faces. rTop > rBottom, apex pointing down. Faces meet at their
   vertical edges, so each face is a chord of the circle, tilted outward. */
export function coneFaces(n, rTop, rBottom, height) {
  const half = Math.PI / n;
  const width = 2 * rTop * Math.sin(half);            // top edge chord
  const bottomFrac = rBottom / rTop;                  // bottom edge, as a fraction
  const tilt = (Math.atan2(rTop - rBottom, height) * 180) / Math.PI;
  const midApothem = ((rTop + rBottom) / 2) * Math.cos(half);
  const faces = [];
  for (let i = 0; i < n; i++) {
    faces.push({ angle: (i * 360) / n, width, bottomFrac, tilt, push: midApothem });
  }
  return faces;
}
