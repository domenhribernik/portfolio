# views/wildflowers (Wild Flowers)

The WebGL twin of [views/flowers](../flowers/): the same bouquet regrown with three.js
instead of 3D CSS, plus a "meadow" stress mode CSS could never hold (thousands of
instanced, swaying flowers) and a live HUD (fps, 1% lows, draw calls, triangles) so the
two renderers can be compared honestly. The page copy IS the comparison; keep it honest
in both directions.

## File map

- `logic.js`: pure math, tested by `node --test tests/wildflowers-logic.test.mjs`.
  **Imports the flower DNA from `../flowers/logic.js`** (petal spec functions,
  `bouquetSeats`, `seatPoint`, `STEM_BIND`, `HEAD_RADII`, `tierPetals`,
  `surpriseCounts`): do not fork those numbers, the whole point is that a rose opens to
  the same angles in both renderers. Adds what a mesh renderer needs: `PETAL_SHAPES` +
  `petalPoint`/`petalGeometryData` (parametric petal sheets), the `SPECIES` registry
  (same colorway hexes as flowers/style.css), `bouquetPlan`, `stemPlan` (the same stem
  Bezier, sampled as points for a tube), `wrapPoint` (the scalloped cone as one round
  surface), `meadowField`/`grassField` (deterministic golden-angle scatter), `fpsStats`,
  `PRESETS`.
- `petals-gl.js`: turns logic into GPU work. Browser-only (three.js + canvas textures).
- `script.js`: page wiring only (mode tabs, sliders, toggles, orbit drag, HUD, rAF loop).
- `style.css`: stage atmosphere, sliders, boot/fallback states. Everything else is
  Tailwind in index.html. There are no flower skins here; color lives in vertex colors.

## The rendering contract (petals-gl.js)

- three.js is pinned via an import map in index.html
  (`three@0.166.1/build/three.module.min.js` on jsdelivr). If you bump the version,
  re-check the shader graft below against the renamed chunks before anything else.
- **Everything repeated is an InstancedMesh** accumulated through the `Buckets` class,
  keyed per (part, colorway): one draw call per bucket whether it holds 12 instances or
  60,000. All instanced meshes set `frustumCulled = false` (the geometry's local bounds
  lie about where instances are; culling by them blanks the scene at some camera angles).
- **A petal's instance matrix places it CLOSED.** Opening lives in per-instance
  attributes + shared uniforms, applied by `graft()`, which rewrites the built-in
  materials' vertex shaders:
  - `aOpen` (radians) x `uBloom` rotates the petal at its hinge in `begin_vertex` /
    `beginnormal_vertex` (petal geometry: hinge at origin, grows +y, sky face +z,
    positive x-rotation opens it). The bloom slider is ONE uniform write per frame.
  - `aWind` = (phase, baseY, height) per instance; `project_vertex` is replaced to shear
    positions after the instance transform: stalks bend by height squared, heads ride
    their stalk tips (same phase + height as their stalk, that is what keeps them
    attached), petals get a tiny flutter on top of `aOpen`.
  - The same graft goes on each bucket's `customDepthMaterial`
    (`MeshDepthMaterial` has no `beginnormal_vertex`, hence the branch in `graft`),
    so shadows bloom and sway too. Non-instanced but grafted meshes (the merged stem
    tube) carry `aOpen`/`aWind` as regular per-vertex attributes; the same GLSL reads both.
- CSS-frame numbers (seats, stems, wrap heights) cross into world space as
  `worldY = CSS_GROUND_Y - cssY` (ground at 0, wrap rim ~168, heads ~250).
- Twist compromise: CSS applies twist innermost (before the open rotation); here the
  open rotation is innermost (it must live in the shader), so twist rides in the
  instance matrix. Visually indistinguishable at the twists the specs use (<=12deg).
- Rebuilds (`rebuild()` in script.js) dispose the whole previous group
  (`disposeGroup`); base geometries are shared between buckets via `shareGeometry`,
  and double-disposal is safe (three re-uploads shared attributes on demand).
- Vertex colors are authored as the sRGB hexes from flowers/style.css and converted to
  linear working space (`linearColors`); textures (sunflower seed disc, ground glow) are
  procedural canvases with `colorSpace = SRGBColorSpace`. No image files.

## Performance defaults

- Bouquet petals sample at 8x11 segments, meadow at 4x6 (`Buckets(lod)`), and meadow
  heads use the flowers 'lite' tier petal counts.
- Pixel ratio caps at 2 (1.75 coarse), and 1.5 when the meadow holds >=2200 stems.
- Shadows default off on coarse pointers; the toggle is deliberately NOT auto-managed
  beyond that, feeling the cost is the point of the page.
- The rAF loop early-returns (no render) when the stage is scrolled out of view
  (IntersectionObserver) or the tab is hidden.

## Gotchas

- The boot watchdog: an inline script in index.html shows `#gl-fallback` if
  `window.__wf_boot` is not set within 8s (no import map support, blocked CDN);
  script.js sets it right after the WebGLRenderer constructor succeeds and also folds to
  the fallback if that constructor throws. Keep both paths when refactoring boot.
- Touch drags orbit yaw only and the stage is `touch-action: pan-y`, so phones can
  still scroll past the full-height hero.
- `window.__wf` exposes renderer/scene/camera/uniforms for headless verification.
- This view is intentionally NOT in components/project-data.js, the sitemap, or
  views/seo/checklist.json yet (built as an experiment; register it via the root
  CLAUDE.md's "Adding a New Project" checklist when it should go public on the
  homepage).

## Verifying

Use the repo `verify` skill. WebGL renders under headless Chrome's SwiftShader; pass
`--enable-unsafe-swiftshader` if the build refuses a software GL context. Freeze motion
for deterministic shots: `__wf.uniforms.uTime.value = <t>` after setting
`uniforms.uWind.value = 0`, stop the spin via the still button (`#spin-toggle`), and
pin bloom by writing `__wf.uniforms.uBloom.value` (the initial regrow overwrites it for
the first ~2.4s, same trap as the paper page). Rendering continues only while the stage
is on screen, so screenshot before scrolling scripts move it off.
