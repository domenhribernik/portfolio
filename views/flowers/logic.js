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
  /* 90% of the old 78deg spread: fully flat petals read stamped-out. */
  const { open = 70.2, droop = 6, sizeWobble = 0.08 } = opts;
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
  /* Ray angles sit at 90% of their old 80/64deg spread so the head keeps
     a slight cup instead of opening dead flat. */
  for (let i = 0; i < outer; i++) {
    specs.push({
      azimuth: i * oStep + jitter(i, oStep * 0.1),
      open: 72 + jitter(i, 4, 3),
      size: 1 + jitter(i, 0.06, 5),
      bend: 10 + jitter(i, 5, 7),
      ring: 0,
    });
  }
  const iStep = 360 / inner;
  for (let i = 0; i < inner; i++) {
    specs.push({
      azimuth: iStep / 2 + i * iStep + jitter(i, iStep * 0.1, 11),
      open: 57.6 + jitter(i, 4, 13),
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
   Seat 0 is the pinned focal center; the rest are seeded on a golden-angle
   spiral and relaxed apart by their head sizes. n caps at 12, which is what
   the wrap visually holds. */
export const MAX_STEMS = 12;

/* The dome silhouette as a function of radius from the axis. A head's
   height, outward tilt, and scale are read off this profile, so heads at
   the same radius share a look and the bunch always reads as a dome (tall
   upright center, lower flatter smaller heads toward the rim). SEAT_RMAX is
   the widest a head sits; the wrap rim is at radius ~96, so 84 keeps heads
   inside the paper. Tune these anchors, not the code, to reshape the dome. */
export const SEAT_RMAX = 84;
export const DOME_ANCHORS = [
  { r: 0, y: -100, tilt: 0, s: 1.4 },
  { r: 54, y: -84, tilt: 22, s: 1.22 },
  { r: 66, y: -80, tilt: 27, s: 1.11 },
  { r: 76, y: -60, tilt: 38, s: 0.98 },
  { r: SEAT_RMAX, y: -54, tilt: 40, s: 0.94 },
];

/* Interpolate the dome profile at radius r (clamped into the table's range).
   Piecewise-linear between anchors: cheap, monotone, and easy to eyeball. */
export function domeProfile(r) {
  const rc = clamp(r, DOME_ANCHORS[0].r, DOME_ANCHORS.at(-1).r);
  for (let i = 1; i < DOME_ANCHORS.length; i++) {
    const b = DOME_ANCHORS[i];
    if (rc <= b.r) {
      const a = DOME_ANCHORS[i - 1];
      const t = b.r === a.r ? 0 : (rc - a.r) / (b.r - a.r);
      return {
        y: lerp(a.y, b.y, t),
        tilt: lerp(a.tilt, b.tilt, t),
        s: lerp(a.s, b.s, t),
      };
    }
  }
  const last = DOME_ANCHORS.at(-1);
  return { y: last.y, tilt: last.tilt, s: last.s };
}

/* Two heads may sit this close, as a fraction of their summed visual radii,
   before they read as overlapping. Below 1 the heads kiss and interleave
   (a lush hand-tied look); 1 would force fully disjoint discs, which 12 big
   heads cannot achieve inside the wrap. */
export const PACK_FACTOR = 0.6;
/* The most the pack may shrink a head to resolve a crush. When even the
   floor cannot separate everything (an impossible order), a little overlap
   is accepted rather than rendering invisibly tiny flowers. */
export const SHRINK_FLOOR = 0.75;
/* Fallback head radius (at scale 1) for a species with no HEAD_RADII entry. */
export const DEFAULT_HEAD_R = 30;

/* Nominal plan-view head radius per species at scale 1, in the same units as
   seat radius, so the pack can space heads by their real footprint. Kept here
   (not in FLOWER_TYPES) so the placement math stays pure and testable. Tune
   these against screenshots: too big and the bunch reads gappy, too small and
   heads merge. */
export const HEAD_RADII = {
  rose: 33,
  peony: 33,
  sunflower: 35,
  lily: 34,
  poppy: 30,
  tulip: 18,
  daisy: 24,
  carnation: 26,
  dandelion: 24,
  lavender: 12,
};

const RELAX_ITERS = 32;
const RELAX_DAMP = 0.6;

/* Read the dome profile at a seat's radius and apply its stored upward-only
   stagger. Called at seeding and after every relaxation move, so a seat's
   height, tilt, and scale always match wherever it has been pushed to. */
function seatToDome(seat) {
  const p = domeProfile(seat.r);
  seat.y = p.y - seat.stag;
  seat.tilt = p.tilt;
  seat.s = p.s;
}

/* Seed n seats on a golden-angle spiral: seat 0 pinned at the axis, the
   rest fanned to SEAT_RMAX with sqrt spacing (even area density, not
   bunched at the rim). Each seat carries a deterministic upward-only
   stagger so no two heads share a plane. */
function seedSpiral(n) {
  const center = domeProfile(0);
  const seats = [{ a: jitter(0, 20), r: 0, stag: 0, y: center.y, tilt: center.tilt, s: center.s }];
  for (let i = 1; i < n; i++) {
    const seat = {
      a: (i * GOLDEN_ANGLE + jitter(i, 10, 17)) % 360,
      r: SEAT_RMAX * Math.sqrt(i / (n - 1)),
      // Upward-only lift in [0, 10) from the golden-ratio low-discrepancy
      // sequence (conjugate 0.618, offset 0.13): its values stay maximally
      // spread, so heads at neighbouring radii never settle at the same
      // height, which would pile their petals into one compositor plane.
      stag: ((i * 0.6180339887 + 0.13) % 1) * 10,
    };
    seatToDome(seat);
    seats.push(seat);
  }
  return seats;
}

export function bouquetSeats(count, sizes = []) {
  const n = clamp(count, 1, MAX_STEMS);
  if (n === 1) return [{ a: 0, r: 0, y: -100, tilt: 0, s: 1.42 }];
  if (n === 2) {
    return [0, 180].map((a, i) => ({ a: a + jitter(i, 8), r: 34, y: -90, tilt: 16, s: 1.32 }));
  }
  if (n === 3) {
    return [0, 120, 240].map((a, i) => ({ a: a + jitter(i, 10), r: 44, y: -86, tilt: 20, s: 1.28 }));
  }
  const seats = seedSpiral(n);
  relaxSeats(seats, sizes);
  for (const seat of seats) delete seat.stag;
  return seats;
}

/* The plan-view (looking down the axis) position of a seat. */
function planXZ(seat) {
  const rad = (seat.a * Math.PI) / 180;
  return { x: seat.r * Math.cos(rad), z: seat.r * Math.sin(rad) };
}

/* The center-to-center distance two heads must keep, so they overlap by at
   most 1 - PACK_FACTOR of their summed visual radii. */
function requiredGap(seats, sizes, i, j) {
  const ri = (sizes[i] ?? DEFAULT_HEAD_R) * seats[i].s;
  const rj = (sizes[j] ?? DEFAULT_HEAD_R) * seats[j].s;
  return (ri + rj) * PACK_FACTOR;
}

/* Push overlapping heads apart in the plan view (a damped Jacobi relaxation),
   then a single provable shrink so the guarantee holds exactly. Seat 0 (the
   focal center) is immovable, so its neighbours take the full push away from
   it. Each pass re-derives every moved seat's height/tilt/scale from the dome
   profile at its new radius, keeping the silhouette intact. Deterministic:
   coincident heads separate along a jittered-but-fixed angle. */
function relaxSeats(seats, sizes) {
  const n = seats.length;
  for (let iter = 0; iter < RELAX_ITERS; iter++) {
    const pos = seats.map(planXZ);
    const push = seats.map(() => ({ x: 0, z: 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[j].x - pos[i].x;
        const dz = pos[j].z - pos[i].z;
        let dist = Math.hypot(dx, dz);
        const required = requiredGap(seats, sizes, i, j);
        if (dist >= required) continue;
        let ux;
        let uz;
        if (dist < 1e-6) {
          const ang = (jitter(i * 31 + j, 180, 7) * Math.PI) / 180;
          ux = Math.cos(ang);
          uz = Math.sin(ang);
        } else {
          ux = dx / dist;
          uz = dz / dist;
        }
        if (i === 0) {
          // The center never moves; j alone takes the whole correction.
          push[j].x += ux * (required - dist) * RELAX_DAMP;
          push[j].z += uz * (required - dist) * RELAX_DAMP;
        } else {
          const half = (required - dist) * 0.5 * RELAX_DAMP;
          push[i].x -= ux * half;
          push[i].z -= uz * half;
          push[j].x += ux * half;
          push[j].z += uz * half;
        }
      }
    }
    for (let i = 1; i < n; i++) {
      const nx = pos[i].x + push[i].x;
      const nz = pos[i].z + push[i].z;
      seats[i].r = clamp(Math.hypot(nx, nz), 0, SEAT_RMAX);
      seats[i].a = (Math.atan2(nz, nx) * 180) / Math.PI;
      seatToDome(seats[i]);
    }
  }
  // One-shot shrink: required is linear in scale, so scaling every head by
  // the tightest pair's ratio makes that pair meet its gap exactly and every
  // looser pair clear it. Never grow (clamp <= 1), never vanish (>= floor).
  let m = Infinity;
  const pos = seats.map(planXZ);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dist = Math.hypot(pos[i].x - pos[j].x, pos[i].z - pos[j].z);
      const required = requiredGap(seats, sizes, i, j);
      if (required > 0) m = Math.min(m, dist / required);
    }
  }
  m = clamp(m, SHRINK_FLOOR, 1);
  if (m < 1) for (const seat of seats) seat.s *= m;
}

/* Where a point on a seat's local axis lands in the bouquet frame. A seat is
   placed by translate(z=r, y=y) then rotateX(-tilt) then scale(s), so a point
   localY down the local stem (y grows down) maps to y + s*localY*cos(tilt)
   (down) and r - s*localY*sin(tilt) (inward). The stem path is planar in this
   (z, y) slice because it stays on the seat's azimuth. */
export function seatPoint(seat, localY) {
  const t = (seat.tilt * Math.PI) / 180;
  const s = seat.s ?? 1;
  return {
    z: seat.r - s * localY * Math.sin(t),
    y: seat.y + s * localY * Math.cos(t),
  };
}

/* Where each stem ties off near the axis, just inside the wrap throat: a
   small jittered radius (rMin..rMax off-axis, either side) and depth
   (yMin..yMax below the rim), so the ends gather like a hand-tied bundle and
   stay hidden under the paper. minDrop keeps the tie at least this far below a
   stem's foot, for greens whose foot already sits near the rim. */
export const STEM_BIND = { rMin: 4, rMax: 14, yMin: 2, yMax: 14, minDrop: 6 };
/* Each chord is drawn a hair longer than its span so neighbouring segments
   overlap at the joints instead of leaving a gap. */
export const OVERLAP_EPS = 1.2;

/* A curved stem from a flower head down to its tie point, as a chain of
   straight chords in the seat's (z, y) plane (z = radius from the axis, y
   down). One quadratic Bezier: it starts along the head's own tilt (so the
   stem grows cleanly out of the flower) and gathers in to the bind near the
   axis. footY starts the stem lower than the head origin, for species that
   carry their own spine down to that point (dandelion, lavender, greens).
   Returns one {y, z, tilt, len, t0, t1} per chord (tilt in seat convention,
   t0/t1 the chord's span along the stem for the gradient). */
export function stemPath(seat, opts = {}) {
  const { segments = 4, seed = 0, footY = 0 } = opts;
  const p0 = seatPoint(seat, footY);
  const bindMag = STEM_BIND.rMin + Math.abs(jitter(seed, STEM_BIND.rMax - STEM_BIND.rMin, 31));
  const bindZ = (jitter(seed, 1, 29) < 0 ? -1 : 1) * bindMag;
  let bindY = STEM_BIND.yMin + Math.abs(jitter(seed, STEM_BIND.yMax - STEM_BIND.yMin, 37));
  bindY = Math.max(bindY, p0.y + STEM_BIND.minDrop);
  const p2 = { z: bindZ, y: bindY };

  // Control point along the head's tilt direction (down and inward), pulled
  // no further down than the bind so the curve's height stays monotone. This
  // makes the start tangent exactly the head tilt for any positive reach.
  const t = (seat.tilt * Math.PI) / 180;
  const dist = Math.hypot(p2.z - p0.z, p2.y - p0.y);
  const reach = Math.min(0.5 * dist, (p2.y - p0.y) / Math.max(Math.cos(t), 0.2));
  const p1 = { z: p0.z - reach * Math.sin(t), y: p0.y + reach * Math.cos(t) };

  const at = (tt) => {
    const mt = 1 - tt;
    return {
      z: mt * mt * p0.z + 2 * mt * tt * p1.z + tt * tt * p2.z,
      y: mt * mt * p0.y + 2 * mt * tt * p1.y + tt * tt * p2.y,
    };
  };

  const chords = [];
  let prev = at(0);
  for (let i = 1; i <= segments; i++) {
    const cur = at(i / segments);
    const dz = cur.z - prev.z;
    const dy = cur.y - prev.y;
    chords.push({
      z: (prev.z + cur.z) / 2,
      y: (prev.y + cur.y) / 2,
      tilt: (Math.atan2(-dz, dy) * 180) / Math.PI,
      len: Math.hypot(dz, dy) + OVERLAP_EPS,
      t0: (i - 1) / segments,
      t1: i / segments,
    });
    prev = cur;
  }
  return chords;
}

/* The render tier for a device. Coarse-pointer devices (phones, tablets) get
   the lighter 'lite' tier: fewer petals and stem segments, no idle sway. Note
   reduced motion is handled separately in CSS, so it does not flip the tier
   (a fine-pointer laptop with reduced motion still renders full fidelity). */
export function renderTier({ coarse = false } = {}) {
  return coarse ? 'lite' : 'full';
}

/* Petal count for the current tier: full keeps the authored count; lite drops
   to two thirds (fewer planes and fewer petal-petal intersections, the
   quadratic compositor cost), never below a floor so a head still reads full. */
export function tierPetals(tier, count, min = 8) {
  return tier === 'lite' ? Math.max(min, Math.round((count * 2) / 3)) : count;
}

/* Blend two #rrggbb colours channel by channel; used so a chained stem reads
   as one smooth gradient instead of banding at each segment joint. */
export function mixHex(a, b, t) {
  const chan = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2]
    .map((i) => Math.round(lerp(chan(a, i), chan(b, i), t)).toString(16).padStart(2, '0'))
    .join('');
  return `#${out}`;
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
