/* logic.js : pure flower math for the Paper Flowers bouquet.
   No DOM in here; everything is testable in node (tests/flowers-logic.test.mjs).
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

/* A sunflower is two concentric rings of narrow ray petals: a nearly flat
   outer ring and a slightly raised inner ring filling its gaps. The big
   seed disc is the builder's job; this is only the rays. */
export function sunflowerPetals(outer = 14, inner = 11) {
  const specs = [];
  const oStep = 360 / outer;
  for (let i = 0; i < outer; i++) {
    specs.push({
      azimuth: i * oStep + jitter(i, oStep * 0.1),
      open: 80 + jitter(i, 4, 3),
      size: 1 + jitter(i, 0.06, 5),
      bend: 10 + jitter(i, 5, 7),
      ring: 0,
    });
  }
  const iStep = 360 / inner;
  for (let i = 0; i < inner; i++) {
    specs.push({
      azimuth: iStep / 2 + i * iStep + jitter(i, iStep * 0.1, 11),
      open: 64 + jitter(i, 4, 13),
      size: 0.82 + jitter(i, 0.05, 17),
      bend: 6 + jitter(i, 4, 19),
      ring: 1,
    });
  }
  return specs;
}

/* A peony is a rose that ate the whole spring: more petals, a fuller ramp,
   and a ruffle twist on every petal so the ball reads soft, not machined. */
export function peonyPetals(count = 24) {
  const specs = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 1 : i / (count - 1);
    const eased = easeOutCubic(t);
    specs.push({
      azimuth: (i * GOLDEN_ANGLE) % 360,
      open: lerp(14, 62, eased) + jitter(i, 5),
      size: lerp(0.52, 1, Math.sqrt(t)),
      bend: lerp(6, 30, t) + jitter(i, 6, 2),
      twist: jitter(i, 12, 23),
      lift: lerp(0, 8, t),
    });
  }
  return specs;
}

/* A poppy is four big crumpled petals in a cross plus two smaller inner
   ones on the diagonal. The crumple is a twist; the black heart is paint. */
export function poppyPetals() {
  const specs = [];
  for (let i = 0; i < 2; i++) {
    specs.push({
      azimuth: 45 + i * 180 + jitter(i, 10, 9),
      open: 30 + jitter(i, 4, 11),
      size: 0.8,
      bend: 8,
      twist: jitter(i, 6, 13),
    });
  }
  for (let i = 0; i < 4; i++) {
    specs.push({
      azimuth: i * 90 + jitter(i, 8),
      open: 46 + jitter(i, 5, 3),
      size: 1,
      bend: 12 + jitter(i, 5, 5),
      twist: jitter(i, 7, 7),
    });
  }
  return specs;
}

/* A lily is six long petals in two offset rings of three, thrown wide
   open with strongly recurved tips. Stamens are the builder's job. */
export function lilyPetals() {
  const specs = [];
  for (let i = 0; i < 3; i++) {
    specs.push({ azimuth: i * 120, open: 46 + jitter(i, 3), size: 1, bend: 34 + jitter(i, 5, 3) });
  }
  for (let i = 0; i < 3; i++) {
    specs.push({ azimuth: 60 + i * 120, open: 58 + jitter(i + 3, 3), size: 0.94, bend: 42 + jitter(i + 3, 5, 5) });
  }
  return specs;
}

/* A carnation is a dense golden-angle ruffle: many small petals with a
   twist wobble; the fringed edge lives in the petal-tip's clip-path.
   Twist stays gentle on purpose: past ~8deg the packed petal planes all
   slice each other and Chrome's plane-splitting turns quadratic. */
export function carnationPetals(count = 24) {
  const specs = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 1 : i / (count - 1);
    specs.push({
      azimuth: (i * GOLDEN_ANGLE) % 360,
      open: lerp(12, 64, easeOutCubic(t)) + jitter(i, 6),
      size: lerp(0.6, 1, t),
      bend: 10 + jitter(i, 8, 2),
      twist: jitter(i, 8, 3),
      lift: lerp(0, 7, t),
    });
  }
  return specs;
}

/* Lavender is whorls of tiny buds hugging the top of a tall stem. y is
   height above the flower's seat (negative = up), size shrinks upward. */
export function lavenderWhorls(levels = 6, per = 4) {
  const specs = [];
  for (let k = 0; k < levels; k++) {
    for (let i = 0; i < per; i++) {
      specs.push({
        azimuth: k * 45 + i * (360 / per) + jitter(k * per + i, 10),
        y: -(34 + k * 9 + jitter(k, 2, 5)),
        size: 1 - k * 0.055,
      });
    }
  }
  return specs;
}

/* Evenly spread n points on a sphere (golden-angle spiral), for the
   dandelion clock. Returns {x, y, z} scaled by radius. */
export function spherePoints(n, radius) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const v = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(Math.max(0, 1 - v * v));
    const az = ((i * GOLDEN_ANGLE) % 360) * (Math.PI / 180);
    pts.push({ x: radius * r * Math.cos(az), y: radius * v, z: radius * r * Math.sin(az) });
  }
  return pts;
}

/* Seats for n flower heads arranged as a dome: azimuth around the wrap,
   radius from the axis, height (negative = up), outward tilt, scale.
   Ordered center-out so callers can put focal flowers first. n caps at 12,
   which is what the wrap visually holds. */
