// Delta (triangle) grid
// up = (col + row) % 2 === 0 → ▲ (apex top), else ▽ (apex bottom)
// ▲ walls: W (left slant), E (right slant), S (base)
// ▽ walls: W (left slant), E (right slant), N (base)
// Neighbor map:
//   ▲ W → ▽(c-1,r)   ▲ E → ▽(c+1,r)   ▲ S → ▽(c,r+1)
//   ▽ W → ▲(c-1,r)   ▽ E → ▲(c+1,r)   ▽ N → ▲(c,r-1)
export function createTriangleGrid(cols, rows) {
  const cells = [];
  const index = (c, r) => r * cols + c;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const up = (c + r) % 2 === 0;
      const walls = up ? { W: true, E: true, S: true } : { W: true, E: true, N: true };
      cells.push({ id: index(c, r), row: r, col: c, up, walls, visited: false });
    }
  }

  function neighbors(cell) {
    const { row: r, col: c, up } = cell;
    const result = [];
    if (c > 0)        result.push({ cell: cells[index(c-1, r)], dir: 'W', opp: 'E' });
    if (c < cols - 1) result.push({ cell: cells[index(c+1, r)], dir: 'E', opp: 'W' });
    if (up  && r < rows - 1) result.push({ cell: cells[index(c, r+1)], dir: 'S', opp: 'N' });
    if (!up && r > 0)        result.push({ cell: cells[index(c, r-1)], dir: 'N', opp: 'S' });
    return result;
  }

  function carve(a, b, dir) {
    const opp = { W: 'E', E: 'W', S: 'N', N: 'S' }[dir];
    a.walls[dir] = false;
    b.walls[opp] = false;
  }

  function reset() {
    cells.forEach(cell => {
      const up = (cell.col + cell.row) % 2 === 0;
      cell.walls = up ? { W: true, E: true, S: true } : { W: true, E: true, N: true };
      cell.visited = false;
    });
  }

  return { cells, cols, rows, type: 'triangle', neighbors, carve, index, reset };
}
