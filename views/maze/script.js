import { PRNG } from './engine/prng.js';
import { createSquareGrid } from './engine/grid-square.js';
import { createHexGrid } from './engine/grid-hex.js';
import { dfs } from './engine/algorithms/dfs.js';
import { prims } from './engine/algorithms/prims.js';
import { kruskals } from './engine/algorithms/kruskals.js';
import { wilsons } from './engine/algorithms/wilsons.js';
import { sidewinder } from './engine/algorithms/sidewinder.js';
import { binaryTree } from './engine/algorithms/binary-tree.js';
import { recursiveDivision } from './engine/algorithms/recursive-division.js';
import { score as scoreMaze } from './engine/difficulty.js';
import { renderMaze } from './engine/render-svg.js';

const ALGORITHMS = {
  dfs:        { fn: dfs,               label: 'Recursive Backtracker (DFS)', squareOnly: false },
  prims:      { fn: prims,             label: "Prim's (randomized)",          squareOnly: false },
  kruskals:   { fn: kruskals,          label: "Kruskal's (randomized)",       squareOnly: false },
  wilsons:    { fn: wilsons,           label: "Wilson's",                     squareOnly: false },
  sidewinder: { fn: sidewinder,        label: 'Sidewinder',                   squareOnly: true  },
  binaryTree: { fn: binaryTree,        label: 'Binary Tree',                  squareOnly: true  },
  recursiveDiv:{ fn: recursiveDivision,label: 'Recursive Division',           squareOnly: true  },
};

let currentGrid = null;
let currentStart = null;
let currentEnd = null;
let showSolution = false;

// DOM refs
const mazeContainer  = document.getElementById('maze-container');
const solutionContainer = document.getElementById('solution-container');
const scoreEl        = document.getElementById('score-value');
const scoreLabelEl   = document.getElementById('score-label');
const scoreBarEl     = document.getElementById('score-bar');
const seedInput      = document.getElementById('seed');
const gridTypeSelect = document.getElementById('grid-type');
const algorithmSelect= document.getElementById('algorithm');
const widthInput     = document.getElementById('grid-width');
const heightInput    = document.getElementById('grid-height');
const solutionToggle = document.getElementById('show-solution');
const solutionPageToggle = document.getElementById('solution-page');
const printBtn       = document.getElementById('print-btn');
const randomSeedBtn  = document.getElementById('random-seed');

function randomSeed() { return Math.floor(Math.random() * 0xFFFFFFFF); }

function getConfig() {
  return {
    gridType:  gridTypeSelect.value,
    algorithm: algorithmSelect.value,
    cols:      Math.max(3, Math.min(80, parseInt(widthInput.value)  || 15)),
    rows:      Math.max(3, Math.min(80, parseInt(heightInput.value) || 15)),
    seed:      parseInt(seedInput.value) || randomSeed(),
  };
}

function updateAlgorithmOptions() {
  const isHex = gridTypeSelect.value === 'hex';
  for (const opt of algorithmSelect.options) {
    const squareOnly = ALGORITHMS[opt.value]?.squareOnly;
    opt.disabled = isHex && squareOnly;
  }
  if (algorithmSelect.options[algorithmSelect.selectedIndex]?.disabled) {
    algorithmSelect.value = 'dfs';
  }
}

function entranceExit(grid) {
  // Top-left corner entrance, bottom-right corner exit
  const start = grid.cells[0];
  const end   = grid.cells[grid.cells.length - 1];
  return {
    start: { id: start.id, openDir: 'N' },
    end:   { id: end.id,   openDir: grid.type === 'hex' ? 'SE' : 'S' },
  };
}

function generate() {
  const cfg = getConfig();
  seedInput.value = cfg.seed;

  const prng = new PRNG(cfg.seed);
  const grid = cfg.gridType === 'hex'
    ? createHexGrid(cfg.cols, cfg.rows)
    : createSquareGrid(cfg.cols, cfg.rows);

  const algo = ALGORITHMS[cfg.algorithm] || ALGORITHMS.dfs;
  algo.fn(grid, prng);

  const { start, end } = entranceExit(grid);
  currentGrid  = grid;
  currentStart = start;
  currentEnd   = end;

  renderAll();
}

function renderAll() {
  if (!currentGrid) return;

  const { start, end } = { start: currentStart, end: currentEnd };
  const result = scoreMaze(currentGrid, start.id, end.id);
  showSolution = solutionToggle.checked;

  // Fit SVG to container
  const containerW = mazeContainer.clientWidth  || 600;
  const containerH = mazeContainer.clientHeight || 600;

  const opts = {
    cellSize:    20,
    wallWidth:   1.5,
    solutionPath: showSolution ? result.path : [],
    entrance:    { id: start.id, openDir: start.openDir },
    exit:        { id: end.id,   openDir: end.openDir },
    fitWidth:    containerW,
    fitHeight:   containerH,
  };

  mazeContainer.innerHTML = '';
  mazeContainer.appendChild(renderMaze(currentGrid, opts));

  // Solution page SVG (always rendered, shown/hidden by print CSS)
  solutionContainer.innerHTML = '';
  const solutionOpts = { ...opts, solutionPath: result.path, fitWidth: containerW, fitHeight: containerH };
  solutionContainer.appendChild(renderMaze(currentGrid, solutionOpts));

  // Score display
  scoreEl.textContent      = result.score;
  scoreLabelEl.textContent = result.label;
  scoreBarEl.style.width   = result.score + '%';
  const hue = Math.round(120 - result.score * 1.2);
  scoreBarEl.style.background = `hsl(${hue},70%,50%)`;
}

function updateSolutionPageVisibility() {
  document.body.classList.toggle('include-solution-page', solutionPageToggle.checked);
}

// Events
randomSeedBtn.addEventListener('click', () => {
  seedInput.value = randomSeed();
  generate();
});

document.getElementById('generate-btn').addEventListener('click', generate);
gridTypeSelect.addEventListener('change', () => { updateAlgorithmOptions(); generate(); });
algorithmSelect.addEventListener('change', generate);
solutionToggle.addEventListener('change', renderAll);
solutionPageToggle.addEventListener('change', updateSolutionPageVisibility);
printBtn.addEventListener('click', () => window.print());

// Re-render on window resize to fit new container size
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderAll, 150);
});

// Init
updateAlgorithmOptions();
generate();
