const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function bgRect(x, y, w, h) {
  return el('rect', { x, y, width: w, height: h, fill: 'white' });
}

const SOLUTION_STROKE    = '#b04848';
const SOLUTION_WIDTH     = 2.5;
const LABEL_PAD          = 56;
const LABEL_OFFSET       = 14;
const LABEL_OFFSET_OUTER = 22; // hex/triangle: label origin is already at the maze boundary

function addLabel(svg, x, y, text, anchor = 'middle') {
  const t = el('text', {
    x, y,
    'text-anchor': anchor,
    'dominant-baseline': 'middle',
    'font-family': 'Inter, system-ui, sans-serif',
    'font-size': '13',
    'font-weight': '600',
    fill: '#222',
  });
  t.textContent = text;
  svg.appendChild(t);
}

function placeLabelByOutwardVector(midX, midY, cx, cy, distance) {
  const dx = midX - cx, dy = midY - cy;
  const len = Math.hypot(dx, dy) || 1;
  return { x: midX + (dx / len) * distance, y: midY + (dy / len) * distance };
}

// Smooth curve through arbitrary points: each interior point is a quadratic
// control, and the curve anchors at midpoints between consecutive points. The
// curve passes through the first and last points exactly.
function solutionPolyline(centers) {
  if (centers.length < 2) return null;
  const r = (n) => Math.round(n * 100) / 100;
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  let d = `M ${r(centers[0].x)} ${r(centers[0].y)}`;
  if (centers.length === 2) {
    d += ` L ${r(centers[1].x)} ${r(centers[1].y)}`;
  } else {
    const m1 = mid(centers[0], centers[1]);
    d += ` L ${r(m1.x)} ${r(m1.y)}`;
    for (let i = 1; i < centers.length - 1; i++) {
      const m = mid(centers[i], centers[i + 1]);
      d += ` Q ${r(centers[i].x)} ${r(centers[i].y)} ${r(m.x)} ${r(m.y)}`;
    }
    const last = centers[centers.length - 1];
    d += ` L ${r(last.x)} ${r(last.y)}`;
  }
  return el('path', {
    d,
    fill: 'none',
    stroke: SOLUTION_STROKE,
    'stroke-width': SOLUTION_WIDTH,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    opacity: '0.9',
  });
}

function buildSkipMap(entrance, exit) {
  const m = new Map();
  for (const e of [entrance, exit]) {
    if (!e) continue;
    if (!m.has(e.id)) m.set(e.id, new Set());
    m.get(e.id).add(e.openDir);
  }
  return m;
}

