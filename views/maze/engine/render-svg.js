const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

// --- Square renderer ---
function renderSquare(grid, opts) {
  const { cellSize, wallWidth, solutionPath, entrance, exit, fitWidth, fitHeight } = opts;
  const W = grid.cols * cellSize + wallWidth;
  const H = grid.rows * cellSize + wallWidth;
  const scaleX = fitWidth  ? fitWidth  / W : 1;
  const scaleY = fitHeight ? fitHeight / H : 1;
  const scale  = Math.min(scaleX, scaleY, 1);
  const sw = W * scale, sh = H * scale;

  const svg = el('svg', { xmlns: SVG_NS, viewBox: `0 0 ${W} ${H}`, width: sw, height: sh });

  // Background
  svg.appendChild(el('rect', { x: 0, y: 0, width: W, height: H, fill: 'white' }));

  const pathSet = new Set(solutionPath || []);

  // Solution path highlight
  if (pathSet.size) {
    const g = el('g', { class: 'solution' });
    grid.cells.forEach(cell => {
      if (!pathSet.has(cell.id)) return;
      g.appendChild(el('rect', {
        x: cell.col * cellSize + wallWidth / 2,
        y: cell.row * cellSize + wallWidth / 2,
        width: cellSize, height: cellSize,
        fill: '#ffe082', opacity: '0.7',
      }));
    });
    svg.appendChild(g);
  }

  // Walls
  const g = el('g', { stroke: '#111', 'stroke-width': wallWidth, 'stroke-linecap': 'square' });
  grid.cells.forEach(cell => {
    const x = cell.col * cellSize + wallWidth / 2;
    const y = cell.row * cellSize + wallWidth / 2;
    if (cell.walls.N) g.appendChild(el('line', { x1: x, y1: y, x2: x + cellSize, y2: y }));
    if (cell.walls.S) g.appendChild(el('line', { x1: x, y1: y + cellSize, x2: x + cellSize, y2: y + cellSize }));
    if (cell.walls.W) g.appendChild(el('line', { x1: x, y1: y, x2: x, y2: y + cellSize }));
    if (cell.walls.E) g.appendChild(el('line', { x1: x + cellSize, y1: y, x2: x + cellSize, y2: y + cellSize }));
  });
  svg.appendChild(g);

  // Entrance / exit openings
  function openWall(cell, dir) {
    const x = cell.col * cellSize + wallWidth / 2;
    const y = cell.row * cellSize + wallWidth / 2;
    const gap = el('line', { stroke: 'white', 'stroke-width': wallWidth + 1 });
    const m = cellSize * 0.2;
    if (dir === 'N') { gap.setAttribute('x1', x + m); gap.setAttribute('y1', y); gap.setAttribute('x2', x + cellSize - m); gap.setAttribute('y2', y); }
    if (dir === 'S') { gap.setAttribute('x1', x + m); gap.setAttribute('y1', y + cellSize); gap.setAttribute('x2', x + cellSize - m); gap.setAttribute('y2', y + cellSize); }
    if (dir === 'W') { gap.setAttribute('x1', x); gap.setAttribute('y1', y + m); gap.setAttribute('x2', x); gap.setAttribute('y2', y + cellSize - m); }
    if (dir === 'E') { gap.setAttribute('x1', x + cellSize); gap.setAttribute('y1', y + m); gap.setAttribute('x2', x + cellSize); gap.setAttribute('y2', y + cellSize - m); }
    svg.appendChild(gap);
  }
  if (entrance) openWall(grid.cells[entrance.id], entrance.openDir);
  if (exit)     openWall(grid.cells[exit.id],     exit.openDir);

  return svg;
}

// --- Hex renderer (pointy-top) ---
function hexCorners(cx, cy, size) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = Math.PI / 180 * (60 * i - 30);
    return [cx + size * Math.cos(a), cy + size * Math.sin(a)];
  });
}

function renderHex(grid, opts) {
  const { cellSize, wallWidth, solutionPath, entrance, exit, fitWidth, fitHeight } = opts;
  const R = cellSize;
  const hexW = Math.sqrt(3) * R;
  const hexH = 2 * R;
  const W = hexW * grid.cols + hexW / 2 + wallWidth * 2;
  const H = hexH * 0.75 * grid.rows + hexH * 0.25 + wallWidth * 2;
  const scaleX = fitWidth  ? fitWidth  / W : 1;
  const scaleY = fitHeight ? fitHeight / H : 1;
  const scale  = Math.min(scaleX, scaleY, 1);

  const svg = el('svg', { xmlns: SVG_NS, viewBox: `0 0 ${W} ${H}`, width: W * scale, height: H * scale });
  svg.appendChild(el('rect', { x: 0, y: 0, width: W, height: H, fill: 'white' }));

  const pathSet = new Set(solutionPath || []);

  function cellCenter(cell) {
    const { col: c, row: r } = cell;
    const cx = wallWidth + hexW / 2 + c * hexW + (r % 2 === 1 ? hexW / 2 : 0);
    const cy = wallWidth + R + r * hexH * 0.75;
    return { cx, cy };
  }

  // Solution highlight
  if (pathSet.size) {
    const g = el('g', { class: 'solution' });
    grid.cells.forEach(cell => {
      if (!pathSet.has(cell.id)) return;
      const { cx, cy } = cellCenter(cell);
      const pts = hexCorners(cx, cy, R - wallWidth / 2).map(p => p.join(',')).join(' ');
      g.appendChild(el('polygon', { points: pts, fill: '#ffe082', opacity: '0.7' }));
    });
    svg.appendChild(g);
  }

  // Draw walls — each cell draws its NW, W, SW edges (avoids doubles)
  // Directions: NE=0, E=1, SE=2, SW=3, W=4, NW=5  (pointy-top corners 0-5)
  // Edge between corner i and i+1 corresponds to direction:
  // corner pairs: [0,1]=NE, [1,2]=E, [2,3]=SE, [3,4]=SW, [4,5]=W, [5,0]=NW
  const dirEdge = { NE: [0, 1], E: [1, 2], SE: [2, 3], SW: [3, 4], W: [4, 5], NW: [5, 0] };

  const wallGroup = el('g', { stroke: '#111', 'stroke-width': wallWidth, 'stroke-linecap': 'round' });
  grid.cells.forEach(cell => {
    const { cx, cy } = cellCenter(cell);
    const corners = hexCorners(cx, cy, R);
    for (const [dir, [i, j]] of Object.entries(dirEdge)) {
      if (cell.walls[dir]) {
        const [x1, y1] = corners[i];
        const [x2, y2] = corners[j];
        wallGroup.appendChild(el('line', { x1, y1, x2, y2 }));
      }
    }
  });
  svg.appendChild(wallGroup);

  return svg;
}

export function renderMaze(grid, opts) {
  return grid.type === 'hex' ? renderHex(grid, opts) : renderSquare(grid, opts);
}
