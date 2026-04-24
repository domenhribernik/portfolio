// Sigma (hex) grid — offset rows, flat-top hexagons
// Directions: NE, E, SE, SW, W, NW
// Even columns are shifted down by half a hex height
export function createHexGrid(cols, rows) {
  const cells = [];
  const index = (c, r) => r * cols + c;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({ id: index(c, r), row: r, col: c, walls: { NE: true, E: true, SE: true, SW: true, W: true, NW: true }, visited: false });
    }
  }

  // Hex offset neighbor deltas (pointy-top, odd-r offset)
  function neighborCoords(c, r) {
    const even = (r % 2 === 0);
    return [
      { dc:  0, dr: -1, dir: 'NE', opp: 'SW' }, // N — but we treat top-right as NE for even
      { dc:  1, dr:  0, dir: 'E',  opp: 'W'  },
      { dc:  0, dr:  1, dir: 'SE', opp: 'NW' },
      { dc: -1, dr:  1, dir: 'SW', opp: 'NE' },
      { dc: -1, dr:  0, dir: 'W',  opp: 'E'  },
      { dc: -1, dr: -1, dir: 'NW', opp: 'SE' },
    ].map(d => ({
      ...d,
      nc: c + d.dc + (even ? 0 : (d.dr !== 0 ? 1 : 0)),
      nr: r + d.dr,
    }));
  }

  function neighbors(cell) {
    const { row: r, col: c } = cell;
    const result = [];
    for (const { nc, nr, dir, opp } of neighborCoords(c, r)) {
      if (nc >= 0 && nc < cols && nr >= 0 && nr < rows) {
        result.push({ cell: cells[index(nc, nr)], dir, opp });
      }
    }
    return result;
  }

  function carve(a, b, dir) {
    const opp = { NE: 'SW', SW: 'NE', E: 'W', W: 'E', SE: 'NW', NW: 'SE' }[dir];
    a.walls[dir] = false;
    b.walls[opp] = false;
  }

  function reset() {
    cells.forEach(c => { c.walls = { NE: true, E: true, SE: true, SW: true, W: true, NW: true }; c.visited = false; });
  }

  return { cells, cols, rows, type: 'hex', neighbors, carve, index, reset };
}