// Walls between adjacent cells get drawn from both sides — use a canonical
// segment key to dedupe. Without this, interior walls render at ~2× the
// stroke weight of perimeter walls.
function makeWallDedup() {
  const seen = new Set();
  const r = (n) => Math.round(n * 100) / 100;
  return (x1, y1, x2, y2) => {
    const a = `${r(x1)},${r(y1)}`, b = `${r(x2)},${r(y2)}`;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

// ── Square renderer ────────────────────────────────────────────────────────

function renderSquare(grid, opts) {
  const { cellSize, wallWidth, solutionPath, entrance, exit, fitWidth, fitHeight } = opts;
  const W = grid.cols * cellSize + wallWidth;
  const H = grid.rows * cellSize + wallWidth;
  const totalW = W + 2 * LABEL_PAD;
  const totalH = H + 2 * LABEL_PAD;
  const scale = Math.min(fitWidth / totalW, fitHeight / totalH, 1);

  const svg = el('svg', { xmlns: SVG_NS, viewBox: `${-LABEL_PAD} ${-LABEL_PAD} ${totalW} ${totalH}`, width: totalW * scale, height: totalH * scale });
  svg.appendChild(bgRect(-LABEL_PAD, -LABEL_PAD, totalW, totalH));

  const skip = buildSkipMap(entrance, exit);
  const dedup = makeWallDedup();
  const addLine = (g, x1, y1, x2, y2) => {
    if (dedup(x1, y1, x2, y2)) g.appendChild(el('line', { x1, y1, x2, y2 }));
  };
  const wg = el('g', { stroke: '#111', 'stroke-width': wallWidth, 'stroke-linecap': 'square' });
  grid.cells.forEach(cell => {
    const x = cell.col * cellSize + wallWidth / 2;
    const y = cell.row * cellSize + wallWidth / 2;
    const sk = skip.get(cell.id);
    if (cell.walls.N && !sk?.has('N')) addLine(wg, x, y, x + cellSize, y);
    if (cell.walls.S && !sk?.has('S')) addLine(wg, x, y + cellSize, x + cellSize, y + cellSize);
    if (cell.walls.W && !sk?.has('W')) addLine(wg, x, y, x, y + cellSize);
    if (cell.walls.E && !sk?.has('E')) addLine(wg, x + cellSize, y, x + cellSize, y + cellSize);
  });
  svg.appendChild(wg);

  if (solutionPath.length) {
    const centers = solutionPath.map(id => {
      const c = grid.cells[id];
      return {
        x: c.col * cellSize + cellSize / 2 + wallWidth / 2,
        y: c.row * cellSize + cellSize / 2 + wallWidth / 2,
      };
    });
    const line = solutionPolyline(centers);
    if (line) svg.appendChild(line);
  }

  const labelForSquare = (cell, openDir, text) => {
    const x = cell.col * cellSize + wallWidth / 2;
    const y = cell.row * cellSize + wallWidth / 2;
    const cx = x + cellSize / 2;
    const cy = y + cellSize / 2;
    if (openDir === 'N') addLabel(svg, cx, y - LABEL_OFFSET, text);
    else if (openDir === 'S') addLabel(svg, cx, y + cellSize + LABEL_OFFSET, text);
    else if (openDir === 'W') addLabel(svg, x - LABEL_OFFSET, cy, text, 'end');
    else if (openDir === 'E') addLabel(svg, x + cellSize + LABEL_OFFSET, cy, text, 'start');
  };
  if (entrance) labelForSquare(grid.cells[entrance.id], entrance.openDir, 'Start');
  if (exit)     labelForSquare(grid.cells[exit.id],     exit.openDir,     'End');

  return svg;
}

// ── Hex renderer ──────────────────────────────────────────────────────────

function hexCorners(cx, cy, size) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = Math.PI / 180 * (60 * i - 30);
    return [cx + size * Math.cos(a), cy + size * Math.sin(a)];
  });
}

function renderHex(grid, opts) {
  const { cellSize, wallWidth, solutionPath, entrance, exit, fitWidth, fitHeight } = opts;
  const R    = cellSize;
  const hexW = Math.sqrt(3) * R;
  const hexH = 2 * R;
  const W    = hexW * grid.cols + hexW / 2 + wallWidth * 2;
  const H    = hexH * 0.75 * grid.rows + hexH * 0.25 + wallWidth * 2;
  const totalW = W + 2 * LABEL_PAD;
  const totalH = H + 2 * LABEL_PAD;
  const scale = Math.min(fitWidth / totalW, fitHeight / totalH, 1);

  const svg = el('svg', { xmlns: SVG_NS, viewBox: `${-LABEL_PAD} ${-LABEL_PAD} ${totalW} ${totalH}`, width: totalW * scale, height: totalH * scale });
  svg.appendChild(bgRect(-LABEL_PAD, -LABEL_PAD, totalW, totalH));

  function cellCenter(cell) {
    const { col: c, row: r } = cell;
    return {
      cx: wallWidth + hexW / 2 + c * hexW + (r % 2 === 1 ? hexW / 2 : 0),
      cy: wallWidth + R + r * hexH * 0.75,
    };
  }

  const dirEdge = { NE: [5,0], E: [0,1], SE: [1,2], SW: [2,3], W: [3,4], NW: [4,5] };
  const skip = buildSkipMap(entrance, exit);
  const dedup = makeWallDedup();
  const wg = el('g', { stroke: '#111', 'stroke-width': wallWidth, 'stroke-linecap': 'round' });
  grid.cells.forEach(cell => {
    const { cx, cy } = cellCenter(cell);
    const corners = hexCorners(cx, cy, R);
    const sk = skip.get(cell.id);
    for (const [dir, [i, j]] of Object.entries(dirEdge)) {
      if (cell.walls[dir] && !sk?.has(dir)) {
        const [x1, y1] = corners[i], [x2, y2] = corners[j];
        if (dedup(x1, y1, x2, y2)) wg.appendChild(el('line', { x1, y1, x2, y2 }));
      }
    }
  });
  svg.appendChild(wg);

  if (solutionPath.length) {
    const centers = solutionPath.map(id => cellCenter(grid.cells[id]))
      .map(p => ({ x: p.cx, y: p.cy }));
    const line = solutionPolyline(centers);
    if (line) svg.appendChild(line);
  }

  const labelForHex = (cell, openDir, text) => {
    const { cx: ccx, cy: ccy } = cellCenter(cell);
    const corners = hexCorners(ccx, ccy, R);
    const [i, j] = dirEdge[openDir];
    const mx = (corners[i][0] + corners[j][0]) / 2;
    const my = (corners[i][1] + corners[j][1]) / 2;
    const { x, y } = placeLabelByOutwardVector(mx, my, ccx, ccy, LABEL_OFFSET_OUTER);
    addLabel(svg, x, y, text);
  };
  if (entrance) labelForHex(grid.cells[entrance.id], entrance.openDir, 'Start');
  if (exit)     labelForHex(grid.cells[exit.id],     exit.openDir,     'End');

  return svg;
}

