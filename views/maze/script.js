import { PRNG } from './engine/prng.js';
import { createSquareGrid }   from './engine/grid-square.js';
import { createHexGrid }      from './engine/grid-hex.js';
import { createTriangleGrid } from './engine/grid-triangle.js';
import { createPolarGrid }    from './engine/grid-polar.js';
import { createUpsilonGrid }  from './engine/grid-upsilon.js';
import { dfs }               from './engine/algorithms/dfs.js';
import { prims }             from './engine/algorithms/prims.js';
import { kruskals }          from './engine/algorithms/kruskals.js';
import { wilsons }           from './engine/algorithms/wilsons.js';
import { sidewinder }        from './engine/algorithms/sidewinder.js';
import { binaryTree }        from './engine/algorithms/binary-tree.js';
import { recursiveDivision } from './engine/algorithms/recursive-division.js';
import { aldousBroder }      from './engine/algorithms/aldous-broder.js';
import { huntAndKill }       from './engine/algorithms/hunt-and-kill.js';
import { ellers }            from './engine/algorithms/ellers.js';
import { score as scoreMaze, bfsAll } from './engine/difficulty.js';
import { renderMaze } from './engine/render-svg.js';

const ALGORITHMS = {
  dfs:         { fn: dfs,               label: 'Recursive Backtracker (DFS)', rectOnly: false },
  prims:       { fn: prims,             label: "Prim's (randomized)",          rectOnly: false },
  kruskals:    { fn: kruskals,          label: "Kruskal's (randomized)",       rectOnly: false },
  wilsons:     { fn: wilsons,           label: "Wilson's",                     rectOnly: false },
  aldousBroder:{ fn: aldousBroder,      label: 'Aldous-Broder',                rectOnly: false },
  huntAndKill: { fn: huntAndKill,       label: 'Hunt-and-Kill',                rectOnly: false },
  sidewinder:  { fn: sidewinder,        label: 'Sidewinder',                   rectOnly: true  },
  binaryTree:  { fn: binaryTree,        label: 'Binary Tree',                  rectOnly: true  },
  recursiveDiv:{ fn: recursiveDivision, label: 'Recursive Division',           rectOnly: true  },
  ellers:      { fn: ellers,            label: "Eller's",                      rectOnly: true  },
};

const mazeContainer      = document.getElementById('maze-container');
const solutionContainer  = document.getElementById('solution-container');
const scoreEl            = document.getElementById('score-value');
const scoreLabelEl       = document.getElementById('score-label');
const scoreBarEl         = document.getElementById('score-bar');
const seedInput          = document.getElementById('seed');
const gridTypeSelect     = document.getElementById('grid-type');
const algorithmSelect    = document.getElementById('algorithm');
const widthInput         = document.getElementById('grid-width');
const heightInput        = document.getElementById('grid-height');
const colValEl           = document.getElementById('val-cols');
const rowValEl           = document.getElementById('val-rows');
const colLabelEl         = document.getElementById('label-cols');
const rowLabelEl         = document.getElementById('label-rows');
const solutionToggle     = document.getElementById('show-solution');
const solutionPageToggle = document.getElementById('solution-page');
const printBtn           = document.getElementById('print-btn');
const randomSeedBtn      = document.getElementById('random-seed');
const entrancePlacement  = document.getElementById('entrance-placement');
const paperSize          = document.getElementById('paper-size');
const paperOrient        = document.getElementById('paper-orient');
const paperCustomRow     = document.getElementById('paper-custom-row');
const paperWInput        = document.getElementById('paper-w');
const paperHInput        = document.getElementById('paper-h');
const cellSizeInput      = document.getElementById('cell-size');
const wallWidthInput     = document.getElementById('wall-width');
const cellSizeValEl      = document.getElementById('val-cellsize');
const wallWidthValEl     = document.getElementById('val-wallwidth');

const BREAKDOWN_KEYS = [
  { key: 'pathNorm',        label: 'Path'      },
  { key: 'decisionDensity', label: 'Decisions' },
  { key: 'deadEndNorm',     label: 'Dead ends' },
  { key: 'trapNorm',        label: 'Traps'     },
  { key: 'sizeNorm',        label: 'Size'      },
];

