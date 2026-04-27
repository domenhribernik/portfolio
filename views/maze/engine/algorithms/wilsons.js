export function wilsons(grid, prng) {
  grid.reset();
  grid.cells[prng.int(grid.cells.length)].visited = true;

  // O(1) random-pick + O(1) removal via swap-and-pop
  const pool    = grid.cells.filter(c => !c.visited);
  const poolIdx = new Map(pool.map((c, i) => [c.id, i]));

  function removeFromPool(id) {
    const i = poolIdx.get(id);
    if (i === undefined) return;
    const last = pool[pool.length - 1];
    pool[i] = last;
    poolIdx.set(last.id, i);
    pool.pop();
    poolIdx.delete(id);
  }

  while (pool.length) {
    let current = pool[prng.int(pool.length)];
    // path[i].dir = direction taken FROM path[i-1] TO this cell (null for first)
    const path      = [{ cell: current, dir: null }];
    const pathIndex = new Map([[current.id, 0]]);

    while (!current.visited) {
      const nbrs = grid.neighbors(current);
      const { cell: next, dir } = nbrs[prng.int(nbrs.length)];

      if (pathIndex.has(next.id)) {
        const removed = path.splice(pathIndex.get(next.id) + 1);
        removed.forEach(e => pathIndex.delete(e.cell.id));
      } else {
        path.push({ cell: next, dir });
        pathIndex.set(next.id, path.length - 1);
      }
      current = next;
    }

    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i].cell, { cell: b, dir } = path[i + 1];
      grid.carve(a, b, dir);
      a.visited = true;
      removeFromPool(a.id);
    }
  }
  return grid;
}
