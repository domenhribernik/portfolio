import { PRNG } from './engine/prng.js';
import { createSquareGrid }   from './engine/grid-square.js';
import { createHexGrid }      from './engine/grid-hex.js';
import { createTriangleGrid } from './engine/grid-triangle.js';
import { createPolarGrid }    from './engine/grid-polar.js';
import { dfs }               from './engine/algorithms/dfs.js';
import { prims }             from './engine/algorithms/prims.js';
import { kruskals }          from './engine/algorithms/kruskals.js';
import { wilsons }           from './engine/algorithms/wilsons.js';
import { sidewinder }        from './engine/algorithms/sidewinder.js';
import { binaryTree }        from './engine/algorithms/binary-tree.js';
import { recursiveDivision } from './engine/algorithms/recursive-division.js';
import { score as scoreMaze, bfsAll } from './engine/difficulty.js';
import { renderMaze } from './engine/render-svg.js';

const ALGORITHMS = {
  dfs:         { fn: dfs,               label: 'Recursive Backtracker (DFS)', rectOnly: false },
  prims:       { fn: prims,             label: "Prim's (randomized)",          rectOnly: false },
  kruskals:    { fn: kruskals,          label: "Kruskal's (randomized)",       rectOnly: false },
  wilsons:     { fn: wilsons,           label: "Wilson's",                     rectOnly: false },
  sidewinder:  { fn: sidewinder,        label: 'Sidewinder',                   rectOnly: true  },
  binaryTree:  { fn: binaryTree,        label: 'Binary Tree',                  rectOnly: true  },
  recursiveDiv:{ fn: recursiveDivision, label: 'Recursive Division',           rectOnly: true  },
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

const BREAKDOWN_KEYS = [
  { id: 'bk-solution', key: 'pathNorm'        },
  { id: 'bk-decision', key: 'decisionDensity' },
  { id: 'bk-deadend',  key: 'deadEndRatio'    },
  { id: 'bk-junction', key: 'junctionRatio'   },
  { id: 'bk-trap',     key: 'trapNorm'        },
  { id: 'bk-size',     key: 'sizeNorm'        },
];
const breakdownBars = BREAKDOWN_KEYS.map(k => document.getElementById(k.id));

let currentGrid  = null;
let currentStart = null;
let currentEnd   = null;

function randomSeed() { return Math.floor(Math.random() * 0xFFFFFFFF); }

const DIM_LIMITS = {
  square:   { cols: { min: 3, max: 80, def: 20 }, rows: { min: 3, max: 80, def: 20 } },
  hex:      { cols: { min: 3, max: 40, def: 20 }, rows: { min: 3, max: 40, def: 20 } },
  triangle: { cols: { min: 3, max: 120, def: 20 }, rows: { min: 3, max: 80, def: 20 } },
  polar:    { cols: { min: 4, max: 16, def: 6  }, rows: { min: 3, max: 24, def: 8  } },
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

  const result = scoreMaze(currentGrid, currentStart.id, currentEnd.id);
  const RENDER_MARGIN = 24;
  const containerW = Math.max(100, (mazeContainer.clientWidth  || 600) - RENDER_MARGIN * 2);
  const containerH = Math.max(100, (mazeContainer.clientHeight || 600) - RENDER_MARGIN * 2);

  const opts = {
    cellSize:     20,
    wallWidth:    1.5,
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

  BREAKDOWN_KEYS.forEach(({ key }, i) => {
    breakdownBars[i].style.width = Math.round((result.breakdown[key] || 0) * 100) + '%';
  });
}

// ── Paper / print ─────────────────────────────────────────────────────────

let printStyleEl = null;
function updatePrintStyle() {
  if (!printStyleEl) {
    printStyleEl = document.createElement('style');
    document.head.appendChild(printStyleEl);
  }
  const size   = paperSize.value   === 'letter' ? 'letter' : 'A4';
  const orient = paperOrient.value === 'landscape' ? 'landscape' : 'portrait';
  printStyleEl.textContent = `@media print { @page { size: ${size} ${orient}; margin: 10mm; } }`;
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

solutionPageToggle.addEventListener('change', () => {
  document.body.classList.toggle('include-solution-page', solutionPageToggle.checked);
  renderAll();
});

paperSize.addEventListener('change',   updatePrintStyle);
paperOrient.addEventListener('change', updatePrintStyle);

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
