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

export function score(grid, startId, endId) {
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

  // 2. Decision density on the path. (degree - 2) counts actual side branches
  //    at each step: corridor=0, T-junction=1, 4-way=2. Capped at 2 per cell.
  let decisionSum = 0;
  for (const id of path) decisionSum += Math.max(0, Math.min(2, openCounts[id] - 2));
  const decisionDensity = Math.min(decisionSum / Math.max(path.length, 1) / 2, 1);

  // 3. Dead-end density across the whole maze.
  let deadEnds = 0;
  for (let i = 0; i < total; i++) if (openCounts[i] === 1) deadEnds++;
  const deadEndRatio = deadEnds / total;

  // 4. Junction density (degree >= 3). Replaces the old branchNorm — for any
  //    spanning tree mean-openings is ~2, so the old metric was nearly
  //    constant and didn't differentiate algorithms.
  let junctions = 0;
  for (let i = 0; i < total; i++) if (openCounts[i] >= 3) junctions++;
  const junctionRatio = junctions / total;

  // 5. Mean depth of off-path dead-end traps, normalized to maze diameter
  //    scale. Using sqrt(total) instead of a fixed /10 makes traps in a 80×80
  //    maze comparable to traps in a 20×20 — depth 8 is shallow in the big
  //    one, deep in the small.
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
  const trapNorm = Math.min(meanTrap / Math.sqrt(Math.max(total, 1)), 1);

  // 6. Size factor. A bigger maze is intrinsically harder to solve regardless
  //    of structure — more cells to track, longer to scan. sqrt curve so
  //    perceived difficulty grows with linear maze dimension, not area.
  //    Calibrated so an 80×80-equivalent maze (6400 cells) saturates at 1.0.
  const sizeNorm = Math.min(Math.sqrt(total) / 80, 1);

  const raw = (
    pathNorm         * 0.15 +
    decisionDensity  * 0.30 +
    deadEndRatio     * 0.08 +
    junctionRatio    * 0.08 +
    trapNorm         * 0.12 +
    sizeNorm         * 0.27
  );

  const s     = Math.round(raw * 100);
  const label = s < 20 ? 'Trivial' : s < 40 ? 'Easy' : s < 60 ? 'Medium' : s < 80 ? 'Hard' : 'Brutal';

  return {
    score: s, label, path,
    breakdown: { pathNorm, decisionDensity, deadEndRatio, junctionRatio, trapNorm, sizeNorm },
  };
}
