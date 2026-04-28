// Upsilon grid: regular octagons on a square lattice with diamond (square
// rotated 45°) cells filling the gaps. Octagons have 8 walls (N/S/E/W +
// NE/NW/SE/SW), diamonds have 4 (NE/SE/SW/NW — vertices point cardinally).
//
// Cell layout in `cells`:
//   octagons first, row-major: id = oc + or*cols
//   diamonds after, row-major: id = cols*rows + dc + dr*(cols-1)
// Diamond (dc, dr) sits between octagons (dc, dr), (dc+1, dr), (dc, dr+1),
// (dc+1, dr+1).
const OPP = {
  N: 'S', S: 'N', E: 'W', W: 'E',
  NE: 'SW', SW: 'NE', NW: 'SE', SE: 'NW',
};
const OCT_WALLS = () => ({ N: true, S: true, E: true, W: true, NE: true, NW: true, SE: true, SW: true });
const DIA_WALLS = () => ({ NE: true, SE: true, SW: true, NW: true });

export function createUpsilonGrid(cols, rows) {
  const cells = [];
  const octId = (c, r) => r * cols + c;
  const dCols = cols - 1, dRows = rows - 1;
  const diaId = (c, r) => cols * rows + r * dCols + c;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({ id: octId(c, r), kind: 'octagon', col: c, row: r, walls: OCT_WALLS(), visited: false });
    }
  }
  for (let r = 0; r < dRows; r++) {
    for (let c = 0; c < dCols; c++) {
      cells.push({ id: diaId(c, r), kind: 'diamond', col: c, row: r, walls: DIA_WALLS(), visited: false });
    }
  }

  function neighbors(cell) {
    const result = [];
    const { col: c, row: r } = cell;
    if (cell.kind === 'octagon') {
      if (r > 0)        result.push({ cell: cells[octId(c,   r - 1)], dir: 'N',  opp: 'S'  });
      if (r < rows - 1) result.push({ cell: cells[octId(c,   r + 1)], dir: 'S',  opp: 'N'  });
      if (c < cols - 1) result.push({ cell: cells[octId(c + 1, r)],   dir: 'E',  opp: 'W'  });
      if (c > 0)        result.push({ cell: cells[octId(c - 1, r)],   dir: 'W',  opp: 'E'  });
      if (c < cols - 1 && r > 0)        result.push({ cell: cells[diaId(c,     r - 1)], dir: 'NE', opp: 'SW' });
      if (c > 0        && r > 0)        result.push({ cell: cells[diaId(c - 1, r - 1)], dir: 'NW', opp: 'SE' });
      if (c < cols - 1 && r < rows - 1) result.push({ cell: cells[diaId(c,     r)],     dir: 'SE', opp: 'NW' });
      if (c > 0        && r < rows - 1) result.push({ cell: cells[diaId(c - 1, r)],     dir: 'SW', opp: 'NE' });
    } else {
      // Diamond — 4 octagon neighbors at its corners
      result.push({ cell: cells[octId(c,     r)],     dir: 'NW', opp: 'SE' });
      result.push({ cell: cells[octId(c + 1, r)],     dir: 'NE', opp: 'SW' });
      result.push({ cell: cells[octId(c + 1, r + 1)], dir: 'SE', opp: 'NW' });
      result.push({ cell: cells[octId(c,     r + 1)], dir: 'SW', opp: 'NE' });
    }
    return result;
  }

  function carve(a, b, dir) {
    a.walls[dir] = false;
    b.walls[OPP[dir]] = false;
  }

  function reset() {
    for (const c of cells) {
      c.walls = c.kind === 'octagon' ? OCT_WALLS() : DIA_WALLS();
      c.visited = false;
    }
  }

  return { cells, cols, rows, type: 'upsilon', neighbors, carve, reset, octId, diaId };
}
