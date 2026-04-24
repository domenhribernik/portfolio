export function dfs(grid, prng) {
  grid.reset();
  const start = grid.cells[0];
  start.visited = true;
  const stack = [start];

  while (stack.length) {
    const current = stack[stack.length - 1];
    const unvisited = grid.neighbors(current).filter(n => !n.cell.visited);
    if (unvisited.length === 0) { stack.pop(); continue; }
    const { cell: next, dir } = prng.shuffle(unvisited)[0];
    grid.carve(current, next, dir);
    next.visited = true;
    stack.push(next);
  }
  return grid;
}
