// Random walk: at each step pick a random neighbor; carve only when first
// visiting it. Produces a uniform spanning tree (same distribution as Wilson's),
// but generally slower because the walk revisits visited cells freely.
export function aldousBroder(grid, prng) {
  grid.reset();
  let current = grid.cells[prng.int(grid.cells.length)];
  current.visited = true;
  let remaining = grid.cells.length - 1;

  while (remaining > 0) {
    const nbrs = grid.neighbors(current);
    const { cell: next, dir } = nbrs[prng.int(nbrs.length)];
    if (!next.visited) {
      grid.carve(current, next, dir);
      next.visited = true;
      remaining--;
    }
    current = next;
  }
  return grid;
}
