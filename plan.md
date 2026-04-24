Plan: Dynamic Maze Generator
Goal
A pure-client project at views/maze/ that generates mazes on multiple grid topologies using multiple algorithms, scores the resulting difficulty, and exports cleanly to paper via a dedicated print stylesheet. No backend needed — fits the same no-DB pattern as rocks, spy, tarok.

Rendering choice: SVG
Canvas is nice for speed but a nightmare to print sharply at any paper size. SVG is:

vector → perfect print at A4/Letter/any zoom,
trivially stylable by @media print (stroke widths, background removal),
easy to serialize straight into a PDF via the browser's native "Save as PDF" on the print dialog (no jsPDF dependency unless we later want a "Download PDF" button without the print dialog).
Recommendation: ship with the browser print path first (File → Save as PDF from the print dialog). Add jsPDF + svg2pdf.js later only if we want a one-click download button.

Grid topologies (the "shape" side)
Each grid is just: a cell list + a neighbors map + an SVG renderer. A shared Grid interface means algorithms don't care which shape they're walking.

Orthogonal (square) — 4 neighbors, the baseline.
Sigma (hex) — 6 neighbors, offset rows. Looks great, feels very different to solve.
Delta (triangle) — 3 neighbors, alternating up/down triangles. Sparse branching = can feel harder despite fewer options.
Theta (polar / circular) — concentric rings with variable subdivisions per ring. Striking on paper, center is the natural start or end.
(Stretch) Upsilon (octagon+square) — octagons with square fillers. Visually wild, code-heavier.
Ship 1–4 in v1. 5 only if time allows.

Algorithms (the "hard" side)
Each implemented as generate(grid) → grid with carved passages, pluggable behind a dropdown.

Algorithm	Texture	Bias	Typical difficulty
Recursive Backtracker (DFS)	long, winding corridors; few dead ends	none	Hard — long solution paths, deep commits
Prim's (randomized)	short dead ends everywhere, "bushy"	none	Medium
Kruskal's (randomized)	uniform, many short branches	none	Medium
Wilson's	uniform spanning tree, unbiased	none	Medium-hard
Aldous-Broder	same distribution as Wilson's, slower	none	Medium-hard
Hunt-and-Kill	like DFS but with scan restarts	mild	Medium-hard
Eller's	row-by-row, streams memory	horizontal	Medium
Sidewinder	horizontal runs + single northward carves	strong horizontal	Easy
Binary Tree	always carves N or E	strong diagonal	Easiest
Recursive Division	room-and-wall, rectangular feel	none	Medium, distinctive look
Shipping all of these is cheap once the Grid interface is solid — most are 30–60 lines. v1 must-haves: DFS, Prim's, Kruskal's, Wilson's, Sidewinder, Binary Tree, Recursive Division. Others are nice-to-have.

Grid compatibility caveat: Sidewinder / Binary Tree / Eller's / Recursive Division are defined on rectangular grids. On hex/triangle/theta we grey those options out in the UI.

Difficulty scoring
Solve the maze with BFS from entrance to exit, then compute a composite score:

Solution length — cells on the shortest path ÷ total cells.
Decision points on solution path — number of cells with ≥3 open neighbors along the solution. The strongest single predictor of "feels hard."
Dead-end density — cells with exactly 1 open neighbor ÷ total cells.
Branching factor — average open-neighbor count across all cells.
"Trap depth" — for each wrong-turn branch off the solution path, how deep before it terminates; average + max. Long false leads = harder.
Bias penalty — sample path segments and measure directional uniformity; highly biased mazes (Binary Tree, Sidewinder) score down.
Each normalized to 0–1, weighted, combined into a single 0–100 difficulty score with labels (Trivial / Easy / Medium / Hard / Brutal). Also surfaced as a small radar/bar chart so the user sees why a maze is hard, not just a number.

Configurable parameters (UI)
Left-side config panel, live regen on change (or a "Generate" button for expensive settings):

Grid type: square / hex / triangle / polar
Dimensions: width × height (or rings × base-subdivisions for polar)
Algorithm: dropdown (incompatible ones disabled per grid)
Seed: text field + "randomize" button → reproducible mazes (xorshift PRNG so seeds are portable)
Entrance/exit placement: opposite corners / random / farthest-pair (BFS diameter) / user-clicked
Cell size (mm for print) + wall thickness
Solution overlay: off / dotted / solid (hidden in print by default)
Show coordinates / grid lines in solution mode (debug)
Paper: A4 / Letter / custom, portrait / landscape
Theme: light (print-friendly), dark (screen only)
Right side: big SVG maze, difficulty score widget underneath, print/download buttons.

Print / PDF
A dedicated @media print block in style.css:

Hides navbar, config panel, header, all UI chrome.
Forces white background, black walls, removes shadows/gradients.
Sizes the SVG to fill the page at the configured mm cell size, respecting margins.
@page { size: A4 portrait; margin: 10mm; } — dynamically swapped when user picks Letter/landscape (inject a <style> tag).
Page-break avoidance on the SVG wrapper.
Optional second page with the solution, toggled by a checkbox ("Include solution page").
A "Print / Save as PDF" button just calls window.print(). Browsers' native dialog offers Save as PDF on every major OS.

File structure

views/maze/
  index.html
  style.css           # screen + @media print rules
  script.js           # entry, wires UI to engine
  engine/
    grid-square.js
    grid-hex.js
    grid-triangle.js
    grid-polar.js
    algorithms/
      dfs.js
      prims.js
      kruskals.js
      wilsons.js
      sidewinder.js
      binary-tree.js
      recursive-division.js
      ...
    difficulty.js     # BFS solver + scoring
    prng.js           # seeded xorshift
    render-svg.js     # one renderer per grid type, dispatched
Each file is small and single-purpose. The grid interface is the contract; everything else plugs into it.

Integration with the portfolio
Add maze entry to components/project-data.js under Personal Projects, tech ["HTML","CSS","JavaScript","SVG","Algorithms"], icon e.g. fas fa-puzzle-piece, pick a fitting gradient.
Add a <project-card project="maze"> to index.html in the personal-projects .projects-grid.
Add views/maze to the project directory list in CLAUDE.md.
Move the Dynamic maze generator + print bullet from ideas.md "In Progress" to done when shipped.
Suggested build order
Square grid + DFS + SVG renderer + print stylesheet → prove the pipeline end-to-end.
BFS solver + difficulty scoring + solution overlay.
Add remaining algorithms on square grid (all cheap once step 1 works).
Hex grid + port compatible algorithms.
Triangle grid.
Polar grid.
Difficulty chart + seeded PRNG + polish + paper-size / orientation options.
Each step is independently shippable, so we can cut at any point if scope gets long.

Open questions for you
Solution page — default include it when printing, or always off unless the user ticks?
v1 grid scope — all four (square/hex/tri/polar), or start with square + hex and add the others later?
PDF approach — browser print → Save as PDF is free and zero-dependency; a jsPDF "Download PDF" button is ~50KB of JS and gives a one-click export. Start with print only?
Multi-page very large mazes — if someone picks 80×80, do we tile across multiple pages with overlap marks, or just scale the cells down to fit one page?
Give the green light (and any answers above) and I'll start with step 1.