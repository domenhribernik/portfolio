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
  geometry, sphere point spread, `bouquetSeats` dome arrangement, the rim's `waveEdgePoints`
  scallop, the stall's order logic `stepCount`/`orderTotal`/`surpriseCounts`, deterministic
  `jitter`). Tested by `node --test tests/flowers-logic.test.mjs`.
- `flowers.js`: turns logic.js specs into toolkit DOM. Exports one builder per species,
  the `FLOWER_TYPES` registry the menu renders from, and `buildBouquet(root, order)` where
  `order` is `[{type, count}]`. All paint lives in style.css classes.
- `script.js`: page wiring only (the stall menu + steppers + generate, orbit drag, bloom
  slider, x-ray toggle, share panel, responsive fit).
- `style.css`: skins (petal gradients, wrap, ribbon), scene atmosphere, stall menu states,
  doc mini-demos.
- `share/`: the shared-bouquet page (see "Sharing" below). Reuses `../css3d.css` and
  `../style.css` (skins + atmosphere) plus its own hand-written layout CSS; deliberately
  no Tailwind CDN, so a share link opens fast on phones.

## The generator

The species catalogue is `FLOWER_TYPES` in flowers.js: `{ key, label, latin, build, variants,
planes, focal?, seatAdjust?, preview }`. The menu section (`#stall` in index.html) renders one
card per entry with a live 3D preview built by the SAME builder as the bouquet (previews idle
paused and spin on card hover). Generate clears `#bouquet-root`, calls
`buildBouquet(root, order)`, and replays the bloom.

- `bouquetSeats(n)` (logic.js) returns dome seats center-out; `orderToInstances` round-robins
  across types so neighbours differ and promotes a `focal` flower to the center seat.
- Variants cycle per instance (`i % variants.length`), so three roses come in three colorways.
- `MAX_STEMS` (12) caps the order; the UI enforces it in the steppers.
- Tall self-stemmed species (dandelion, lavender) carry `seatAdjust` to sink their seat so the
  head lines up with the dome. Every other head gets a stem cross drawn INSIDE its tilted
  seat (in `buildBouquet`), so stems lean with their flower and converge into the wrap;
  lengths divide by the seat scale to land at wrap level.
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
  compositor plane-split saved; this is why `bouquetSeats` staggers ring heads UP (never
  down into the tissue collar) and why per-head stems stop 6/10 of the way to the wrap
  rather than converging at the throat.
- **JS-driven camera**: drag sets `--ry`/`--rx` on the stage node; the autospin wrapper sits
  INSIDE the stage so user orbit and idle spin compose instead of fighting.
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
   `bouquetSeats` automatically.

## Verifying

Use the repo `verify` skill (headless Chrome + puppeteer-core in the scratchpad). A shot
harness pattern that works: freeze the spin (`scene.classList.add('spin-paused')`), set stage
`--ry`/`--rx` directly for deterministic angles, and screenshot hero / turned / above / bud
(`--bloom: 0.15`) / x-ray / stall menu / mobile 390px. Steppers and Generate are plain
buttons, so a scripted order (click +, click generate) is one `page.click` chain. The tawk.to
CORS console error on localhost is pre-existing noise.
