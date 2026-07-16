# views/flowers (Paper Flowers)

A build-your-own 3D bouquet from flat divs, and the home of the site's reusable **3D CSS
toolkit**. Formerly `views/garden`. To build another 3D CSS scene anywhere on the site, copy
`css3d.css` + `css3d.js` (they have no dependencies and nothing flower-specific) and follow
the contract below.

## File map

- `css3d.css` / `css3d.js`: the generic toolkit. Scene, nodes, faces, hinges, segments, and
  the DOM helpers (`node`, `face`, `seg`, `ring`). Keep these two files free of anything
  flower-specific so they stay liftable.
- `logic.js`: pure math and state, no DOM (petal spec functions for all ten species, cone
  geometry, sphere point spread + the `dandelionTufts` clock shell, `domeProfile` +
  `bouquetSeats` collision-free dome arrangement, `seatPoint`/`spineSeat`/`stemPath`
  curved-stem geometry, `renderTier`/`tierPetals` device
  tiering, `mixHex`, the rim's `waveEdgePoints` scallop, the stall's order logic
  `stepCount`/`orderTotal`/`surpriseCounts`, deterministic `jitter`). Tested by
  `node --test tests/flowers-logic.test.mjs`.
- `flowers.js`: turns logic.js specs into toolkit DOM. Exports one builder per species,
  the `FLOWER_TYPES` registry the menu renders from, and `buildBouquet(root, order, opts)`
  where `order` is `[{type, count}]` and `opts` is `{ greens?, tier? }`. All paint lives in
  style.css classes.
- `script.js`: page wiring only (the stall menu + steppers + generate, bloom slider, x-ray
  toggle, share panel, responsive fit; orbit is delegated to orbit.js).
- `orbit.js`: the shared drag-to-turn driver (`attachOrbit`) and offscreen pause
  (`pauseOffscreen`), imported by all three pages (builder, share, bloom) so they stop
  carrying near-identical copies. rAF-coalesced writes; `axes: 'x'` for the scrolling pages.
- `fps.js`: opt-in on-screen frame meter (`mount`), dynamically imported only on `?fps=1`,
  for checking rotation smoothness on a real phone.
- `style.css`: skins (petal gradients, wrap, ribbon), scene atmosphere, stall menu states,
  doc mini-demos, and the `@media (pointer: coarse)` lite-tier overrides.
- `share/`: the shared-bouquet page (see "Sharing" below). Reuses `../css3d.css` and
  `../style.css` (skins + atmosphere) plus its own hand-written layout CSS; deliberately
  no Tailwind CDN, so a share link opens fast on phones.

## The generator

The species catalogue is `FLOWER_TYPES` in flowers.js: `{ key, label, latin, build, variants,
planes, focal?, seatAdjust?, preview }`. The menu section (`#stall` in index.html) renders one
card per entry with a live 3D preview built by the SAME builder as the bouquet (previews idle
paused and spin on card hover). Generate clears `#bouquet-root`, calls
`buildBouquet(root, order)`, and replays the bloom.

- `bouquetSeats(n, sizes)` (logic.js) returns collision-free dome seats. n=1..3 stay literal;
  n>=4 seed on a golden-angle spiral, then a deterministic repulsion relaxation pushes heads
  apart by their `sizes` (per-instance `HEAD_RADII` at scale 1, passed by `buildBouquet`).
  Seat 0 is the pinned focal center (no longer "center-out ordered": relaxation binds seat i
  to instance i, so seats can't be re-sorted by radius). Two heads may sit `PACK_FACTOR` (0.6)
  of their summed radii apart, so they kiss and interleave rather than reading as gappy; a
  final one-shot scale-down (`SHRINK_FLOOR` 0.75) guarantees the no-overlap invariant even for
  12 big heads. Height/tilt/scale come from `domeProfile(r)` (a radius->silhouette table) plus
  a small golden low-discrepancy upward-only stagger, so co-radius heads never share a plane.
  `orderToInstances` still round-robins types and promotes a `focal` flower to seat 0.
  The no-overlap and dome-silhouette invariants are unit-tested against the exported constants,
  so calibrating the constants can't silently break them.
- Variants cycle per instance (`i % variants.length`), so three roses come in three colorways.
- `MAX_STEMS` (12) caps the order; the UI enforces it in the steppers.
- **Stems curve into a hand-tied bundle.** `stemPath(seat, {segments, seed, footY})` (logic.js)
  is one quadratic Bezier from a head's base down to a jittered bind point near the axis, DEEP
  in the wrap, almost at the cone's base (`STEM_BIND`; the tie depth matters: rim-high ties
  curl every stem inward right below the heads, deep ties keep the run long and near-straight,
  arriving near-vertical). Sampled into straight chords. It starts along the head's own
  tilt (so the stem grows cleanly out of the flower) and gathers inward; `seatPoint` projects
  the seat-local start into the bouquet frame. `buildBouquet`'s `plantStemmed` hangs each chord
  on the flower's SWAY node (a sibling of the seat, in the seat's azimuth plane), so the stem
  leans and sways with its flower but is NOT scaled by the seat (stemPath already works in
  bouquet-frame units, unlike the old scale-divided straight stem). Chords emit a seat-convention
  `tilt` (positive = leans outward); the builder writes `rx: -tilt`, matching `plant()`. Each
  chord wears a slice of the stem gradient (`mixHex`) so the chain reads as one stalk; heads run
  light->dark, spine species (dandelion, lavender, greens) run dark->dark so the joint with their
  own spine doesn't band. The bind sits deep inside the cone, hidden by the paper. There is no
  separate decorative throat-stem ring any more; the real stems fill the throat. `footY` starts the curve
  at a self-stemmed species' spine foot (`stemFoot` in `FLOWER_TYPES`: dandelion 6, lavender 10;
  greens pass their own).
