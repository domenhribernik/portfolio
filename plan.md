# Plan: Dynamic Maze Generator — remaining work

The v1 scope is shipped: 4 grid topologies (square/hex/triangle/polar), 7 algorithms (DFS, Prim's, Kruskal's, Wilson's, Sidewinder, Binary Tree, Recursive Division), BFS-based scoring with breakdown bars, seeded PRNG, entrance/exit placement (corners / farthest / random), light/dark theme, A4/Letter print + solution page, and project registration.

Below is what's still open, ordered roughly by value-to-effort.

## Algorithms (nice-to-haves)

- **Aldous-Broder** — same distribution as Wilson's, simpler implementation, slower runtime. Good for completeness.
- **Hunt-and-Kill** — DFS-like with scan restarts. Distinct texture from existing algorithms.
- **Eller's** — row-by-row, streams memory. Rectangular-only; mark `rectOnly: true` in the registry.

## Grids (stretch)

- **Upsilon** (octagon + square fillers) — visually distinctive, code-heavier than the existing four. Skip unless time allows.

## Scoring

- **Bias penalty metric** — sample path segments, measure directional uniformity, penalize highly biased mazes (Binary Tree, Sidewinder). Currently the score doesn't reflect that those algorithms produce easier mazes than the others.
- **Radar chart** for the breakdown — currently shown as five horizontal bars. Radar would be more readable at a glance but is more code; bars are functional.

## UI / configuration

- **User-clicked entrance/exit placement** — fourth option alongside corners / farthest / random. Click to place start, click again to place end.
- **Cell size + wall thickness controls** — currently hardcoded (cellSize 20, wallWidth 1.5). Expose as sliders, especially useful for print sizing.
- **Coordinates / debug overlay** — show row/col labels per cell. Low priority; useful for screenshot/debug only.
- **Custom paper size** — A4/Letter only today. Custom width × height in mm would let the user target any page.

## Print / export

- **Multi-page tiling for very large mazes** — currently the SVG just scales down to fit the page. At 80×80+ on A4, cells become uncomfortably small for hand-solving. Tile across multiple pages with overlap marks as an alternative.
- **Header and footer text** currently there is header and footer text, which should be able to be turned off if the user wants

## Misc cleanups

- Update the maze entry's `description` in [components/project-data.js](components/project-data.js) — currently says "square and hexagonal grids" but triangle and polar are also shipped.
