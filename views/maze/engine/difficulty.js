// BFS solver + difficulty scoring
//
// Passage-open check: cell.walls[dir] === false handles square/hex/triangle.
// For polar's OUT direction, inner cells have no walls.OUT — we fall back to
// checking nb.walls[opp] === false (outer cell's IN wall).
function passageOpen(cell, nb, dir, opp) {
  return cell.walls[dir] === false || nb.walls[opp] === false;
}

export function bfsAll(grid, startId) {
  const dist = new Map([[startId, 0]]);
  const queue = [startId];
  let farthestId = startId, maxDist = 0;

  while (queue.length) {
    const id   = queue.shift();
    const cell = grid.cells[id];
    for (const { cell: nb, dir, opp } of grid.neighbors(cell)) {
      if (passageOpen(cell, nb, dir, opp) && !dist.has(nb.id)) {
        const d = dist.get(id) + 1;
        dist.set(nb.id, d);
        if (d > maxDist) { maxDist = d; farthestId = nb.id; }
        queue.push(nb.id);
      }
    }
  }
  return { dist, farthestId };
}

export function solve(grid, startId, endId) {
  const dist = new Map([[startId, 0]]);
  const prev = new Map();
  const queue = [startId];

  while (queue.length) {
    const id   = queue.shift();
    const cell = grid.cells[id];
    for (const { cell: nb, dir, opp } of grid.neighbors(cell)) {
      if (passageOpen(cell, nb, dir, opp) && !dist.has(nb.id)) {
        dist.set(nb.id, dist.get(id) + 1);
        prev.set(nb.id, id);
        queue.push(nb.id);
      }
    }
  }

  if (!dist.has(endId)) return null;

  const path = [];
  let cur = endId;
  while (cur !== undefined) { path.unshift(cur); cur = prev.get(cur); }
  return { path, dist };
}

export function score(grid, startId, endId, opts = {}) {
  const result = solve(grid, startId, endId);
  if (!result) return { score: 0, label: 'Unsolvable', path: [], breakdown: {} };

  const { path } = result;
  const total   = grid.cells.length;
  const pathSet = new Set(path);

  // Pre-compute open-passage count per cell once to avoid repeated Object.values allocations
  const openCounts = new Int8Array(total);
  for (let i = 0; i < total; i++) {
    openCounts[i] = Object.values(grid.cells[i].walls).filter(w => !w).length;
  }

  // 1. Absolute solution path length, normalized to a "long maze" reference of
  //    300 cells. Using absolute (not ratio-to-total) length so this metric
  //    grows with both grid dimensions AND entrance-exit placement —
  //    "farthest pair" produces a much longer path than "random" or "corners",
  //    and that genuinely makes the maze harder to walk.
  const pathNorm = Math.min(path.length / 300, 1);

  // Path length is the lens through which the structural metrics are read —
  // a solver only experiences the maze through the cells they traverse.
  // pathFactor damps decisions / dead-ends / traps when the path is too
  // short to contain meaningful difficulty: a 5-cell solution shouldn't max
  // any structural bar regardless of how branchy the surrounding maze is.
  const pathFactor = Math.min(path.length / 30, 1);

  // 2. Decision density on the path. (degree - 2) counts actual side branches
  //    at each step: corridor=0, T-junction=1, 4-way=2. Capped at 2 per cell.
  //    /0.7 calibrates against the observed max for branchy spanning trees.
  //    Multiplied by pathFactor so a tiny tortuous path doesn't max the bar.
  let decisionSum = 0;
  for (const id of path) decisionSum += Math.max(0, Math.min(2, openCounts[id] - 2));
  const decisionDensity =
    Math.min(decisionSum / Math.max(path.length, 1) / 0.7, 1) * pathFactor;

  // 3. Off-path dead ends, normalized by path length. This is the density of
  //    dead-end branches a solver actually encounters while walking the path,
  //    not maze-wide noise. /2 calibrates against branchy mazes: ~2 off-path
  //    dead ends per path cell maps to a full bar.
  //    Computed inside the trap loop below to avoid two passes.

  // 4. Mean trap depth (off-path dead-end chain length). /6 calibrates to
  //    typical DFS trap depths; Prim's-style averages 1-3 and stays low.
  //    pathFactor damping ensures short paths can't earn a tall trap bar.
  let trapTotal = 0, trapCount = 0;
  grid.cells.forEach(cell => {
    if (!pathSet.has(cell.id) && openCounts[cell.id] === 1) {
      let depth = 0, cur = cell.id;
      const seen = new Set([cur]);
      while (!pathSet.has(cur)) {
        const next = grid.neighbors(grid.cells[cur])
          .find(n => passageOpen(grid.cells[cur], n.cell, n.dir, n.opp) && !seen.has(n.cell.id));
        if (!next) break;
        seen.add(next.cell.id);
        cur = next.cell.id;
        depth++;
      }
      trapTotal += depth;
      trapCount++;
    }
  });
  const meanTrap = trapCount ? trapTotal / trapCount : 0;
  const trapNorm = Math.min(meanTrap / 6, 1) * pathFactor;
  // pathFactor damping: a 2-cell path (e.g. adjacent start/end) divides
  // trapCount by ~nothing and the bar would saturate even though the solver
  // never walks past any dead end. Same reasoning as decisionDensity / trapNorm.
  const deadEndNorm = Math.min(trapCount / Math.max(path.length, 1) / 2, 1) * pathFactor;

  // 6. Size factor. A bigger maze is intrinsically harder to solve regardless
  //    of structure. Normalised against the true maximum cell count for this
  //    grid type (passed in via opts.sizeRef) so every grid type saturates at
  //    1.0 at its own slider maximum — a hex grid caps at 40×40, not 80×80.
  const sizeRef = opts.sizeRef ?? 80;
  const sizeNorm = Math.min(Math.sqrt(total) / sizeRef, 1);

  const raw = (
    pathNorm         * 0.15 +
    decisionDensity  * 0.32 +
    deadEndNorm      * 0.10 +
    trapNorm         * 0.16 +
    sizeNorm         * 0.27
  );

  const s     = Math.round(raw * 100);
  const label = s < 20 ? 'Trivial' : s < 40 ? 'Easy' : s < 60 ? 'Medium' : s < 80 ? 'Hard' : 'Brutal';

  return {
    score: s, label, path,
    breakdown: { pathNorm, decisionDensity, deadEndNorm, trapNorm, sizeNorm },
  };
}