- Tall self-stemmed species sink their seat so the head lines up with the dome. The dandelion
  does it with `headLift`: `buildBouquet` runs the seat through `spineSeat(seat, lift)`
  (logic.js), which sinks it ALONG THE TILTED SPINE AXIS so the head lands exactly on the dome
  point the packer reserved. Sinking straight down instead (the older static `seatAdjust`,
  still used by lavender) leaves the radial term uncompensated; a 70px spine on a ~40deg rim
  seat overshot the wrap by ~45px, reading as a ball of white dots hovering in the sky.
- The wrap rim is `scallopClip` in flowers.js over `waveEdgePoints`: one smooth cosine arc
  per facet, with the liner half a phase offset so its crests peek through the outer dips.
  Integer wave counts keep the edge continuous across facet seams.
- The stall's stepper/cap/surprise behavior lives in logic.js (`stepCount`, `orderTotal`,
  `surpriseCounts`); script.js only renders state. `surpriseCounts` takes an injectable
  `rand` for deterministic tests.
- `regrow` (script.js) animates `--bloom` via rAF but also arms a `setTimeout` fallback that
  snaps to full bloom, because rAF can stall in throttled/background tabs (found via the
  headless sweep).
- The menu's colorway dots are `.swatch` elements wearing the variant class itself, reading
  the same `--c1/--c2/--c3` the petals read, so they can't drift.

**Adding a species:** spec function in logic.js (use `jitter`, add a test), builder in
flowers.js, skin + variant classes in style.css, one `FLOWER_TYPES` entry. The menu card,
steppers, plane estimate, and bouquet placement all come free.

## Sharing

The share button in the controls strip saves the STAGED order (`stagedOrder`, captured at
generate time, not the steppers) plus an optional note through
[app/proxys/flowers.php](../../app/proxys/flowers.php), which stores each bouquet as a JSON
file in `app/cache/flowers/` and prunes anything older than 7 days on every save (same
pattern as `tarok.php`; no auth, links are public by design). The link points at
`share/?b=<id>`; ids come from `hashId` in logic.js (cyrb53, base36, matches the server's
`[a-z0-9]` sanitizer). On phones the button hands the URL to `navigator.share`; otherwise
it copies to the clipboard.