// ── Triangle renderer ─────────────────────────────────────────────────────

function renderTriangle(grid, opts) {
  const { cellSize, wallWidth, solutionPath, entrance, exit, fitWidth, fitHeight } = opts;
  const halfW = cellSize / 2;
  const h     = cellSize * Math.sqrt(3) / 2;
  const off   = wallWidth / 2;
  const W     = (grid.cols + 1) * halfW + wallWidth;
  const H     = (grid.rows + 1) * h     + wallWidth;
  const totalW = W + 2 * LABEL_PAD;
  const totalH = H + 2 * LABEL_PAD;
  const scale = Math.min(fitWidth / totalW, fitHeight / totalH, 1);

  const svg = el('svg', { xmlns: SVG_NS, viewBox: `${-LABEL_PAD} ${-LABEL_PAD} ${totalW} ${totalH}`, width: totalW * scale, height: totalH * scale });
  svg.appendChild(bgRect(-LABEL_PAD, -LABEL_PAD, totalW, totalH));

  // ▲: [apex, leftBase, rightBase]; ▽: [leftTop, rightTop, apexBottom]
  function verts(cell) {
    const { col: c, row: r, up } = cell;
    if (up) return [
      { x: (c+1)*halfW+off, y:  r   *h+off },
      { x:  c   *halfW+off, y: (r+1)*h+off },
      { x: (c+2)*halfW+off, y: (r+1)*h+off },
    ];
    return [
      { x:  c   *halfW+off, y:  r   *h+off },
      { x: (c+2)*halfW+off, y:  r   *h+off },
      { x: (c+1)*halfW+off, y: (r+1)*h+off },
    ];
  }

  const skip = buildSkipMap(entrance, exit);
  const dedup = makeWallDedup();
  const addLine = (g, x1, y1, x2, y2) => {
    if (dedup(x1, y1, x2, y2)) g.appendChild(el('line', { x1, y1, x2, y2 }));
  };
  const wg = el('g', { stroke: '#111', 'stroke-width': wallWidth, 'stroke-linecap': 'round' });
  grid.cells.forEach(cell => {
    const [v0, v1, v2] = verts(cell);
    const sk = skip.get(cell.id);
    if (cell.up) {
      // ▲ v0=apex v1=leftBase v2=rightBase
      if (cell.walls.W && !sk?.has('W')) addLine(wg, v0.x, v0.y, v1.x, v1.y);
      if (cell.walls.E && !sk?.has('E')) addLine(wg, v0.x, v0.y, v2.x, v2.y);
      if (cell.walls.S && !sk?.has('S')) addLine(wg, v1.x, v1.y, v2.x, v2.y);
    } else {
      // ▽ v0=leftTop v1=rightTop v2=apexBottom
      if (cell.walls.W && !sk?.has('W')) addLine(wg, v0.x, v0.y, v2.x, v2.y);
      if (cell.walls.E && !sk?.has('E')) addLine(wg, v1.x, v1.y, v2.x, v2.y);
      if (cell.walls.N && !sk?.has('N')) addLine(wg, v0.x, v0.y, v1.x, v1.y);
    }
  });
  svg.appendChild(wg);

  if (solutionPath.length) {
    const centers = solutionPath.map(id => {
      const v = verts(grid.cells[id]);
      return { x: (v[0].x + v[1].x + v[2].x) / 3, y: (v[0].y + v[1].y + v[2].y) / 3 };
    });
    const line = solutionPolyline(centers);
    if (line) svg.appendChild(line);
  }

  const labelForTri = (cell, openDir, text) => {
    const v = verts(cell);
    const ccx = (v[0].x + v[1].x + v[2].x) / 3;
    const ccy = (v[0].y + v[1].y + v[2].y) / 3;
    let mx, my;
    if (cell.up) {
      if (openDir === 'W')      { mx = (v[0].x + v[1].x)/2; my = (v[0].y + v[1].y)/2; }
      else if (openDir === 'E') { mx = (v[0].x + v[2].x)/2; my = (v[0].y + v[2].y)/2; }
      else                      { mx = (v[1].x + v[2].x)/2; my = (v[1].y + v[2].y)/2; }
    } else {
      if (openDir === 'W')      { mx = (v[0].x + v[2].x)/2; my = (v[0].y + v[2].y)/2; }
      else if (openDir === 'E') { mx = (v[1].x + v[2].x)/2; my = (v[1].y + v[2].y)/2; }
      else                      { mx = (v[0].x + v[1].x)/2; my = (v[0].y + v[1].y)/2; }
    }
    const { x, y } = placeLabelByOutwardVector(mx, my, ccx, ccy, LABEL_OFFSET_OUTER);
    addLabel(svg, x, y, text);
  };
  if (entrance) labelForTri(grid.cells[entrance.id], entrance.openDir, 'Start');
  if (exit)     labelForTri(grid.cells[exit.id],     exit.openDir,     'End');

  return svg;
}

