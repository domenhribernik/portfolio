# Maze project notes

Pure-frontend maze generator. Vanilla JS ES modules, no build, SVG output.

## File map

```
views/maze/
  index.html      — controls (sliders, selects, theme toggle, print)
  style.css       — sliders, light theme, breakdown bars, print styles
  script.js       — UI wiring; orchestrates generate → score → render
  engine/
    prng.js               — seedable PRNG (Mulberry32 + xmur3 string hash)
    grid-square.js        — orthogonal grid
    grid-hex.js           — hex grid
    grid-triangle.js      — delta (alternating ▲/▽) grid
    grid-polar.js         — theta (concentric rings) grid
    difficulty.js         — BFS solver, score(), bfsAll() for farthest entrance/exit
    render-svg.js         — dispatch renderer; one render fn per grid type
    algorithms/
      dfs.js, prims.js, kruskals.js, wilsons.js
      sidewinder.js, binary-tree.js, recursive-division.js   ← rectOnly (square only)
```

## Grid contract — every grid module exports `create<Type>Grid(...)` returning:

```
{ cells, cols, rows, type, neighbors(cell), carve(a, b, dir), reset() }
```

- `cells[i] = { id, row/col (or ring/col for polar), walls: {dir: bool}, visited }`
- `neighbors(cell)` returns `[{ cell, dir, opp }, ...]`. The `opp` field is **required** by the BFS solver's polar fallback — don't drop it.
- `carve(a, b, dir)` opens the wall between `a` and `b`. Uses `dir` (the direction from `a` to `b`) plus an internal opposite map.

## Direction conventions per grid

| Grid     | Walls on each cell                     | Notes |
|----------|-----------------------------------------|-------|
| square   | `{N, S, E, W}`                          | Symmetric. |
| hex      | flat-top axial; opposites paired        | |
| triangle | `up=(col+row)%2===0` → ▲ has `{W,E,S}`, ▽ has `{W,E,N}` | Neighbor only along shared edge. |
| polar    | `{CW, CCW, IN}` (no `OUT` on inner)     | See gotcha below. |

## Critical polar-grid gotcha

Inner polar cells have **no `walls.OUT` property**. Multiple outer cells can share one inner neighbor, so passage state lives only on the outer cell's `walls.IN`.

Consequences:
- `carve(a, b, 'OUT')` sets `b.walls.IN = false` (not `a.walls.OUT`).
- `carve(a, b, 'IN')` sets `a.walls.IN = false`.
- Naïve BFS check `cell.walls[dir] === false` is wrong for OUT (undefined is truthy in `!cell.walls[dir]`). Use the `passageOpen` helper in `difficulty.js`:
  ```js
  cell.walls[dir] === false || nb.walls[opp] === false
  ```
  This works for all grid types and is the reason `neighbors()` returns `opp`.

## Algorithm compatibility

`script.js` has an `ALGORITHMS` registry with `rectOnly: true|false`. Sidewinder, Binary Tree, and Recursive Division assume square grids and are auto-disabled when grid type ≠ square. New row-or-column-based algorithms should set `rectOnly: true`.

## Difficulty scoring

`score(grid, startId, endId)` runs BFS, then weights six normalized metrics into a 0–100 score:

| Metric          | Weight | What it measures |
|-----------------|--------|------------------|
| pathNorm        | 0.15   | absolute solution path length / 300 (capped) — scales with grid size *and* entrance-exit placement |
| decisionDensity | 0.30   | mean side-branches per path cell `(degree-2)`, capped at 2/cell, normalized to /2 |
| deadEndRatio    | 0.08   | dead ends / total cells |
| junctionRatio   | 0.08   | cells with degree ≥3 / total cells |
| trapNorm        | 0.12   | mean off-path dead-end depth / √total (size-aware) |
| sizeNorm        | 0.27   | √total / 80 (capped) — bigger grid = harder by default |

Labels: <20 Trivial, <40 Easy, <60 Medium, <80 Hard, else Brutal. Returned `breakdown` keys feed the UI breakdown bars.

`openCounts` is precomputed once per `score()` call as an `Int8Array` — don't re-scan walls per metric.

### Why these metrics, and what changed

