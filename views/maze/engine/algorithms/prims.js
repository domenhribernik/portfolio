export function prims(grid, prng) {
  grid.reset();
  const start = grid.cells[prng.int(grid.cells.length)];
  start.visited = true;
  let frontier = grid.neighbors(start).map(n => ({ ...n, from: start }));

  while (frontier.length) {
    const idx = prng.int(frontier.length);
    const { cell, dir, from } = frontier[idx];
    frontier.splice(idx, 1);
    if (cell.visited) continue;
    grid.carve(from, cell, dir);
    cell.visited = true;
    grid.neighbors(cell).forEach(n => { if (!n.cell.visited) frontier.push({ ...n, from: cell }); });
  }
  return grid;
}