// ── Polar renderer ────────────────────────────────────────────────────────

function polarArcPath(cx, cy, R, startA, endA) {
  const x1 = cx + R * Math.cos(startA), y1 = cy + R * Math.sin(startA);
  const x2 = cx + R * Math.cos(endA),   y2 = cy + R * Math.sin(endA);
  const large = endA - startA > Math.PI ? 1 : 0;
  return `M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2}`;
}

function polarSectorPath(cx, cy, innerR, outerR, startA, endA) {
  const cos0 = Math.cos(startA), sin0 = Math.sin(startA);
  const cos1 = Math.cos(endA),   sin1 = Math.sin(endA);
  const large = endA - startA > Math.PI ? 1 : 0;
  if (innerR < 0.5) {
    return `M ${cx} ${cy} L ${cx+outerR*cos0} ${cy+outerR*sin0} A ${outerR} ${outerR} 0 ${large} 1 ${cx+outerR*cos1} ${cy+outerR*sin1} Z`;
  }
  return [
    `M ${cx+innerR*cos0} ${cy+innerR*sin0}`,
    `A ${innerR} ${innerR} 0 ${large} 1 ${cx+innerR*cos1} ${cy+innerR*sin1}`,
    `L ${cx+outerR*cos1} ${cy+outerR*sin1}`,
    `A ${outerR} ${outerR} 0 ${large} 0 ${cx+outerR*cos0} ${cy+outerR*sin0}`,
    'Z',
  ].join(' ');
}

