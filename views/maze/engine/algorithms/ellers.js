// Only valid on square grids. Streams row-by-row: each cell starts in its own
// set; randomly merge horizontally-adjacent cells of different sets, then for
// each set drop at least one vertical connection into the next row. Last row
// merges all remaining differing sets to guarantee connectivity.
export function ellers(grid, prng) {
  grid.reset();
  const { cols, rows } = grid;

  let setOf  = new Array(cols);  // setOf[col] = set id of cell at this column in current row
  let nextId = 0;
  for (let c = 0; c < cols; c++) setOf[c] = nextId++;

  for (let r = 0; r < rows; r++) {
    const lastRow = r === rows - 1;

    // Horizontal merge pass
    for (let c = 0; c < cols - 1; c++) {
      const a = grid.cells[grid.index(c, r)];
      const b = grid.cells[grid.index(c + 1, r)];
      const sameSet  = setOf[c] === setOf[c + 1];
      const shouldMerge = !sameSet && (lastRow || prng.next() < 0.5);
      if (shouldMerge) {
        grid.carve(a, b, 'E');
        const oldId = setOf[c + 1];
        for (let k = 0; k < cols; k++) if (setOf[k] === oldId) setOf[k] = setOf[c];
      }
    }

    if (lastRow) break;

    // Vertical pass: group columns by set id, carve at least one south connection per set
    const groups = new Map();
    for (let c = 0; c < cols; c++) {
      if (!groups.has(setOf[c])) groups.set(setOf[c], []);
      groups.get(setOf[c]).push(c);
    }

    const nextSetOf = new Array(cols).fill(-1);
    for (const [, members] of groups) {
      const shuffled = prng.shuffle(members.slice());
      const minDrops = 1;
      const extraDrops = members.length > 1 ? prng.int(members.length) : 0;
      const dropCount = Math.max(minDrops, extraDrops);
      const drops = shuffled.slice(0, dropCount);
      for (const c of drops) {
        const a = grid.cells[grid.index(c, r)];
        const b = grid.cells[grid.index(c, r + 1)];
        grid.carve(a, b, 'S');
        nextSetOf[c] = setOf[c];
      }
    }

    // Cells without a south connection start a fresh set in the next row
    for (let c = 0; c < cols; c++) {
      if (nextSetOf[c] === -1) nextSetOf[c] = nextId++;
    }
    setOf = nextSetOf;
  }

  return grid;
}
