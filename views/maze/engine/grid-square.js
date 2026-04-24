// Orthogonal (square) grid
// Each cell: { id, row, col, walls: {N,S,E,W}, visited }
export function createSquareGrid(cols, rows) {
  const cells = [];
  const index = (c, r) => r * cols + c;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({ id: index(c, r), row: r, col: c, walls: { N: true, S: true, E: true, W: true }, visited: false });
    }
  }

  function neighbors(cell) {
    const { row: r, col: c } = cell;
    const result = [];
    if (r > 0)        result.push({ cell: cells[index(c, r - 1)], dir: 'N', opp: 'S' });
    if (r < rows - 1) result.push({ cell: cells[index(c, r + 1)], dir: 'S', opp: 'N' });
    if (c < cols - 1) result.push({ cell: cells[index(c + 1, r)], dir: 'E', opp: 'W' });
    if (c > 0)        result.push({ cell: cells[index(c - 1, r)], dir: 'W', opp: 'E' });
    return result;
  }

  function carve(a, b, dir) {
    a.walls[dir] = false;
    const opp = { N: 'S', S: 'N', E: 'W', W: 'E' }[dir];
    b.walls[opp] = false;
  }

  function reset() {
    cells.forEach(c => { c.walls = { N: true, S: true, E: true, W: true }; c.visited = false; });
  }

  return { cells, cols, rows, type: 'square', neighbors, carve, index, reset };
}