function renderPolar(grid, opts) {
  const { cellSize, wallWidth, solutionPath, entrance, exit, fitWidth, fitHeight } = opts;
  const { ringCounts, ringStart, rows: rings } = grid;
  const maxR  = rings * cellSize;
  const pad   = wallWidth + 2;
  const size  = (maxR + pad) * 2;
  const total = size + 2 * LABEL_PAD;
  const scale = Math.min(fitWidth / total, fitHeight / total, 1);
  const cx = maxR + pad, cy = maxR + pad;

  const svg = el('svg', { xmlns: SVG_NS, viewBox: `${-LABEL_PAD} ${-LABEL_PAD} ${total} ${total}`, width: total * scale, height: total * scale });
  svg.appendChild(bgRect(-LABEL_PAD, -LABEL_PAD, total, total));

  const entrId = entrance?.id ?? -1;
  const exitId = exit?.id     ?? -1;

  function cellAngles(r, c) {
    const count = ringCounts[r];
    return {
      startA: -Math.PI / 2 + 2 * Math.PI * c / count,
      endA:   -Math.PI / 2 + 2 * Math.PI * (c + 1) / count,
    };
  }

  const wg = el('g', { stroke: '#111', 'stroke-width': wallWidth, fill: 'none', 'stroke-linecap': 'round' });

  grid.cells.forEach(cell => {
    const { ring: r, col: c } = cell;
    const innerR = r * cellSize, outerR = (r + 1) * cellSize;
    const { startA, endA } = cellAngles(r, c);

    if (r > 0 && cell.walls.IN) {
      wg.appendChild(el('path', { d: polarArcPath(cx, cy, innerR, startA, endA) }));
    }

    if (cell.walls.CW) {
      const cwAngle = endA;
      wg.appendChild(el('line', {
        x1: cx + innerR * Math.cos(cwAngle), y1: cy + innerR * Math.sin(cwAngle),
        x2: cx + outerR * Math.cos(cwAngle), y2: cy + outerR * Math.sin(cwAngle),
      }));
    }
  });

  const outerRing = rings - 1;
  grid.cells.slice(ringStart[outerRing]).forEach(cell => {
    if (cell.id === entrId || cell.id === exitId) return;
    const { startA, endA } = cellAngles(outerRing, cell.col);
    wg.appendChild(el('path', { d: polarArcPath(cx, cy, maxR, startA, endA) }));
  });

  svg.appendChild(wg);
  svg.appendChild(el('circle', { cx, cy, r: cellSize, fill: 'white' }));
  svg.appendChild(el('circle', { cx, cy, r: Math.max(wallWidth * 1.5, 2), fill: '#111' }));

  if (solutionPath.length) {
    const centers = solutionPath.map(id => {
      const cell = grid.cells[id];
      const { ring: r, col: c } = cell;
      const midR = r === 0 ? cellSize * 0.5 : (r + 0.5) * cellSize;
      const { startA, endA } = cellAngles(r, c);
      const midA = (startA + endA) / 2;
      return { x: cx + midR * Math.cos(midA), y: cy + midR * Math.sin(midA) };
    });
    const line = solutionPolyline(centers);
    if (line) svg.appendChild(line);
  }

  const labelForPolar = (cell, text) => {
    const { startA, endA } = cellAngles(cell.ring, cell.col);
    const midA = (startA + endA) / 2;
    const labelR = maxR + LABEL_OFFSET;
    addLabel(svg, cx + labelR * Math.cos(midA), cy + labelR * Math.sin(midA), text);
  };
  if (entrance) labelForPolar(grid.cells[entrance.id], 'Start');
  if (exit)     labelForPolar(grid.cells[exit.id],     'End');

  return svg;
}

// ── Upsilon renderer ──────────────────────────────────────────────────────

