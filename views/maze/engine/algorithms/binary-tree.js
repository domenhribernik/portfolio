// Only valid on square grids
export function binaryTree(grid, prng) {
  grid.reset();
  const { cols, rows } = grid;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = grid.cells[grid.index(c, r)];
      const canN = r > 0;
      const canE = c < cols - 1;
      if (canN && canE) {
        if (prng.next() < 0.5) grid.carve(cell, grid.cells[grid.index(c, r - 1)], 'N');
        else                   grid.carve(cell, grid.cells[grid.index(c + 1, r)], 'E');
      } else if (canN) {
        grid.carve(cell, grid.cells[grid.index(c, r - 1)], 'N');
      } else if (canE) {
        grid.carve(cell, grid.cells[grid.index(c + 1, r)], 'E');
      }
    }
  }
  return grid;
}
