// Only valid on square grids — builds walls rather than carving passages
export function recursiveDivision(grid, prng) {
  grid.reset();
  // Start fully open
  grid.cells.forEach(c => { c.walls = { N: false, S: false, E: false, W: false }; });
  // Restore border walls
  grid.cells.forEach(c => {
    if (c.row === 0)              c.walls.N = true;
    if (c.row === grid.rows - 1)  c.walls.S = true;
    if (c.col === 0)              c.walls.W = true;
    if (c.col === grid.cols - 1)  c.walls.E = true;
  });

  function divide(c1, r1, c2, r2) {
    const w = c2 - c1 + 1, h = r2 - r1 + 1;
    if (w <= 1 || h <= 1) return;
    const horizontal = w < h ? true : w > h ? false : prng.next() < 0.5;

    if (horizontal) {
      // Draw horizontal wall between rows splitR and splitR+1, with one gap
      const splitR = r1 + prng.int(h - 1);
      const gapC   = c1 + prng.int(w);
      for (let c = c1; c <= c2; c++) {
        if (c !== gapC) {
          grid.cells[grid.index(c, splitR)].walls.S     = true;
          grid.cells[grid.index(c, splitR + 1)].walls.N = true;
        }
      }
      divide(c1, r1, c2, splitR);
      divide(c1, splitR + 1, c2, r2);
    } else {
      const splitC = c1 + prng.int(w - 1);
      const gapR   = r1 + prng.int(h);
      for (let r = r1; r <= r2; r++) {
        if (r !== gapR) {
          grid.cells[grid.index(splitC,     r)].walls.E = true;
          grid.cells[grid.index(splitC + 1, r)].walls.W = true;
        }
      }
      divide(c1, r1, splitC, r2);
      divide(splitC + 1, r1, c2, r2);
    }
  }

  divide(0, 0, grid.cols - 1, grid.rows - 1);
  return grid;
}
