// BFS solver + difficulty scoring
export function solve(grid, startId, endId) {
  const dist = new Map();
  const prev = new Map();
  const queue = [startId];
  dist.set(startId, 0);

  while (queue.length) {
    const id = queue.shift();
    const cell = grid.cells[id];
    for (const { cell: nb, dir } of grid.neighbors(cell)) {
      if (!cell.walls[dir] && !dist.has(nb.id)) {
        dist.set(nb.id, dist.get(id) + 1);
        prev.set(nb.id, id);
        queue.push(nb.id);
      }
    }
  }

  if (!dist.has(endId)) return null; // unsolvable (shouldn't happen)

  const path = [];
  let cur = endId;
  while (cur !== undefined) { path.unshift(cur); cur = prev.get(cur); }
  return { path, dist };
}

export function score(grid, startId, endId) {
  const result = solve(grid, startId, endId);
  if (!result) return { score: 0, label: 'Unsolvable', breakdown: {} };

  const { path, dist } = result;
  const total = grid.cells.length;
  const pathSet = new Set(path);

  // 1. Solution ratio
  const solutionRatio = path.length / total;

  // 2. Decision points on path (cells with ≥3 open passages)
  const openCount = cell => Object.values(cell.walls).filter(w => !w).length;
  let decisionPoints = 0;
  path.forEach(id => { if (openCount(grid.cells[id]) >= 3) decisionPoints++; });
  const decisionRatio = decisionPoints / path.length;

  // 3. Dead-end density
  const deadEnds = grid.cells.filter(c => openCount(c) === 1).length;
  const deadEndRatio = deadEnds / total;

  // 4. Average branching factor
  const avgBranch = grid.cells.reduce((s, c) => s + openCount(c), 0) / total;
  const branchNorm = Math.min(avgBranch / 4, 1);

  // 5. Trap depth — average length of dead-end branches off solution path
  let trapTotal = 0, trapCount = 0;
  grid.cells.forEach(cell => {
    if (!pathSet.has(cell.id) && openCount(cell) === 1) {
      // BFS from this dead end back toward path
      let depth = 0, cur = cell.id;
      const seen = new Set([cur]);
      while (!pathSet.has(cur)) {
        const next = grid.neighbors(grid.cells[cur]).find(n => !grid.cells[cur].walls[n.dir] && !seen.has(n.cell.id));
        if (!next) break;
        seen.add(next.cell.id);
        cur = next.cell.id;
        depth++;
      }
      trapTotal += depth;
      trapCount++;
    }
  });
  const trapDepth = trapCount ? (trapTotal / trapCount) / 10 : 0;
  const trapNorm = Math.min(trapDepth, 1);

  const raw = (
    solutionRatio  * 0.20 +
    decisionRatio  * 0.35 +
    deadEndRatio   * 0.15 +
    branchNorm     * 0.10 +
    trapNorm       * 0.20
  );

  const s = Math.round(raw * 100);
  const label = s < 20 ? 'Trivial' : s < 40 ? 'Easy' : s < 60 ? 'Medium' : s < 80 ? 'Hard' : 'Brutal';

  return {
    score: s,
    label,
    path,
    breakdown: { solutionRatio, decisionRatio, deadEndRatio, branchNorm, trapNorm },
  };
}