function renderUpsilon(grid, opts) {
  const { cellSize, wallWidth, solutionPath, entrance, exit, fitWidth, fitHeight } = opts;
  const c = cellSize * 1.18;        // slight upscale — upsilon reads cramped at base size
  const s = c / (1 + Math.SQRT2);  // octagon side length
  const t = (c - s) / 2;            // corner cut size = diamond half-diagonal
  const off = wallWidth / 2;
  const W = grid.cols * c + wallWidth;
  const H = grid.rows * c + wallWidth;
  const totalW = W + 2 * LABEL_PAD;
  const totalH = H + 2 * LABEL_PAD;
  const scale = Math.min(fitWidth / totalW, fitHeight / totalH, 1);

  const svg = el('svg', { xmlns: SVG_NS, viewBox: `${-LABEL_PAD} ${-LABEL_PAD} ${totalW} ${totalH}`, width: totalW * scale, height: totalH * scale });
  svg.appendChild(bgRect(-LABEL_PAD, -LABEL_PAD, totalW, totalH));

  const octCenter  = (oc, or) => ({ x: off + oc * c + c / 2, y: off + or * c + c / 2 });
  const diaCenter  = (dc, dr) => ({ x: off + (dc + 1) * c,    y: off + (dr + 1) * c });
  const cellCenter = (cell) => cell.kind === 'octagon' ? octCenter(cell.col, cell.row) : diaCenter(cell.col, cell.row);

  const skip  = buildSkipMap(entrance, exit);
  const dedup = makeWallDedup();
  const wg = el('g', { stroke: '#111', 'stroke-width': wallWidth, 'stroke-linecap': 'round' });
  const addLine = (x1, y1, x2, y2) => {
    if (dedup(x1, y1, x2, y2)) wg.appendChild(el('line', { x1, y1, x2, y2 }));
  };

  for (const cell of grid.cells) {
    const sk = skip.get(cell.id);
    if (cell.kind === 'octagon') {
      const { x: cx, y: cy } = octCenter(cell.col, cell.row);
      const v = [
        { x: cx - s/2, y: cy - c/2 }, // 0
        { x: cx + s/2, y: cy - c/2 }, // 1
        { x: cx + c/2, y: cy - s/2 }, // 2
        { x: cx + c/2, y: cy + s/2 }, // 3
        { x: cx + s/2, y: cy + c/2 }, // 4
        { x: cx - s/2, y: cy + c/2 }, // 5
        { x: cx - c/2, y: cy + s/2 }, // 6
        { x: cx - c/2, y: cy - s/2 }, // 7
      ];
      const draw = (dir, a, b) => {
        if (cell.walls[dir] && !sk?.has(dir)) addLine(a.x, a.y, b.x, b.y);
      };
      draw('N',  v[0], v[1]);
      draw('NE', v[1], v[2]);
      draw('E',  v[2], v[3]);
      draw('SE', v[3], v[4]);
      draw('S',  v[4], v[5]);
      draw('SW', v[5], v[6]);
      draw('W',  v[6], v[7]);
      draw('NW', v[7], v[0]);
    } else {
      const { x: dx, y: dy } = diaCenter(cell.col, cell.row);
      const N = { x: dx,     y: dy - t };
      const E = { x: dx + t, y: dy };
      const S = { x: dx,     y: dy + t };
      const Wv = { x: dx - t, y: dy };
      const draw = (dir, a, b) => {
        if (cell.walls[dir] && !sk?.has(dir)) addLine(a.x, a.y, b.x, b.y);
      };
      draw('NE', N, E);
      draw('SE', E, S);
      draw('SW', S, Wv);
      draw('NW', Wv, N);
    }
  }
  svg.appendChild(wg);

  if (solutionPath.length) {
    const centers = solutionPath.map(id => cellCenter(grid.cells[id]));
    const line = solutionPolyline(centers);
    if (line) svg.appendChild(line);
  }

  // Walls are drawn from a center; place each label outward along the
  // wall midpoint vector for consistent positioning at any boundary direction.
  const labelForUpsilon = (cell, openDir, text) => {
    const { x: cx, y: cy } = cellCenter(cell);
    const half = c / 2;
    const diag = (s + c) / 4;
    const wallMid = {
      N:  { x: cx,         y: cy - half },
      S:  { x: cx,         y: cy + half },
      E:  { x: cx + half,  y: cy        },
      W:  { x: cx - half,  y: cy        },
      NE: { x: cx + diag,  y: cy - diag },
      NW: { x: cx - diag,  y: cy - diag },
      SE: { x: cx + diag,  y: cy + diag },
      SW: { x: cx - diag,  y: cy + diag },
    }[openDir];
    if (!wallMid) return;
    const { x, y } = placeLabelByOutwardVector(wallMid.x, wallMid.y, cx, cy, LABEL_OFFSET_OUTER);
    addLabel(svg, x, y, text);
  };
  if (entrance) labelForUpsilon(grid.cells[entrance.id], entrance.openDir, 'Start');
  if (exit)     labelForUpsilon(grid.cells[exit.id],     exit.openDir,     'End');

  return svg;
}

// ── Dispatcher ────────────────────────────────────────────────────────────

export function renderMaze(grid, opts) {
  const defaults = { cellSize: 20, wallWidth: 1.5, solutionPath: [], entrance: null, exit: null, fitWidth: 600, fitHeight: 600 };
  const o = { ...defaults, ...opts };
  if (grid.type === 'hex')      return renderHex(grid, o);
  if (grid.type === 'triangle') return renderTriangle(grid, o);
  if (grid.type === 'polar')    return renderPolar(grid, o);
  if (grid.type === 'upsilon')  return renderUpsilon(grid, o);
  return renderSquare(grid, o);
}
