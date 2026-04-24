export function wilsons(grid, prng) {
  grid.reset();
  // Mark a random cell as in the maze
  grid.cells[prng.int(grid.cells.length)].visited = true;
  let remaining = grid.cells.filter(c => !c.visited);

  while (remaining.length) {
    // Start a random walk from an unvisited cell
    let current = remaining[prng.int(remaining.length)];
    const path = [current];
    const pathIndex = new Map([[current.id, 0]]);

    while (!current.visited) {
      const nbrs = grid.neighbors(current);
      const { cell: next, dir } = nbrs[prng.int(nbrs.length)];
      if (pathIndex.has(next.id)) {
        // Loop erase
        const loopStart = pathIndex.get(next.id);
        path.splice(loopStart + 1);
        path.forEach((c, i) => pathIndex.set(c.id, i));
      } else {
        path.push(next);
        pathIndex.set(next.id, path.length - 1);
      }
      current = next;
    }

    // Carve path into maze
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      const edge = grid.neighbors(a).find(n => n.cell.id === b.id);
      grid.carve(a, b, edge.dir);
      a.visited = true;
    }
    remaining = grid.cells.filter(c => !c.visited);
  }
  return grid;
}