- `branchNorm` (mean openings ÷ 4) was removed: for any spanning tree mean openings is ~2(n-1)/n ≈ 2, so this metric was nearly constant across all algorithms — it didn't differentiate Prim's from DFS. Replaced with `junctionRatio`, which actually measures how branchy the topology is.
- `decisionRatio` was a binary "≥3 openings" flag; replaced with `decisionDensity` so a 4-way crossing weighs more than a T-junction.
- `solutionRatio` (path / total) cancelled size out — a 50-cell path in 100 cells read the same as a 200-cell path in 400. Replaced with `pathNorm` (absolute length / 300) so longer absolute paths score higher. This also makes "farthest pair" placement read as harder than "random", which it genuinely is for the solver.
- `trapNorm` previously divided by a fixed 10, so traps in a 5×5 maze and a 80×80 maze were normalized against the same yardstick. Now divided by √total so trap depth is read relative to maze diameter.
- `sizeNorm` is new and weighted heavily (0.27): a 60×60 DFS maze is intrinsically more taxing than a 5×5 of the same algorithm even when the structural metrics are identical. Without this, small mazes could trivially score "Brutal" with a tortuous solution.

## Entrance/exit placement

`script.js > computeEntranceExit(grid, placement, prng)` dispatches:
- `default` — top-left / bottom-right (or ring 0 / outermost ring for polar)
- `farthest` — `bfsAll` from a random start, then BFS again from the farthest cell to get the diameter pair
- `random` — two random boundary cells

`getBoundaryOpenDir(grid, cell)` opens the outer wall of an entrance/exit cell so the maze is enterable; it throws on unknown grid types — add a case when introducing a new grid.

**Don't hardcode `openDir` strings per grid type in the placement helpers** (e.g. `'N'` for square, `'SE'` for hex). The hex grid has no `'N'` direction at all (only NE/E/SE/SW/W/NW), and `dirEdge[dir]` returns `undefined` in the renderer's `openWallHex`, which crashes the whole render via destructuring. Always route through `getBoundaryOpenDir` so the direction names match the grid's wall vocabulary.

### Hex renderer dirEdge mapping

The pointy-top hex's corners are generated at angles `60*i - 30` (i = 0..5), so corner 0 is upper-right and corner 5 is top. The `dirEdge` map in `renderHex` must therefore be:

```js
const dirEdge = { NE: [5,0], E: [0,1], SE: [1,2], SW: [2,3], W: [3,4], NW: [4,5] };
```

Walking these clockwise from the top vertex: NE = top→upper-right, E = upper-right→lower-right, etc. An off-by-one (every direction shifted to the next clockwise edge) is the kind of mistake that visually "almost works" — passages appear on the wrong sides without breaking the graph. If hex looks rotated or has walls in the wrong places, suspect this map.

## Wilson's algorithm — why the pool is non-obvious

`grid.cells.filter(c => !c.visited)` per iteration is O(n) and dominates runtime. Current implementation maintains:
- `pool` — array of unvisited cells (random pick = `pool[prng.int(pool.length)]`)
- `poolIdx` — `Map<cellId, index>` for O(1) removal via swap-and-pop

Path entries are `{ cell, dir }` where `dir` is the direction taken from the previous entry to this cell, so the carve loop doesn't need a second `neighbors()` call. Loop-erase: `path.splice(loopStart+1)` plus targeted `pathIndex.delete` for the removed entries.

## Render

`render-svg.js > renderMaze(opts)` is the dispatcher. It builds `pathSet = new Set(solutionPath)` once and passes it into the per-type renderer (`renderSquare`, `renderHex`, `renderTriangle`, `renderPolar`). Solution-page SVG is only built when `solutionPageToggle.checked` — don't unconditionally render it.

`bgRect(W, H)` is a shared helper for the background — every renderer uses it.

## UI invariants

- Dimension inputs are `<input type="range">` sliders. Their min/max and the labels (`Cols/Rows` vs `Divisions/Rings`) are swapped by `updateDimensions()` based on grid type — polar uses tighter ranges.
- Breakdown bar elements are cached at module load: `breakdownBars = BREAKDOWN_KEYS.map(k => document.getElementById(k.id))`. Keep the ID list and HTML in sync.
- The PRNG is local to `generate()` (`const prng = new PRNG(seed)`) — don't reintroduce a module-level `currentPrng`.

## Testing locally

No automated tests in this repo. To smoke-test logic outside the browser, copy the engine files to a directory with `package.json` containing `"type": "module"` and import — Node 18+ won't run loose `.js` ESM without it.
