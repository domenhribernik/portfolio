// Only valid on square grids
export function sidewinder(grid, prng) {
  grid.reset();
  const { cols, rows } = grid;
  for (let r = 0; r < rows; r++) {
    let run = [];
    for (let c = 0; c < cols; c++) {
      const cell = grid.cells[grid.index(c, r)];
      run.push(cell);
      const atEast = c === cols - 1;
      const atNorth = r === 0;
      const closeOut = atEast || (!atNorth && prng.next() < 0.5);
      if (closeOut) {
        if (!atNorth) {
          const member = run[prng.int(run.length)];
          const north = grid.cells[grid.index(member.col, member.row - 1)];
          grid.carve(member, north, 'N');
        }
        run = [];
      } else {
        const east = grid.cells[grid.index(c + 1, r)];
        grid.carve(cell, east, 'E');
      }
    }
  }
  return grid;
}