export const MAX_STEMS = 12;

export function bouquetSeats(count) {
  const n = clamp(count, 1, MAX_STEMS);
  if (n === 1) return [{ a: 0, r: 0, y: -100, tilt: 0, s: 1.42 }];
  if (n === 2) {
    return [0, 180].map((a, i) => ({ a: a + jitter(i, 8), r: 34, y: -90, tilt: 16, s: 1.32 }));
  }
  if (n === 3) {
    return [0, 120, 240].map((a, i) => ({ a: a + jitter(i, 10), r: 44, y: -86, tilt: 20, s: 1.28 }));
  }
  const seats = [{ a: jitter(0, 20), r: 0, y: -100, tilt: 0, s: 1.4 }];
  const ring1 = Math.min(6, n - 1);
  const ring2 = n - 1 - ring1;
  /* The fuller a ring, the wider it sits and the smaller its heads, and
     alternate seats RISE a little; neighbours interleave instead of
     slicing through each other in one shared plane. The stagger goes up,
     never down: dropped heads sink into the tissue collar and every
     petal-through-tissue crossing costs the compositor a plane split. */
  const r1 = 54 + ring1 * 2;
  const s1 = 1.26 - ring1 * 0.025;
  const step1 = 360 / ring1;
  for (let i = 0; i < ring1; i++) {
    const lift = i % 2 ? 1 : 0;
    seats.push({
      a: i * step1 + jitter(i, step1 * 0.12),
      r: r1,
      y: -78 - lift * 9,
      tilt: 26 + lift * 3,
      s: s1,
    });
  }
  const r2 = 72 + ring2 * 0.8;
  const s2 = 1.04 - ring2 * 0.012;
  const step2 = ring2 > 0 ? 360 / ring2 : 0;
  for (let i = 0; i < ring2; i++) {
    const lift = i % 2 ? 1 : 0;
    seats.push({
      a: step2 / 2 + i * step2 + jitter(i, step2 * 0.1, 3),
      r: r2,
      y: -58 - lift * 8,
      tilt: 37 + lift * 3,
      s: s2,
    });
  }
  return seats;
}

/* ==========================================================================
   Stall order logic: the menu's stem counts as a plain {type: count}
   object. Pure and immutable so the page wiring stays a thin shell.
   ========================================================================== */

export function orderTotal(counts) {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

export function stepCount(counts, key, delta, max = MAX_STEMS) {
  const next = (counts[key] ?? 0) + delta;
  if (next < 0) return counts;
  if (delta > 0 && orderTotal(counts) >= max) return counts;
  return { ...counts, [key]: next };
}

/* A random bunch: 2 to 4 species, 6 stems up to the cap, at least one of
   each pick. rand is injectable so the shape of a surprise stays testable. */
export function surpriseCounts(keys, rand = Math.random, max = MAX_STEMS) {
  const pool = [...keys];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const chosen = pool.slice(0, 2 + Math.floor(rand() * 3));
  const total = Math.min(max, 6 + Math.floor(rand() * (max - 5)));
  const counts = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const key of chosen) counts[key] = 1;
  for (let i = chosen.length; i < total; i++) {
    counts[chosen[Math.floor(rand() * chosen.length)]] += 1;
  }
  return counts;
}

/* ==========================================================================
   Sharing: pure halves of the share feature (ids and payload hygiene).
   The wire format is [{type, count}], stored server-side by
   app/proxys/flowers.php and read back by views/flowers/share.
   ========================================================================== */

/* cyrb53 folded to base36: a tiny, fast, dependency-free string hash for
   share ids. No secure-context requirement (unlike crypto.subtle), and the
   base36 output matches the server-side id sanitizer ([a-z0-9]). Same
   function the tarok scorekeeper uses for its share links. */
export function hashId(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/* Normalize an order loaded from a share link before it reaches the
   builder: drop unknown species and junk entries, floor the counts, merge
   duplicates, and cap the total at MAX_STEMS so a crafted payload can
   never over-plant the scene. Returns [] when nothing survives. */
export function normalizeShareOrder(order, validKeys, max = MAX_STEMS) {
  if (!Array.isArray(order)) return [];
  const valid = new Set(validKeys);
  const counts = new Map();
  let total = 0;
  for (const item of order) {
    if (total >= max) break;
    if (!item || typeof item !== 'object') continue;
    const count = Math.floor(Number(item.count));
    if (!valid.has(item.type) || !Number.isFinite(count) || count <= 0) continue;
    const take = Math.min(count, max - total);
    counts.set(item.type, (counts.get(item.type) ?? 0) + take);
    total += take;
  }
  return [...counts].map(([type, count]) => ({ type, count }));
}

/* The wrap rim's scallop: one cosine wave sampled across a facet's top
   edge. x is 0..100 (percent of face width), y is 0 at the cut's highest
   point and dips to depthPct. phase shifts the wave (0.5 = half a wave),
   and integer wave counts keep both ends at the same height so the edge
   stays continuous across facet seams. */
export function waveEdgePoints(waves, depthPct, samples = 20, phase = 0) {
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const x = i / samples;
    const y = depthPct * 0.5 * (1 - Math.cos(2 * Math.PI * (waves * x + phase)));
    pts.push({ x: x * 100, y });
  }
  return pts;
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