`share/index.html` kicks off the payload fetch in an inline script (`window.__bouquet`)
before the module graph loads, then `share/script.js` runs the loaded order through
`normalizeShareOrder` (logic.js: drops unknown species, merges duplicates, caps at
`MAX_STEMS` so a crafted payload can't over-plant the scene), shows the note via
`textContent` (never innerHTML), builds with the same `buildBouquet`, and replays the
bloom. Any failure (missing id, expired, malformed) shows the "wilted" state. The share
scene allows `touch-action: pan-y` and its orbit reads only horizontal drags, so the page
still scrolls on touch. Server-side validation is tested by
`/opt/lampp/bin/php tests/flowers-share.test.php` (boots the PHP built-in server, no DB);
`hashId`/`normalizeShareOrder` are covered in `tests/flowers-logic.test.mjs`.

Local gotcha: Apache runs as `daemon`, so an `app/cache/flowers/` dir created by the CLI
test suite is unwritable from the browser (save 500s with `write_failed`). Locally
`chmod 777` it; in prod the proxy's own `mkdir` creates it with the right owner.

## The toolkit contract

Three concepts: a `.c3d-scene` establishes `perspective`; `.c3d` nodes are invisible 0x0
coordinate frames that nest; `.c3d-face` planes are the only visible things. Every node and
face runs the same custom-property transform pipeline, in this order:

1. `--x --y --z`: position in the parent's space (y grows DOWN, so "up" is negative)
2. `--ry` then `--rx` then `--rz`: azimuth, tilt, twist
3. `--ox --oy --oz`: push along the freshly rotated local axes ("rotate, then push" makes
   rings: same `--oz`, step `--ry`)
4. `--s`: uniform scale

Variants: `.c3d-face--hinge` pivots on its bottom-center edge (petals, leaves, lids; the
element extends upward from its node's origin). `.c3d-seg` sits on the top edge of its parent
plane and bends at the joint by `--bend`; chain a few with the same bend and a flat div reads
as a curved surface.

**Sign convention: negative `--rx` leans a hinged plane outward** (toward its own face
normal). Specs in logic.js keep openness positive; flowers.js multiplies by `-1` in the calc.

## Gotchas learned the hard way

- **Pipeline vars must not inherit.** Custom properties cascade to children, and a child node
  re-applying its parent's `--ry`/`--s` in its own transform compounds transforms down the
  tree (the first render exploded the bouquet ~5x at petal depth). css3d.css therefore
  declares identity defaults (`--s: 1`, `--ry: 0deg`, ...) on `.c3d`, `.c3d-face`, and
  `.c3d-seg`. If you add a new pipeline variable, add its identity default there too.
- **Deliberately inherited vars are the payoff.** `--bloom` is set once on the stage and read
  by every petal via `--rx: calc(var(--open) * var(--bloom, 1) * -1)`. One variable animates
  hundreds of planes. Same trick works for any scene-wide parameter, but give it a distinct
  name so it never collides with the pipeline resets. (The menu previews set `--bloom: 1` on
  their own tiny scenes for the same reason.)
- **Never animate `transform` on a node that uses the pipeline** (the animation would replace
  it). Animate the independent `rotate` property on a dedicated wrapper node instead: see
  `.autospin` (`rotate: y`) and `.sway` (`rotate: z`) in style.css. Doc mini-demos that DO
  keyframe `transform` (`.demo-petal`) bake the full pipeline into the keyframes.
- **`clip-path` clips outlines and box-shadows.** X-ray mode uses a faint background fill,
  not just an outline, or clipped faces (the wrap cone) vanish.
- **NEVER put `clip-path` on a plane that intersects other planes.** When preserve-3d
  planes cross, Chrome splits them for correct ordering, and a clipped polygon makes that
  splitting explode: four clip-tipped sunflowers froze the renderer for minutes; the same
  four with border-radius arches paint in 0.4s. Petals ALWAYS intersect their packed
  neighbours, so petal shapes come from border-radius only. The one allowed clip is the
  wrap cone's scallop, whose faces barely intersect anything. If a shape truly needs
  cutting (the carnation fringe), use a `mask-image` instead: masks rasterize the cut but
  keep the plane a plain quad for the splitter.
- **Keep dense flower heads split-friendly**: petals in a packed ball (carnation) need
  gentle twist (|rz| <= ~8deg) and a per-petal `lift`/`push` so the planes fan instead of
  all crossing at one shared origin. Every avoided petal-through-petal crossing is a
  compositor plane-split saved; this is why `bouquetSeats` staggers heads UP only (never
  down into the tissue collar) and spreads their heights with a low-discrepancy stagger so
  neighbours don't share a plane. Stems curve into the throat (`stemPath`) and their bind
  ends sit below the rim, hidden by the paper.
- **A species' own stalk must span its foliage.** The bundle stem (`stemPath`) only runs from
  `footY` DOWN into the wrap; everything above the foot is the species' own `stemCross`, and it
  must reach INTO the visual mass (the dandelion ball's center, the sprig's lowest puffs, the
  euca's top leaf pair). A stalk that stops short leaves puffs/leaves floating in the sky,
  which is exactly how the sprig (top -10 vs puffs from -48) and euca (top -12 vs leaves to
  -100) originally shipped.
- **Sparse translucent shells read as dots, not volume.** The dandelion clock needs its tuft
  ink to cover roughly a third of the sphere shell (unit-tested against `dandelionTufts`
  defaults) plus the three faint `dand-halo` discs underneath; thin it only via `tierPetals`
  count, never by shrinking tuft faces, or it falls apart into specks against the dark
  backdrop.
- **Flat flowers' cores ride the bloom.** The sunflower and daisy seed cores set `--y`
  through `bloomY(open, closed)` (flowers.js): the core caps the closed bud, then settles
  onto the petal disc as the petals fold flat. A fixed-height core hovers in mid-air at
  full bloom, and its dark petal-base ring shows around it.
- **The carnation fringe mask points its teeth OUT.** The sawtooth tile is a conic wedge
  anchored at `50% 0` (apex on the tile's top edge, full-width at the bottom) so the band
  fuses with the petal body and the sawtooth is the silhouette. Anchoring at `50% 100%`
  renders the opposite: a detached flat strip with the notches facing into the petal.
- **JS-driven camera**: `attachOrbit` (orbit.js) sets `--ry`/`--rx` on the stage node; the
  autospin wrapper sits INSIDE the stage so user orbit and idle spin compose instead of
  fighting. Writes are coalesced to one per rAF (a 120Hz digitizer fires several moves a
  frame, and each write invalidates the whole preserve-3d scene).
- Planes are double-sided by default; fake depth with left/right darkening gradient layers.
  `.c3d-oneside` (backface-visibility) exists for true two-sided skins.
- Keep total plane count in the low hundreds and avoid box-shadow/filter on per-petal
  elements; gradients only. The stall's 12-stem cap and the per-type `planes` estimates
  exist to hold that budget with user-chosen orders.

## Building a new organism (the recipe)

1. Write a pure spec function in logic.js returning `{azimuth, open, size, bend, twist?, ...}`
   per plane, using `jitter(i, amount, salt)` (deterministic, testable) instead of
   Math.random. Add a test in `tests/flowers-logic.test.mjs`.
2. In flowers.js, feed specs through `petal()`/`face()`/`node()`, sizes in px via `sized()`,
   colors ONLY as a variant class (e.g. `rose--blush` defines `--c1/--c2/--c3` in style.css;
   petal classes read them, so a new colorway is 1 CSS line).
3. Register it in `FLOWER_TYPES` so the stall can sell it; `buildBouquet` seats it via
   `bouquetSeats` automatically. Give it a `HEAD_RADII` entry (logic.js) so the pack spaces
   it by its real footprint; without one it falls back to `DEFAULT_HEAD_R` (30). If it is
   dense, route its petal count through `tierPetals(tier, count)` in its `build` fn so it
   thins on phones.

## Performance and the lite tier

The whole bouquet is one `preserve-3d` context of hundreds of intersecting gradient planes,
and every frame of rotation re-sorts and plane-splits them, so the cost scales with plane
count and with how often the scene is invalidated. The mitigations, all keyed off the render
tier:

- `renderTier({ coarse })` returns `'lite'` on coarse-pointer devices (phones, tablets),
  `'full'` otherwise. Each page computes it once (`matchMedia('(pointer: coarse)')`) and threads
  it into `buildBouquet({ tier })`; `FLOWER_TYPES` `build` fns take it as a 4th arg.
- Lite tier: dense species drop to ~2/3 petals (`tierPetals`), stems use 3 chords instead of 4,
  and CSS under `@media (pointer: coarse)` turns off the per-flower `.sway`, drops the
  full-screen film grain, and lightens the vignette. `.grabbing .sway` (all devices) also
  freezes sway during a drag, and `.offstage` (toggled by `pauseOffscreen`) freezes autospin +
  sway while the scene is scrolled out of view.
- The stall menu builds its ten preview flowers lazily on coarse pointers (an
  IntersectionObserver builds each as it nears the viewport) so the mobile page does not do a
  ~360-plane synchronous dump up front.
- Reduced motion is a separate axis from the tier: it is handled purely in CSS (existing rules
  kill autospin/sway) and does NOT flip a fine-pointer device to lite.

## Verifying

Use the repo `verify` skill (headless Chrome + puppeteer-core in the scratchpad). A shot
harness pattern that works: freeze the spin (`scene.classList.add('spin-paused')`), set stage
`--ry`/`--rx` directly for deterministic angles, and screenshot hero / turned / above / bud
(`--bloom: 0.15`) / x-ray / stall menu / mobile 390px. Steppers and Generate are plain
buttons, so a scripted order (click +, click generate) is one `page.click` chain. The tawk.to
CORS console error on localhost is pre-existing noise.

Two gotchas that produce wrong screenshots: (1) the initial `generate()` animates `--bloom`
through a 2.6s rAF loop that overwrites any value you set on the stage, so wait ~3s after
load (or trigger your own generate and wait it out) before pinning `--bloom`; (2) the hero
headline is an overlay SIBLING of `#scene`, so element screenshots of the scene include it.
Hide `#scene ~ *` and `header` before pixel analysis: the sage copy color classifies as
stem green.

**Headless renders the FULL tier by default.** `--headless=new` reports `pointer: fine`, so an
unspoofed page loads the full-fidelity tier. To screenshot or trace the lite (mobile) tier,
force a coarse pointer:
`--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2`
(and the fine spoof for full is `...HoverType=2,...PointerType=4`). Note this corrects an older
note elsewhere that assumed headless is coarse by default.

**Headless runs the heavy scene at ~1fps**, which starves rAF and IntersectionObserver
callbacks: drag inertia barely advances, and `pauseOffscreen`/lazy previews look like they do
not fire. They do; pause the spin (`scene.classList.add('spin-paused')`) to free the main
thread when verifying those, or trust that they work on real hardware. For frame timing, drive
`page.emulateCPUThrottling(4)` and parse `DrawFrame` deltas, or open any page with `?fps=1` on a
real device for the on-screen meter.
