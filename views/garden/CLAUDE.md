# views/garden (Paper Garden)

A 3D bouquet built from flat divs, and the home of the site's reusable **3D CSS toolkit**.
To build another 3D CSS scene anywhere on the site, copy `css3d.css` + `css3d.js` (they have
no dependencies and nothing garden-specific) and follow the contract below.

## File map

- `css3d.css` / `css3d.js`: the generic toolkit. Scene, nodes, faces, hinges, segments, and
  the DOM helpers (`node`, `face`, `seg`, `ring`). Keep these two files free of anything
  flower-specific so they stay liftable.
- `logic.js`: pure math, no DOM (golden-angle rose spirals, tulip/daisy rings, cone geometry,
  deterministic `jitter`). Tested by `node --test tests/garden-logic.test.mjs`.
- `flowers.js`: turns logic.js specs into toolkit DOM. All paint lives in style.css classes.
- `script.js`: page wiring only (orbit drag, bloom slider, x-ray toggle, responsive fit).
- `style.css`: skins (petal gradients, wrap, ribbon), scene atmosphere, doc mini-demos.

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
  name so it never collides with the pipeline resets.
- **Never animate `transform` on a node that uses the pipeline** (the animation would replace
  it). Animate the independent `rotate` property on a dedicated wrapper node instead: see
  `.autospin` (`rotate: y`) and `.sway` (`rotate: z`) in style.css. Doc mini-demos that DO
  keyframe `transform` (`.demo-petal`) bake the full pipeline into the keyframes.
- **`clip-path` clips outlines and box-shadows.** X-ray mode uses a faint background fill,
  not just an outline, or clipped faces (the wrap cone) vanish.
- **JS-driven camera**: drag sets `--ry`/`--rx` on the stage node; the autospin wrapper sits
  INSIDE the stage so user orbit and idle spin compose instead of fighting.
- Planes are double-sided by default; fake depth with left/right darkening gradient layers.
  `.c3d-oneside` (backface-visibility) exists for true two-sided skins.
- Keep total plane count in the low hundreds and avoid box-shadow/filter on per-petal
  elements; gradients only.

## Building a new organism (the recipe)

1. Write a pure spec function in logic.js returning `{azimuth, open, size, bend, ...}` per
   plane, using `jitter(i, amount, salt)` (deterministic, testable) instead of Math.random.
   Add a test in `tests/garden-logic.test.mjs`.
2. In flowers.js, feed specs through `petal()`/`face()`/`node()`, sizes in px via `sized()`,
   colors ONLY as a variant class (e.g. `rose--blush` defines `--c1/--c2/--c3` in style.css;
   petal classes read them, so a new colorway is 1 CSS line).
3. Plant it with `plant(bq, builder, { a, r, y, tilt, s, seed })`: azimuth around the dome,
   radius from the axis, height (negative = up), outward tilt, scale.

## Verifying

Use the repo `verify` skill (headless Chrome + puppeteer-core in the scratchpad). A shot
harness pattern that works: freeze the spin (`scene.classList.add('spin-paused')`), set stage
`--ry`/`--rx` directly for deterministic angles, and screenshot hero / turned / above / bud
(`--bloom: 0.15`) / x-ray / mobile 390px. The tawk.to CORS console error on localhost is
pre-existing noise.
