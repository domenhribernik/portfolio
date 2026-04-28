// DFS-like walk; when stuck, "hunt" linearly for the first unvisited cell
// that has at least one visited neighbor and resume from there. Produces
// long winding corridors with a noticeably different texture from DFS.
export function huntAndKill(grid, prng) {
  grid.reset();
  let current = grid.cells[prng.int(grid.cells.length)];
  current.visited = true;

  while (current) {
    const unvisited = grid.neighbors(current).filter(n => !n.cell.visited);
    if (unvisited.length) {
      const { cell: next, dir } = unvisited[prng.int(unvisited.length)];
      grid.carve(current, next, dir);
      next.visited = true;
      current = next;
      continue;
    }

    // Hunt: first unvisited cell with a visited neighbor.
    current = null;
    for (const cell of grid.cells) {
      if (cell.visited) continue;
      const visitedNbrs = grid.neighbors(cell).filter(n => n.cell.visited);
      if (visitedNbrs.length) {
        const { cell: from, dir, opp } = visitedNbrs[prng.int(visitedNbrs.length)];
        grid.carve(from, cell, opp);
        cell.visited = true;
        current = cell;
        break;
      }
    }
  }
  return grid;
}
