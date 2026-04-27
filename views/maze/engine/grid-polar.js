// Theta (polar/circular) grid
// rings      = number of concentric rings (ring 0 = innermost)
// baseDivs   = number of cells in ring 0
//
// Ring r has ringCounts[r] cells. The count doubles when the
// circumference ratio to the previous ring reaches 2.
//
// Directions: CW (clockwise), CCW (counter-clockwise), IN (toward center),
//             OUT (away from center, returned as neighbor but no wall stored
//             on inner cell — passage state lives on outer cell's IN wall).
export function createPolarGrid(rings, baseDivs) {
  const ringCounts = [baseDivs];
  for (let r = 1; r < rings; r++) {
    const prev = ringCounts[r - 1];
    ringCounts.push(2 * Math.PI * r / prev >= 2 ? prev * 2 : prev);
  }

  const cells = [];
  const ringStart = [];

  for (let r = 0; r < rings; r++) {
    ringStart.push(cells.length);
    for (let c = 0; c < ringCounts[r]; c++) {
      const walls = { CW: true, CCW: true };
      if (r > 0) walls.IN = true;
      cells.push({ id: cells.length, ring: r, col: c, walls, visited: false });
    }
  }

  function neighbors(cell) {
    const { ring: r, col: c } = cell;
    const count = ringCounts[r];
    const result = [];

    result.push({ cell: cells[ringStart[r] + (c + 1) % count],           dir: 'CW',  opp: 'CCW' });
    result.push({ cell: cells[ringStart[r] + (c - 1 + count) % count],   dir: 'CCW', opp: 'CW'  });

    if (r > 0) {
      const innerCount = ringCounts[r - 1];
      const innerCol   = Math.floor(c / (count / innerCount));
      result.push({ cell: cells[ringStart[r - 1] + innerCol], dir: 'IN', opp: 'OUT' });
    }

    if (r < rings - 1) {
      const outerCount = ringCounts[r + 1];
      const ratio      = outerCount / count;
      for (let i = 0; i < ratio; i++) {
        result.push({ cell: cells[ringStart[r + 1] + c * ratio + i], dir: 'OUT', opp: 'IN' });
      }
    }

    return result;
  }

  function carve(a, b, dir) {
    if (dir === 'OUT') {
      b.walls.IN = false;
    } else if (dir === 'IN') {
      a.walls.IN = false;
    } else {
      const opp = { CW: 'CCW', CCW: 'CW' }[dir];
      a.walls[dir] = false;
      b.walls[opp] = false;
    }
  }

  function reset() {
    cells.forEach(cell => {
      cell.walls = { CW: true, CCW: true };
      if (cell.ring > 0) cell.walls.IN = true;
      cell.visited = false;
    });
  }

  return { cells, cols: baseDivs, rows: rings, ringCounts, ringStart, type: 'polar', neighbors, carve, reset };
}