const RADAR = (() => {
  const svg = document.getElementById('bk-radar');
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const cx = 100, cy = 100, R = 58, rings = 4;
  const n = BREAKDOWN_KEYS.length;
  const angles = BREAKDOWN_KEYS.map((_, i) => -Math.PI / 2 + (i * 2 * Math.PI) / n);
  const el = (name, attrs) => {
    const e = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  const ringG = el('g', { class: 'bk-radar-grid' });
  for (let i = 1; i <= rings; i++) {
    const r = (R * i) / rings;
    const pts = angles.map(a => `${cx + Math.cos(a) * r},${cy + Math.sin(a) * r}`).join(' ');
    ringG.appendChild(el('polygon', { points: pts }));
  }
  svg.appendChild(ringG);
  const axG = el('g', { class: 'bk-radar-axis' });
  angles.forEach(a => {
    axG.appendChild(el('line', {
      x1: cx, y1: cy,
      x2: cx + Math.cos(a) * R,
      y2: cy + Math.sin(a) * R,
    }));
  });
  svg.appendChild(axG);
  const labG = el('g', { class: 'bk-radar-labels' });
  angles.forEach((a, i) => {
    const cosA = Math.cos(a), sinA = Math.sin(a);
    const x = cx + cosA * (R + 12);
    const y = cy + sinA * (R + 12);
    let anchor = 'middle';
    if (cosA > 0.3) anchor = 'start';
    else if (cosA < -0.3) anchor = 'end';
    let baseline = 'middle';
    if (sinA < -0.3) baseline = 'auto';
    else if (sinA > 0.3) baseline = 'hanging';
    const text = el('text', { x, y, 'text-anchor': anchor, 'dominant-baseline': baseline });
    text.textContent = BREAKDOWN_KEYS[i].label;
    labG.appendChild(text);
  });
  svg.appendChild(labG);
  const poly = el('polygon', { class: 'bk-radar-value', points: '' });
  svg.appendChild(poly);
  const dotG = el('g', { class: 'bk-radar-dots' });
  const dots = angles.map(() => {
    const c = el('circle', { r: 2.2, cx, cy });
    dotG.appendChild(c);
    return c;
  });
  svg.appendChild(dotG);
  return { angles, cx, cy, R, poly, dots };
})();

function updateRadar(breakdown) {
  const { angles, cx, cy, R, poly, dots } = RADAR;
  const pts = [];
  angles.forEach((a, i) => {
    const v = Math.max(0, Math.min(1, breakdown[BREAKDOWN_KEYS[i].key] || 0));
    const r = R * v;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    dots[i].setAttribute('cx', x);
    dots[i].setAttribute('cy', y);
  });
  poly.setAttribute('points', pts.join(' '));
}

let currentGrid  = null;
let currentStart = null;
let currentEnd   = null;

function randomSeed() { return Math.floor(Math.random() * 0xFFFFFFFF); }

// Compute the total cell count for a type at its maximum slider dimensions.
// Polar ring counts aren't simply cols×rows — replicate the expansion formula
// from grid-polar.js so sizeNorm saturates at 1.0 for a real max-size grid.
function maxCellsForType(type) {
  const lim = DIM_LIMITS[type] || DIM_LIMITS.square;
  if (type === 'polar') {
    const rings = lim.rows.max, baseDivs = lim.cols.max;
    const counts = [baseDivs];
    for (let r = 1; r < rings; r++) {
      const prev = counts[r - 1];
      counts.push(2 * Math.PI * r / prev >= 2 ? prev * 2 : prev);
    }
    return counts.reduce((a, b) => a + b, 0);
  }
  if (type === 'upsilon') {
    return lim.cols.max * lim.rows.max + (lim.cols.max - 1) * (lim.rows.max - 1);
  }
  return lim.cols.max * lim.rows.max;
}

const DIM_LIMITS = {
  square:   { cols: { min: 3, max: 80, def: 20 }, rows: { min: 3, max: 80, def: 20 } },
  hex:      { cols: { min: 3, max: 40, def: 20 }, rows: { min: 3, max: 40, def: 20 } },
  triangle: { cols: { min: 3, max: 120, def: 20 }, rows: { min: 3, max: 80, def: 20 } },
  polar:    { cols: { min: 4, max: 16, def: 6  }, rows: { min: 3, max: 24, def: 8  } },
  upsilon:  { cols: { min: 3, max: 40, def: 15 }, rows: { min: 3, max: 40, def: 15 } },
};

function getConfig() {
  const type   = gridTypeSelect.value;
  const limits = DIM_LIMITS[type] || DIM_LIMITS.square;
  return {
    type,
    algorithm: algorithmSelect.value,
    cols:  clampInt(widthInput.value,  limits.cols.min, limits.cols.max, limits.cols.def),
    rows:  clampInt(heightInput.value, limits.rows.min, limits.rows.max, limits.rows.def),
    seed:  parseInt(seedInput.value) || randomSeed(),
    placement: entrancePlacement.value,
  };
}

function clampInt(val, min, max, def) {
  const n = parseInt(val);
  return isNaN(n) ? def : Math.max(min, Math.min(max, n));
}

function updateDimensions() {
  const type   = gridTypeSelect.value;
  const limits = DIM_LIMITS[type] || DIM_LIMITS.square;

  if (type === 'polar') {
    colLabelEl.textContent = 'Divisions';
    rowLabelEl.textContent = 'Rings';
  } else {
    colLabelEl.textContent = 'Cols';
    rowLabelEl.textContent = 'Rows';
  }

  widthInput.min  = limits.cols.min; widthInput.max  = limits.cols.max;
  heightInput.min = limits.rows.min; heightInput.max = limits.rows.max;

  const w = +widthInput.value;
  const h = +heightInput.value;
  if (w < limits.cols.min || w > limits.cols.max) widthInput.value  = limits.cols.def;
  if (h < limits.rows.min || h > limits.rows.max) heightInput.value = limits.rows.def;

  colValEl.textContent = widthInput.value;
  rowValEl.textContent = heightInput.value;
}

function updateAlgorithmOptions() {
  const rectOnly = gridTypeSelect.value === 'square';
  for (const opt of algorithmSelect.options) {
    opt.disabled = !rectOnly && ALGORITHMS[opt.value]?.rectOnly;
  }
  if (algorithmSelect.options[algorithmSelect.selectedIndex]?.disabled) {
    algorithmSelect.value = 'dfs';
  }
}

// ── Entrance/exit placement ───────────────────────────────────────────────

function defaultEntranceExit(grid) {
  if (grid.type === 'polar') {
    const outerRing  = grid.rows - 1;
    const outerCount = grid.ringCounts[outerRing];
    return {
      start: { id: grid.cells[grid.ringStart[outerRing]].id,                              openDir: 'OUT' },
      end:   { id: grid.cells[grid.ringStart[outerRing] + Math.floor(outerCount / 2)].id, openDir: 'OUT' },
    };
  }
  if (grid.type === 'triangle') {
    const last = grid.cells[grid.cells.length - 1];
    return {
      start: { id: grid.cells[0].id, openDir: 'W' },
      end:   { id: last.id,          openDir: last.up ? 'S' : 'E' },
    };
  }
  if (grid.type === 'upsilon') {
    // Last cell in `cells` is a diamond — anchor on the corner octagons instead.
    const startCell = grid.cells[0];
    const endCell   = grid.cells[grid.cols * grid.rows - 1];
    return {
      start: { id: startCell.id, openDir: getBoundaryOpenDir(grid, startCell) },
      end:   { id: endCell.id,   openDir: getBoundaryOpenDir(grid, endCell) },
    };
  }
  const startCell = grid.cells[0];
  const endCell   = grid.cells[grid.cells.length - 1];
  return {
    start: { id: startCell.id, openDir: getBoundaryOpenDir(grid, startCell) },
    end:   { id: endCell.id,   openDir: getBoundaryOpenDir(grid, endCell) },
  };
}

// Picks a wall direction whose neighbor doesn't exist (= a perimeter wall).
// Auto-detection avoids hardcoded assumptions about hex/triangle offsets.
function getBoundaryOpenDir(grid, cell) {
  if (grid.type === 'polar') return 'OUT';

  const neighborDirs = new Set(grid.neighbors(cell).map(n => n.dir));
  for (const dir of Object.keys(cell.walls)) {
    if (!neighborDirs.has(dir)) return dir;
  }
  throw new Error(`Cell ${cell.id} has no perimeter wall (not a boundary cell)`);
}

function boundaryCells(grid) {
  if (grid.type === 'square' || grid.type === 'hex') {
    return grid.cells.filter(c =>
      c.row === 0 || c.row === grid.rows - 1 ||
      c.col === 0 || c.col === grid.cols - 1
    );
  }
  if (grid.type === 'triangle') {
    return grid.cells.filter(c =>
      (c.row === 0 && !c.up) ||
      (c.row === grid.rows - 1 && c.up) ||
      c.col === 0 || c.col === grid.cols - 1
    );
  }
  if (grid.type === 'polar') {
    return grid.cells.slice(grid.ringStart[grid.rows - 1]);
  }
  if (grid.type === 'upsilon') {
    return grid.cells.filter(c => c.kind === 'octagon' &&
      (c.row === 0 || c.row === grid.rows - 1 ||
       c.col === 0 || c.col === grid.cols - 1));
  }
  return grid.cells;
}

// 2× BFS finds the graph diameter, but in a maze the diameter endpoints are
// usually interior dead-ends — opening a wall there leaves the maze sealed
// because the neighbor on the other side still draws its own wall. So we pick
// the diameter pair restricted to boundary cells.
function farthestEntranceExit(grid) {
  const boundary    = boundaryCells(grid);
  const boundaryIds = new Set(boundary.map(c => c.id));
  if (boundary.length < 2) return defaultEntranceExit(grid);

  const farthestBoundary = (fromId) => {
    const { dist } = bfsAll(grid, fromId);
    let best = fromId, bestDist = -1;
    for (const id of boundaryIds) {
      const d = dist.get(id);
      if (d !== undefined && d > bestDist) { bestDist = d; best = id; }
    }
    return best;
  };

  const aId = farthestBoundary(boundary[0].id);
  const bId = farthestBoundary(aId);
  return {
    start: { id: aId, openDir: getBoundaryOpenDir(grid, grid.cells[aId]) },
    end:   { id: bId, openDir: getBoundaryOpenDir(grid, grid.cells[bId]) },
  };
}

function randomEntranceExit(grid, prng) {
  if (grid.type === 'polar') {
    const outerRing  = grid.rows - 1;
    const outerCount = grid.ringCounts[outerRing];
    const c1 = prng.int(outerCount);
    const c2 = (c1 + Math.floor(outerCount / 2) + prng.int(Math.max(1, Math.floor(outerCount / 4)))) % outerCount;
    return {
      start: { id: grid.cells[grid.ringStart[outerRing] + c1].id, openDir: 'OUT' },
      end:   { id: grid.cells[grid.ringStart[outerRing] + c2].id, openDir: 'OUT' },
    };
  }
  if (grid.type === 'square' || grid.type === 'hex') {
    const { cols, rows } = grid;
    function pick() {
      const s = prng.int(4);
      if (s === 0) return grid.cells[prng.int(cols)];
      if (s === 1) return grid.cells[(rows - 1) * cols + prng.int(cols)];
      if (s === 2) return grid.cells[prng.int(rows) * cols];
      return grid.cells[prng.int(rows) * cols + cols - 1];
    }
    const startCell = pick(), endCell = pick();
    return {
      start: { id: startCell.id, openDir: getBoundaryOpenDir(grid, startCell) },
      end:   { id: endCell.id,   openDir: getBoundaryOpenDir(grid, endCell) },
    };
  }
  if (grid.type === 'upsilon') {
    const boundary  = boundaryCells(grid);
    const startCell = boundary[prng.int(boundary.length)];
    const endCell   = boundary[prng.int(boundary.length)];
    return {
      start: { id: startCell.id, openDir: getBoundaryOpenDir(grid, startCell) },
      end:   { id: endCell.id,   openDir: getBoundaryOpenDir(grid, endCell) },
    };
  }
  const topRow    = grid.cells.filter(c => c.row === 0 && !c.up);
  const botRow    = grid.cells.filter(c => c.row === grid.rows - 1 && c.up);
  const startCell = topRow.length ? topRow[prng.int(topRow.length)] : grid.cells[0];
  const endCell   = botRow.length ? botRow[prng.int(botRow.length)] : grid.cells[grid.cells.length - 1];
  return {
    start: { id: startCell.id, openDir: getBoundaryOpenDir(grid, startCell) },
    end:   { id: endCell.id,   openDir: getBoundaryOpenDir(grid, endCell) },
  };
}

function computeEntranceExit(grid, placement, prng) {
  if (placement === 'farthest') return farthestEntranceExit(grid);
  if (placement === 'random')   return randomEntranceExit(grid, prng);
  return defaultEntranceExit(grid);
}

// ── Generation ────────────────────────────────────────────────────────────

function generate() {
  const cfg  = getConfig();
  seedInput.value = cfg.seed;
  const prng = new PRNG(cfg.seed);

  let grid;
  if      (cfg.type === 'hex')      grid = createHexGrid(cfg.cols, cfg.rows);
  else if (cfg.type === 'triangle') grid = createTriangleGrid(cfg.cols, cfg.rows);
  else if (cfg.type === 'polar')    grid = createPolarGrid(cfg.rows, cfg.cols);
  else if (cfg.type === 'upsilon')  grid = createUpsilonGrid(cfg.cols, cfg.rows);
  else                              grid = createSquareGrid(cfg.cols, cfg.rows);

  const algo = ALGORITHMS[cfg.algorithm] || ALGORITHMS.dfs;
  algo.fn(grid, prng);

  const { start, end } = computeEntranceExit(grid, cfg.placement, prng);
  currentGrid  = grid;
  currentStart = start;
  currentEnd   = end;

  renderAll();
}

function renderAll() {
  if (!currentGrid) return;

  const sizeRef = Math.sqrt(maxCellsForType(currentGrid.type));
  const result = scoreMaze(currentGrid, currentStart.id, currentEnd.id, { sizeRef });
  const RENDER_MARGIN = 24;
  const containerW = Math.max(100, (mazeContainer.clientWidth  || 600) - RENDER_MARGIN * 2);
  const containerH = Math.max(100, (mazeContainer.clientHeight || 600) - RENDER_MARGIN * 2);

  const opts = {
    cellSize:     parseFloat(cellSizeInput.value)  || 20,
    wallWidth:    parseFloat(wallWidthInput.value) || 1.5,
    solutionPath: solutionToggle.checked ? result.path : [],
    entrance:     currentStart,
    exit:         currentEnd,
    fitWidth:     containerW,
    fitHeight:    containerH,
  };

  mazeContainer.innerHTML = '';
  mazeContainer.appendChild(renderMaze(currentGrid, opts));

  // Solution page SVG — only built when the user has opted into printing it
  solutionContainer.innerHTML = '';
  if (solutionPageToggle.checked) {
    solutionContainer.appendChild(renderMaze(currentGrid, { ...opts, solutionPath: result.path }));
  }

  scoreEl.textContent      = result.score;
  scoreLabelEl.textContent = result.label;
  scoreBarEl.style.width      = result.score + '%';
  scoreBarEl.style.background = `hsl(${Math.round(120 - result.score * 1.2)},70%,50%)`;

  updateRadar(result.breakdown);
}

// ── Paper / print ─────────────────────────────────────────────────────────

let printStyleEl = null;
function updatePrintStyle() {
  if (!printStyleEl) {
    printStyleEl = document.createElement('style');
    document.head.appendChild(printStyleEl);
  }
  const isCustom = paperSize.value === 'custom';
  paperCustomRow.style.display = isCustom ? '' : 'none';
  paperOrient.disabled = isCustom;

  let sizeRule;
  if (isCustom) {
    const w = Math.max(20, Math.min(2000, parseFloat(paperWInput.value) || 210));
    const h = Math.max(20, Math.min(2000, parseFloat(paperHInput.value) || 297));
    sizeRule = `${w}mm ${h}mm`;
  } else {
    const size   = paperSize.value   === 'letter' ? 'letter' : 'A4';
    const orient = paperOrient.value === 'landscape' ? 'landscape' : 'portrait';
    sizeRule = `${size} ${orient}`;
  }
  printStyleEl.textContent = `@media print { @page { size: ${sizeRule}; margin: 10mm; } }`;
}

// ── Events ────────────────────────────────────────────────────────────────

function generateNew() {
  seedInput.value = randomSeed();
  generate();
}

randomSeedBtn.addEventListener('click', generateNew);
document.getElementById('generate-btn').addEventListener('click', generateNew);

gridTypeSelect.addEventListener('change', () => {
  updateDimensions();
  updateAlgorithmOptions();
  generate();
});

algorithmSelect.addEventListener('change', generate);
entrancePlacement.addEventListener('change', generate);

widthInput.addEventListener('input',  () => { colValEl.textContent = widthInput.value; });
heightInput.addEventListener('input', () => { rowValEl.textContent = heightInput.value; });
widthInput.addEventListener('change',  generate);
heightInput.addEventListener('change', generate);

solutionToggle.addEventListener('change', renderAll);

cellSizeInput.addEventListener('input',  () => { cellSizeValEl.textContent  = cellSizeInput.value;  });
wallWidthInput.addEventListener('input', () => { wallWidthValEl.textContent = wallWidthInput.value; });
cellSizeInput.addEventListener('change',  renderAll);
wallWidthInput.addEventListener('change', renderAll);

solutionPageToggle.addEventListener('change', () => {
  document.body.classList.toggle('include-solution-page', solutionPageToggle.checked);
  renderAll();
});

paperSize.addEventListener('change',   updatePrintStyle);
paperOrient.addEventListener('change', updatePrintStyle);
paperWInput.addEventListener('change', updatePrintStyle);
paperHInput.addEventListener('change', updatePrintStyle);

printBtn.addEventListener('click', () => window.print());

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderAll, 150);
});

updateDimensions();
updateAlgorithmOptions();
updatePrintStyle();
generate();
