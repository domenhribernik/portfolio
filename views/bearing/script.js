/* BEARING / script.js
   Screens, input and drawing. Decides nothing: every rule lives in
   logic.js, and once the controller lands every fact about a room will
   come back through the poll.

   The practice screen is the exception and says so: it is a single-device
   instrument with no room behind it. */

import {
  normalizeCode, isValidCode, cleanName, isValidName,
  createTranslator, pollDelay,
  angleDelta, bearingBetween, alongBearing, crossingAngle,
  errorEllipse, fixGrade, formatMetres, antennaStrength,
  readBearing, lobePeak, MOVE_MAX, withinWalk
} from './logic.js';

const API = '../../app/controllers/bearing-controller.php';
const SVGNS = 'http://www.w3.org/2000/svg';

/* the valley, in cells. One cell is 100 metres. */
const N = 32, VB = 400, PAD = 26, METRES = 100;
const STEP = (VB - 2 * PAD) / (N - 1);
const ROSE = 72;
const SIGMA = 4;                    /* antenna error, one standard deviation */

const $ = id => document.getElementById(id);
const svg = $('svg'), chart = $('chart');
let t = k => k;

function el(name, attrs) {
  const e = document.createElementNS(SVGNS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
const cellX = i => PAD + i * STEP;
function polar(x, y, deg, r) {
  const a = (deg - 90) * Math.PI / 180;
  return { x: x + Math.cos(a) * r, y: y + Math.sin(a) * r };
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

/* ---- strings ------------------------------------------------------- */

async function loadStrings() {
  /* no-cache, never force-cache: a stale table is a page of key names. */
  const res = await fetch('ui.json', { cache: 'no-cache' });
  t = createTranslator(await res.json(), 'en');
  document.querySelectorAll('[data-s]').forEach(n => { n.textContent = t(n.dataset.s); });
  $('name').placeholder = t('boot.namePlaceholder');
  $('code').placeholder = t('boot.codePlaceholder');
}
function say(msg) { $('crier').textContent = msg; }

/* ---- screens ------------------------------------------------------- */

const SCREENS = { '': 'bootScreen', '#/practice': 'trainScreen',
                  '#/night': 'nightScreen', '#/dawn': 'dawnScreen' };
function route() {
  const id = SCREENS[location.hash] || 'bootScreen';
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === id));
  if (id === 'trainScreen') { if (!state.dealt || state.borrowed) deal(); render(); }
  if (id === 'nightScreen') renderNight(true);
  if (id === 'dawnScreen') renderDawn();
}
window.addEventListener('hashchange', route);

/* ---- the practice instrument ---------------------------------------
   No room, no server, no secrets: the collar is right here in the page,
   which is exactly why this screen can never be the game. */

const state = {
  mode: 'sweep', dealt: false, seed: 1,
  terrain: [], station: { x: 8, y: 22 }, stationB: { x: 24, y: 22 },
  collar: { x: 20, y: 8 }, trueBrg: 0, dist: 0,
  needle: 0, last: null, readings: new Array(360).fill(null), committed: null,
  gateFrac: 0.5, committedSigma: null
};

function buildTerrain(seed) {
  const g = [];
  for (let y = 0; y < N; y++) {
    g.push([]);
    for (let x = 0; x < N; x++) {
      const v = Math.sin((x + seed) * 0.34) * Math.cos((y - seed) * 0.29)
              + Math.sin((x + y) * 0.17) * 0.7;
      g[y].push(Math.max(0, Math.min(1, (v + 1.7) / 3.4)));
    }
  }
  return g;
}

function deal() {
  const s = state;
  s.seed = Math.floor(Math.random() * 100000) + 1;
  s.terrain = buildTerrain(s.seed);
  s.station = { x: 4 + Math.floor(Math.random() * (N - 8)), y: 4 + Math.floor(Math.random() * (N - 8)) };
  do {
    s.collar = { x: Math.floor(Math.random() * N), y: Math.floor(Math.random() * N) };
  } while (Math.hypot(s.collar.x - s.station.x, s.collar.y - s.station.y) < 11);
  s.trueBrg = bearingBetween(s.station, s.collar);
  s.dist = Math.hypot(s.collar.x - s.station.x, s.collar.y - s.station.y);
  s.readings = new Array(360).fill(null);
  s.committed = null; s.committedSigma = null; s.last = null; s.gateFrac = 0.5;
  s.needle = Math.floor(Math.random() * 360);
  /* B opens on a workable baseline, roughly 75 degrees off A's line of
     sight, because the crossing tab has to show a good fix before the
     player is invited to ruin it. Opening on a cigar teaches it backwards. */
  const away = bearingBetween(s.collar, s.station);
  const reach = Math.max(7, Math.min(13, s.dist * 0.8));
  const b = alongBearing(s.collar, away + 75, reach);
  s.stationB = { x: Math.max(1, Math.min(N - 2, Math.round(b.x))), y: Math.max(1, Math.min(N - 2, Math.round(b.y))) };
  s.dealt = true; s.borrowed = false;
  record(s.needle);
}

function record(a) {
  const i = ((Math.round(a) % 360) + 360) % 360;
  if (state.readings[i] === null) {
    state.readings[i] = antennaStrength(i, state.trueBrg, state.dist, state.seed);
  }
}
/* a real sweep hears everything it passes through, not only where the
   finger stopped, so fill the whole arc travelled. */
function recordArc(from, to) {
  if (from === null) { record(to); return; }
  const d = angleDelta(to, from), n = Math.max(1, Math.ceil(Math.abs(d)));
  for (let k = 0; k <= n; k++) record(from + d * (k / n));
}
function setNeedle(a) {
  if (state.committed !== null) return;
  const next = ((a % 360) + 360) % 360;
  recordArc(state.last === null ? next : state.last, next);
  state.needle = next; state.last = next;
  render();
}

/* The instrument's whole output. Nothing here consults the truth, which
   is what lets the plus-or-minus be shown live while you still work. */
function currentReading() {
  const peak = lobePeak(state.readings);
  if (!peak) return null;
  return readBearing(state.readings, state.gateFrac * peak.level);
}

/* ---- drawing ------------------------------------------------------- */

function plateBase(g) {
  for (let k = 0; k < N; k += 8) {
    g.appendChild(el('line', { class: 'grat', x1: cellX(k), y1: PAD, x2: cellX(k), y2: VB - PAD }));
    g.appendChild(el('line', { class: 'grat', x1: PAD, y1: cellX(k), x2: VB - PAD, y2: cellX(k) }));
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const v = state.terrain[y][x];
    g.appendChild(el('circle', {
      class: 'cell', cx: cellX(x), cy: cellX(y), r: (0.5 + v * 1.9).toFixed(2),
      'fill-opacity': (0.28 + v * 0.6).toFixed(2)
    }));
  }
}

function stationMark(g, S, letter, onKey) {
  const sx = cellX(S.x), sy = cellX(S.y);
  if (onKey) {
    const hit = el('circle', {
      class: 'stn-hit', cx: sx, cy: sy, r: 18, tabindex: 0, role: 'button',
      'aria-label': 'Station ' + letter + '. Arrow keys move it.'
    });
    hit.addEventListener('keydown', onKey);
    g.appendChild(hit);
  }
  g.appendChild(el('circle', { class: 'stn-ring', cx: sx, cy: sy, r: 6.5 }));
  g.appendChild(el('circle', { class: 'stn-dot', cx: sx, cy: sy, r: 2 }));
  const lab = el('text', { class: 'stn-label', x: sx + 11, y: sy + 4.5 });
  lab.textContent = letter;
  g.appendChild(lab);
}

function clipDefs(root) {
  const defs = el('defs', {}), cp = el('clipPath', { id: 'plateclip' });
  cp.appendChild(el('rect', {
    x: PAD - STEP / 2, y: PAD - STEP / 2,
    width: VB - 2 * PAD + STEP, height: VB - 2 * PAD + STEP
  }));
  defs.appendChild(cp); root.appendChild(defs);
  return el('g', { 'clip-path': 'url(#plateclip)' });
}

function drawSweep() {
  clear(svg);
  const marks = clipDefs(svg);
  plateBase(svg);

  const sx = cellX(state.station.x), sy = cellX(state.station.y);

  svg.appendChild(el('circle', { class: 'rose-ring', cx: sx, cy: sy, r: ROSE }));
  sweptRuns().forEach(run => {
    if (run.a1 - run.a0 >= 359) {
      svg.appendChild(el('circle', { class: 'rose-swept', cx: sx, cy: sy, r: ROSE }));
    } else if (run.a1 > run.a0) {
      const p0 = polar(sx, sy, run.a0, ROSE), p1 = polar(sx, sy, run.a1, ROSE);
      svg.appendChild(el('path', {
        class: 'rose-swept',
        d: `M${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A${ROSE} ${ROSE} 0 ${(run.a1 - run.a0) > 180 ? 1 : 0} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`
      }));
    }
  });

  for (let a = 0; a < 360; a += 15) {
    const major = a % 45 === 0;
    const p1 = polar(sx, sy, a, ROSE - (major ? 8 : 4)), p2 = polar(sx, sy, a, ROSE);
    const hp = polar(sx, sy, a, ROSE - 2);
    const hit = el('circle', {
      class: 'rose-hit', cx: hp.x, cy: hp.y, r: 10, tabindex: 0, role: 'button',
      'aria-label': 'Point the antenna to ' + a + ' degrees'
    });
    hit.addEventListener('click', () => setNeedle(a));
    hit.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setNeedle(a); }
    });
    svg.appendChild(hit);
    svg.appendChild(el('line', {
      class: 'rose-tick' + (major ? ' major' : ''), x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y
    }));
    if (a % 90 === 0) {
      const pn = polar(sx, sy, a, ROSE + 10);
      const n = el('text', { class: 'rose-num', x: pn.x, y: pn.y + 3.4 });
      n.textContent = String(a).padStart(3, '0');
      svg.appendChild(n);
    }
  }

  if (state.committed !== null) {
    const far = alongBearing({ x: sx, y: sy }, state.committed, VB * 1.6);
    const ray = el('line', { class: 'ray inking', x1: sx, y1: sy, x2: far.x, y2: far.y });
    ray.style.setProperty('--len', VB * 1.6);
    marks.appendChild(ray);
    const tp = alongBearing({ x: sx, y: sy }, state.trueBrg, VB * 1.6);
    marks.appendChild(el('line', { class: 'truth', x1: sx, y1: sy, x2: tp.x, y2: tp.y }));
    marks.appendChild(el('circle', {
      class: 'truth-ring', cx: cellX(state.collar.x), cy: cellX(state.collar.y), r: 7
    }));
  } else {
    /* The measurement, drawn as what it actually is: a direction with a
       stated width. Both are orange because neither is committed yet. */
    const read = currentReading();
    if (read && read.bracket && read.sigma != null) {
      const half = Math.min(40, read.sigma * 2);
      const R = VB * 1.6;
      const p1 = polar(sx, sy, read.bearing - half, R), p2 = polar(sx, sy, read.bearing + half, R);
      marks.appendChild(el('polygon', {
        class: 'wedge-live', points: `${sx},${sy} ${p1.x},${p1.y} ${p2.x},${p2.y}`
      }));
      const pr = polar(sx, sy, read.bearing, R);
      marks.appendChild(el('line', { class: 'measured', x1: sx, y1: sy, x2: pr.x, y2: pr.y }));
    }
    const np = polar(sx, sy, state.needle, ROSE - 2);
    marks.appendChild(el('line', { class: 'needle', x1: sx, y1: sy, x2: np.x, y2: np.y }));
    marks.appendChild(el('circle', { class: 'needle-head', cx: np.x, cy: np.y, r: 3.2 }));
  }
  svg.appendChild(marks);
  stationMark(svg, state.station, 'A', null);
}

function drawFix() {
  clear(svg);
  const marks = clipDefs(svg);
  plateBase(svg);

  const stations = [state.station, state.stationB];
  stations.forEach((S, i) => {
    const sx = cellX(S.x), sy = cellX(S.y);
    const b = bearingBetween(S, state.collar);
    const half = 2.45 * SIGMA, R = VB * 1.6;
    const p1 = polar(sx, sy, b - half, R), p2 = polar(sx, sy, b + half, R);
    marks.appendChild(el('polygon', { class: 'wedge', points: `${sx},${sy} ${p1.x},${p1.y} ${p2.x},${p2.y}` }));
    const pr = polar(sx, sy, b, R);
    marks.appendChild(el('line', { class: 'ray' + (i ? ' b' : ''), x1: sx, y1: sy, x2: pr.x, y2: pr.y }));
  });

  const e = errorEllipse(stations, state.collar, SIGMA);
  const tx = cellX(state.collar.x), ty = cellX(state.collar.y);
  const rx = Math.max(1.5, e.major * STEP), ry = Math.max(1.5, e.minor * STEP);
  const rot = `rotate(${e.rotation.toFixed(2)} ${tx} ${ty})`;
  marks.appendChild(el('ellipse', { class: 'ell', cx: tx, cy: ty, rx: rx.toFixed(2), ry: ry.toFixed(2), transform: rot }));
  marks.appendChild(el('line', { class: 'ell-ax', x1: tx - rx, y1: ty, x2: tx + rx, y2: ty, transform: rot }));
  svg.appendChild(marks);

  svg.appendChild(el('circle', { class: 'mark-ring', cx: tx, cy: ty, r: 5 }));
  svg.appendChild(el('circle', { class: 'mark', cx: tx, cy: ty, r: 1.8 }));

  stations.forEach((S, i) => stationMark(svg, S, i ? 'B' : 'A', e2 => {
    const d = e2.shiftKey ? 3 : 1;
    let moved = true;
    if (e2.key === 'ArrowLeft') S.x -= d;
    else if (e2.key === 'ArrowRight') S.x += d;
    else if (e2.key === 'ArrowUp') S.y -= d;
    else if (e2.key === 'ArrowDown') S.y += d;
    else moved = false;
    if (moved) { e2.preventDefault(); clampStation(S); render(); }
  }));
}

function clampStation(S) {
  S.x = Math.max(1, Math.min(N - 2, Math.round(S.x)));
  S.y = Math.max(1, Math.min(N - 2, Math.round(S.y)));
}

function sweptRuns() {
  const runs = [];
  let cur = null;
  for (let a = 0; a < 360; a++) {
    if (state.readings[a] !== null) {
      if (!cur) { cur = { a0: a, a1: a }; runs.push(cur); } else cur.a1 = a;
    } else cur = null;
  }
  if (runs.length > 1) {
    const f = runs[0], l = runs[runs.length - 1];
    if (f.a0 === 0 && l.a1 === 359) { l.a1 = 360 + f.a1; runs.shift(); }
  }
  return runs;
}

const CH_TOP = 62, CH_SCALE = 48;          /* strength 0..1 maps into the well */
const chartY = v => CH_TOP - v * CH_SCALE;

function drawChart() {
  clear(chart);
  for (let g = 0; g <= 360; g += 45) {
    chart.appendChild(el('line', { class: 'chart-grid', x1: g, y1: 0, x2: g, y2: 68 }));
    if (g < 360 && g % 90 === 0) {
      const n = el('text', { class: 'chart-num', x: g + 3, y: 80 });
      n.textContent = String(g).padStart(3, '0');
      chart.appendChild(n);
    }
  }
  chart.appendChild(el('line', { class: 'chart-grid', x1: 0, y1: 68, x2: 360, y2: 68 }));
  const cap = el('text', { class: 'chart-cap', x: 3, y: 9 });
  cap.textContent = t('train.chart').toUpperCase();
  chart.appendChild(cap);

  const read = currentReading();

  /* the bracket, drawn under the trace so the trace stays readable */
  if (read && read.bracket) {
    const b = read.bracket;
    const lo = b.lo, hi = lo + b.width;
    const span = (x0, x1) => chart.appendChild(el('rect', {
      class: 'bracket-span', x: x0, y: 0, width: Math.max(0, x1 - x0), height: 68
    }));
    if (hi <= 360) span(lo, hi); else { span(lo, 360); span(0, hi - 360); }
    [b.lo, ((b.lo + b.width) % 360)].forEach(x => {
      chart.appendChild(el('line', { class: 'bracket-edge', x1: x, y1: 0, x2: x, y2: 68 }));
    });
  }

  let runs = [], cur = null;
  for (let a = 0; a < 360; a++) {
    if (state.readings[a] !== null) {
      if (!cur) { cur = []; runs.push(cur); }
      cur.push(`${a},${chartY(state.readings[a]).toFixed(1)}`);
    } else cur = null;
  }
  runs.forEach(pts => {
    if (pts.length > 1) chart.appendChild(el('polyline', { class: 'trace', points: pts.join(' ') }));
  });

  /* the gate itself: the one thing the player sets */
  const peak = lobePeak(state.readings);
  if (peak) {
    const y = chartY(state.gateFrac * peak.level);
    chart.appendChild(el('line', { class: 'gate', x1: 0, y1: y, x2: 360, y2: y }));
    const grip = el('rect', { class: 'gate-grip', x: 0, y: y - 5, width: 360, height: 10 });
    chart.appendChild(grip);
  }

  if (state.committed === null) {
    chart.appendChild(el('line', { class: 'chart-cursor', x1: state.needle, y1: 0, x2: state.needle, y2: 68 }));
  }
}

/* ---- the title block ------------------------------------------------ */

function metaBlock(label, value, bad) {
  return `<div class="meta">${label.toUpperCase()} <b${bad ? ' class="bad"' : ''}>${value}</b></div>`;
}

function render() {
  const sweep = state.mode === 'sweep';
  $('tabSweep').setAttribute('aria-selected', String(sweep));
  $('tabFix').setAttribute('aria-selected', String(!sweep));
  chart.hidden = !sweep;
  $('qualityBar').hidden = sweep;

  if (sweep) {
    drawSweep(); drawChart();
    const swept = state.readings.reduce((n, v) => n + (v !== null ? 1 : 0), 0);
    const read = currentReading();
    const done = state.committed !== null;
    const bearing = done ? state.committed : (read && read.bearing);
    const sigma = done ? state.committedSigma : (read && read.sigma);

    const live = state.readings[((Math.round(state.needle) % 360) + 360) % 360];
    /* Until there is a real lobe on the trace the big number stays with
       your finger, because a bearing measured off hiss is a confident
       answer to nothing. */
    const headline = bearing == null ? state.needle : bearing;
    $('readout').innerHTML =
      `<div class="big">${String(Math.round(headline)).padStart(3, '0')}<span class="deg">&deg;</span></div>`
      + (bearing == null
          ? `<div class="meta">${t('train.aim').toUpperCase()}</div>`
          : `<div class="meta">&plusmn; <b${sigma != null && sigma > 3 ? ' class="bad"' : ''}>${sigma == null ? '--' : sigma.toFixed(1)}</b></div>`)
      + metaBlock(t('train.sig'), done ? '--' : (live == null ? '--' : String(Math.round(live * 99)).padStart(2, '0')))
      + metaBlock(t('train.gate'), Math.round(state.gateFrac * 100) + '%')
      + metaBlock(t('train.swept'), Math.round(swept / 3.6) + '%');

    $('caption').textContent = t('train.caption');
    $('acts').innerHTML =
      `<button class="btn btn--fill" id="commit"${(done || bearing == null) ? ' disabled' : ''}>`
      + (done ? t('train.committed') : t('train.commit')) + '</button>'
      + `<button class="btn narrow" id="again">${t('train.again')}</button>`;
    $('commit').addEventListener('click', () => {
      if (state.committed !== null) return;
      const r = currentReading();
      if (!r || r.bearing == null) return;
      state.committed = r.bearing;
      state.committedSigma = r.sigma;
      render();
      say(t('train.result', {
        said: Math.round(state.committed), truth: Math.round(state.trueBrg),
        err: Math.abs(angleDelta(state.committed, state.trueBrg)).toFixed(1)
      }));
    });
    $('again').addEventListener('click', () => { deal(); render(); });

    if (done) {
      $('help').innerHTML = t('train.result', {
        said: Math.round(state.committed), truth: Math.round(state.trueBrg),
        err: Math.abs(angleDelta(state.committed, state.trueBrg)).toFixed(1)
      });
    } else if (!read || !read.bracket) {
      $('help').textContent = t('train.helpSweep');
    } else if (state.gateFrac > 0.9 || state.gateFrac < 0.2) {
      $('help').textContent = t('train.helpGate');
    } else {
      $('help').textContent = t('train.helpGate');
    }
  } else {
    drawFix();
    const stations = [state.station, state.stationB];
    const e = errorEllipse(stations, state.collar, SIGMA);
    const cross = crossingAngle(bearingBetween(stations[0], state.collar), bearingBetween(stations[1], state.collar));
    const major = e.major * METRES, minor = e.minor * METRES;
    const grade = fixGrade(major);
    $('readout').innerHTML =
      `<div class="big">${Math.round(cross)}<span class="deg">&deg;</span></div>`
      + `<div class="meta">${t('train.crossing').toUpperCase()}</div>`
      + metaBlock(t('train.major'), formatMetres(major), major > 600)
      + metaBlock(t('train.minor'), formatMetres(minor));
    $('quality').style.width = Math.round(Math.max(0, Math.min(1, 1 - (major - 80) / 900)) * 100) + '%';
    const bad = grade === 'loose' || grade === 'worthless';
    $('caption').innerHTML = t('train.caption') + ' &middot; <b' + (bad ? ' class="bad"' : '') + '>'
      + t('train.' + grade).toUpperCase() + '</b>';
    $('acts').innerHTML = `<button class="btn narrow" id="again">${t('train.again')}</button>`;
    $('again').addEventListener('click', () => { deal(); render(); });
    $('help').textContent = t('train.geomHelp');
  }
}

/* ---- pointer input -------------------------------------------------- */

let dragging = null;
function pointAt(e) {
  const r = svg.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width * VB - PAD) / STEP,
    y: ((e.clientY - r.top) / r.height * VB - PAD) / STEP
  };
}
svg.addEventListener('pointerdown', e => {
  if (e.target.classList.contains('rose-hit')) return;
  if (state.mode === 'fix') {
    const p = pointAt(e);
    const da = Math.hypot(p.x - state.station.x, p.y - state.station.y);
    const db = Math.hypot(p.x - state.stationB.x, p.y - state.stationB.y);
    if (Math.min(da, db) > 2.4) return;
    dragging = da < db ? state.station : state.stationB;
    svg.setPointerCapture(e.pointerId);
    return;
  }
  const p = pointAt(e);
  const dx = p.x - state.station.x, dy = p.y - state.station.y;
  if (Math.hypot(dx, dy) < 0.6) return;
  dragging = 'needle';
  svg.setPointerCapture(e.pointerId);
  setNeedle((Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360);
});
svg.addEventListener('pointermove', e => {
  if (!dragging) return;
  const p = pointAt(e);
  if (dragging === 'needle') {
    const dx = p.x - state.station.x, dy = p.y - state.station.y;
    if (Math.hypot(dx, dy) >= 0.6) setNeedle((Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360);
  } else {
    dragging.x = p.x; dragging.y = p.y; clampStation(dragging); render();
  }
});
const drop = () => { dragging = null; };
svg.addEventListener('pointerup', drop);
svg.addEventListener('pointercancel', drop);

svg.addEventListener('keydown', e => {
  if (state.mode !== 'sweep') return;
  const d = e.shiftKey ? 5 : 1;
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { setNeedle(state.needle + d); e.preventDefault(); }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { setNeedle(state.needle - d); e.preventDefault(); }
});

let gating = false;
function gateFromEvent(e) {
  const peak = lobePeak(state.readings);
  if (!peak) return;
  const r = chart.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height * 84;
  const level = Math.max(0, Math.min(1, (CH_TOP - y) / CH_SCALE));
  state.gateFrac = Math.max(0.05, Math.min(0.95, level / Math.max(1e-6, peak.level)));
  render();
}
chart.addEventListener('pointerdown', e => {
  if (state.mode !== 'sweep' || state.committed !== null) return;
  gating = true; chart.setPointerCapture(e.pointerId); gateFromEvent(e);
});
chart.addEventListener('pointermove', e => { if (gating) gateFromEvent(e); });
chart.addEventListener('pointerup', () => { gating = false; });
chart.addEventListener('pointercancel', () => { gating = false; });
chart.addEventListener('keydown', e => {
  if (state.mode !== 'sweep' || state.committed !== null) return;
  const d = (e.shiftKey ? 0.10 : 0.02);
  if (e.key === 'ArrowUp') { state.gateFrac = Math.min(0.95, state.gateFrac + d); e.preventDefault(); render(); }
  if (e.key === 'ArrowDown') { state.gateFrac = Math.max(0.05, state.gateFrac - d); e.preventDefault(); render(); }
});

$('tabSweep').addEventListener('click', () => { state.mode = 'sweep'; render(); });
$('tabFix').addEventListener('click', () => { state.mode = 'fix'; render(); });

/* ---- rooms ----------------------------------------------------------
   The controller is Phase 3. Until it answers, every path here fails
   honestly rather than pretending: no button lies about what it does. */

async function post(action, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${API}?action=${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: ctrl.signal
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { ok: false, status: 0, body: null };   /* 0 means the network died */
  } finally { clearTimeout(timer); }
}

function refuse(key) {
  const n = $('notice');
  n.textContent = t(key);
  n.classList.add('on');
  say(t(key));
}

async function enterRoom(action) {
  const name = cleanName($('name').value);
  if (!isValidName(name)) return refuse('refuse.badName');
  const payload = { name };
  if (action === 'join') {
    const code = normalizeCode($('code').value);
    if (!isValidCode(code)) return refuse('refuse.badCode');
    payload.code = code;
  }
  const res = await post(action, payload);
  if (res.status === 0) return refuse('refuse.network');
  if (!res.ok) return refuse('refuse.' + ((res.body && res.body.reason) || 'network'));
  seat(res.body);
}

$('goPlay').addEventListener('click', () => {
  $('paths').style.display = 'none';
  $('roomPanel').classList.add('on');
  $('name').focus();
});
$('backFromRoom').addEventListener('click', () => {
  $('roomPanel').classList.remove('on');
  $('notice').classList.remove('on');
  $('paths').style.display = '';
});
$('goTrain').addEventListener('click', () => { location.hash = '#/practice'; });
$('create').addEventListener('click', () => enterRoom('create'));
$('join').addEventListener('click', () => enterRoom('join'));
$('code').addEventListener('input', e => { e.target.value = normalizeCode(e.target.value); });

/* ---- boot ----------------------------------------------------------- */

function seat(body) {
  saveSession({ code: body.code, token: body.token, id: body.you.id, seat: body.you.seat });
  $('notice').classList.remove('on');
  room.cursor = 0; room.failures = 0;
  location.hash = '#/night';
  schedulePoll(0);
}

/** Resume: a poll from cursor zero replays the whole room in one request. */
async function resume() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('bearing:session') || 'null'); } catch { saved = null; }
  const fromUrl = normalizeCode(new URLSearchParams(location.search).get('room') || '');
  if (!saved) {
    if (isValidCode(fromUrl)) { $('code').value = fromUrl; $('goPlay').click(); }
    return false;
  }
  room.session = saved; room.cursor = 0;
  const res = await post('poll', { code: saved.code, token: saved.token, since: 0 });
  if (!res.ok) { dropSession(null); return false; }
  absorb(res.body);
  schedulePoll(600);
  return true;
}

loadStrings().then(async () => {
  const stored = localStorage.getItem('bearing:name');
  if (stored) $('name').value = stored;
  $('name').addEventListener('change', () => localStorage.setItem('bearing:name', cleanName($('name').value)));
  if (!(await resume())) route();
});

export { pollDelay };   /* referenced by Phase 3; kept exported so it is not dropped */

/* =====================================================================
   THE NIGHT
   Transport and rendering only. Every fact below arrived in a poll; the
   client decides nothing except which intent to post and where to draw
   what came back.
   ===================================================================== */

const nsvg = $('nsvg'), nchart = $('nchart'), dsvg = $('dsvg');
const SEAT_LETTER = { 1: 'A', 2: 'B' };

const room = {
  session: null,          // {code, token, id, seat}
  snap: null,             // the last poll's room/you/partner/collars/terrain
  cursor: 0, failures: 0, timer: null, busy: false,
  mode: 'sweep',          // sweep | move | log
  collar: 'F2',
  pendingCell: null,      // the cell tapped but not yet committed
  trace: null,            // {collar, seat, from, samples[]} the recorder is holding
  gateFrac: 0.5,
  posted: false,
  rays: [], fixes: [], report: null, dawnTruth: null
};

function saveSession(s) {
  room.session = s;
  localStorage.setItem('bearing:session', JSON.stringify(s));
  history.replaceState(null, '', '?room=' + s.code);   // the code, never the token
}
function dropSession(msg) {
  localStorage.removeItem('bearing:session');
  room.session = null; room.snap = null; room.cursor = 0;
  clearTimeout(room.timer);
  history.replaceState(null, '', location.pathname);
  location.hash = '';
  if (msg) refuse(msg);
}

/* ---- the poll loop ---- */

function schedulePoll(ms) {
  clearTimeout(room.timer);
  room.timer = setTimeout(pollOnce, ms);
}
async function pollOnce() {
  if (!room.session || room.busy) return;
  room.busy = true;
  const res = await post('poll', {
    code: room.session.code, token: room.session.token, since: room.cursor
  });
  room.busy = false;
  if (res.status === 404) return dropSession('refuse.noRoom');
  if (res.status === 401) return dropSession('refuse.seatTaken');
  if (!res.ok || !res.body) {
    room.failures++;
    return schedulePoll(pollDelay({ failures: room.failures }));
  }
  room.failures = 0;
  absorb(res.body);
  const waiting = room.snap && room.snap.you &&
    room.snap.you.committed === room.snap.room.cycle &&
    room.snap.partner && room.snap.partner.committed !== room.snap.room.cycle;
  schedulePoll(res.body.more ? 30 : pollDelay({
    status: room.snap.room.status, hidden: document.hidden, waiting
  }));
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) schedulePoll(0); });

function absorb(body) {
  room.snap = body;
  room.cursor = body.last;
  for (const e of body.events) {
    const d = e.data || {};
    switch (e.type) {
      case 'dusk':
        room.rays = []; room.fixes = []; room.report = null;
        room.trace = null; room.posted = false; room.pendingCell = null;
        break;
      case 'trace':
        // only the station that swept holds the recorder tape
        if (e.by === room.session.id) {
          room.trace = { collar: d.collar, from: d.from, samples: d.trace.map(v => v / 1000) };
          room.gateFrac = 0.5; room.posted = false;
        }
        break;
      case 'bearing':
        room.rays.push({ collar: d.collar, deg: d.deg, sigma: d.sigma, from: d.from, seat: d.seat });
        break;
      case 'fix':
        room.fixes.push({ collar: d.collar, at: d.at, grade: d.grade, seat: d.seat });
        break;
      case 'dawn':
        room.report = d; room.dawnTruth = d.truth || null;
        break;
      /* unknown types are ignored on purpose, and still advance the cursor,
         so an older client never desyncs against a newer server */
    }
  }
  if (body.room.status === 'dawn') {
    if (location.hash !== '#/dawn') location.hash = '#/dawn'; else renderDawn();
  } else {
    if (location.hash !== '#/night') location.hash = '#/night'; else renderNight();
  }
}

/* ---- drawing the plate ---- */

function nightPlate(target, opts) {
  clear(target);
  const s = room.snap;
  if (!s) return;
  const defs = el('defs', {}), cp = el('clipPath', { id: 'nclip' });
  cp.appendChild(el('rect', { x: PAD - STEP / 2, y: PAD - STEP / 2,
    width: VB - 2 * PAD + STEP, height: VB - 2 * PAD + STEP }));
  defs.appendChild(cp); target.appendChild(defs);

  for (let k = 0; k < N; k += 8) {
    target.appendChild(el('line', { class: 'grat', x1: cellX(k), y1: PAD, x2: cellX(k), y2: VB - PAD }));
    target.appendChild(el('line', { class: 'grat', x1: PAD, y1: cellX(k), x2: VB - PAD, y2: cellX(k) }));
  }
  const terrain = s.terrain || '';
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const ch = terrain[y * N + x];
    if (ch === '.' || ch === undefined) {
      // ground this seat has not walked: present, but not described
      target.appendChild(el('circle', { class: 'unwalked', cx: cellX(x), cy: cellX(y), r: 0.9 }));
    } else {
      const v = Number(ch) / 9;
      target.appendChild(el('circle', { class: 'cell', cx: cellX(x), cy: cellX(y),
        r: (0.5 + v * 1.9).toFixed(2), 'fill-opacity': (0.28 + v * 0.6).toFixed(2) }));
    }
  }

  if (opts && opts.reach && s.you) {
    /* the walk limit has to be visible, or the only way to learn it is to
       be refused by the server after you have already chosen a cell */
    const px = s.you.pos % N, py = Math.floor(s.you.pos / N);
    for (let y = Math.max(0, py - MOVE_MAX); y <= Math.min(N - 1, py + MOVE_MAX); y++) {
      for (let x = Math.max(0, px - MOVE_MAX); x <= Math.min(N - 1, px + MOVE_MAX); x++) {
        target.appendChild(el('circle', { class: 'reach', cx: cellX(x), cy: cellX(y), r: 1.5 }));
      }
    }
  }
  const marks = el('g', { 'clip-path': 'url(#nclip)' });
  for (const r of room.rays) {
    const [fx, fy] = [cellX(r.from % N), cellX(Math.floor(r.from / N))];
    const far = alongBearing({ x: fx, y: fy }, r.deg, VB * 1.6);
    const half = Math.min(40, (r.sigma || 2) * 2);
    const p1 = polar(fx, fy, r.deg - half, VB * 1.6), p2 = polar(fx, fy, r.deg + half, VB * 1.6);
    marks.appendChild(el('polygon', { class: 'wedge', points: `${fx},${fy} ${p1.x},${p1.y} ${p2.x},${p2.y}` }));
    marks.appendChild(el('line', { class: 'ray' + (r.seat === 2 ? ' b' : ''), x1: fx, y1: fy, x2: far.x, y2: far.y }));
  }
  target.appendChild(marks);

  for (const f of room.fixes) {
    const [fx, fy] = [cellX(f.at % N), cellX(Math.floor(f.at / N))];
    target.appendChild(el('circle', { class: 'fix-mark ' + f.grade, cx: fx, cy: fy, r: 4.5 }));
    target.appendChild(el('line', { class: 'fix-mark ' + f.grade, x1: fx - 6.5, y1: fy, x2: fx + 6.5, y2: fy }));
    target.appendChild(el('line', { class: 'fix-mark ' + f.grade, x1: fx, y1: fy - 6.5, x2: fx, y2: fy + 6.5 }));
  }

  if (opts && opts.pending !== null && opts.pending !== undefined) {
    const [px, py] = [cellX(opts.pending % N), cellX(Math.floor(opts.pending / N))];
    target.appendChild(el('circle', { class: 'pending-mark', cx: px, cy: py, r: 6 }));
    const me = s.you;
    if (room.mode === 'move') {
      const [ax, ay] = [cellX(me.pos % N), cellX(Math.floor(me.pos / N))];
      target.appendChild(el('line', { class: 'pending', x1: ax, y1: ay, x2: px, y2: py }));
    }
  }

  if (room.dawnTruth) {
    for (const [collar, at] of Object.entries(room.dawnTruth)) {
      const [tx, ty] = [cellX(at % N), cellX(Math.floor(at / N))];
      target.appendChild(el('circle', { class: 'den-mark', cx: tx, cy: ty, r: 7 }));
      const lab = el('text', { class: 'stn-label', x: tx + 10, y: ty + 4 });
      lab.textContent = collar; target.appendChild(lab);
    }
  }

  if (s.partner) stationMark(target, { x: s.partner.pos % N, y: Math.floor(s.partner.pos / N) },
                             SEAT_LETTER[s.partner.seat], null);
  if (s.you) stationMark(target, { x: s.you.pos % N, y: Math.floor(s.you.pos / N) },
                         SEAT_LETTER[s.you.seat], null);
}

/* ---- the title block ---- */

function dutyLabel(c) {
  if (c.duty === 0) return t('night.gone');
  if (c.fast) return t('night.fast');
  return c.duty === 1 ? t('night.every') : t('night.alternate');
}
function transmitting(c, cycle) { return c.duty > 0 && (cycle % c.duty) === c.phase; }

/* A poll lands every second or two. Rebuilding the title block each time
   throws away whatever the player had focused and can swallow a tap that
   landed mid-render, so redraw only when something a person can see has
   actually changed. */
function nightSignature() {
  const s = room.snap;
  if (!s) return '';
  return [s.room.cycle, s.room.status, s.you.committed, s.you.pos, s.you.fixes,
          s.partner ? s.partner.committed : -2, s.partner ? s.partner.pos : -2,
          room.mode, room.collar, room.pendingCell, room.gateFrac.toFixed(3),
          room.posted, room.trace ? room.trace.collar : '-', room.rays.length,
          room.fixes.length].join('|');
}
let lastNightSig = null;

function renderNight(force) {
  const sig = nightSignature();
  if (!force && sig === lastNightSig) return;
  lastNightSig = sig;
  renderNightNow();
}

function renderNightNow() {
  const s = room.snap;
  if (!s) return;
  const cycle = s.room.cycle;
  const mine = s.you.committed === cycle;

  $('brief').textContent = t('brief.' + s.room.brief, { collar: s.room.collar });
  nightPlate(nsvg, { pending: room.pendingCell, reach: room.mode === 'move' && !mine });

  // the recorder holds whatever this station last swept
  if (room.trace) {
    nchart.style.display = '';
    state.readings = room.trace.samples; state.borrowed = true;
    state.needle = 0; state.committed = null; state.gateFrac = room.gateFrac;
    drawChartInto(nchart);
  } else {
    nchart.style.display = 'none';
  }

  const read = room.trace ? currentReading() : null;
  $('nreadout').dataset.pos = String(s.you.pos);
  $('nreadout').innerHTML =
    `<div class="big">${cycle + 1}<span class="deg">/${s.room.cycles}</span></div>`
    + `<div class="meta">${t('night.cycle').toUpperCase()}</div>`
    + (read && read.bearing != null
        ? `<div class="meta">${String(Math.round(read.bearing)).padStart(3, '0')}&deg; <b${read.sigma > 3 ? ' class="bad"' : ''}>&plusmn;${read.sigma.toFixed(1)}</b></div>`
        : '')
    + metaBlock(t('dawn.fixes'), s.you.fixes);

  $('roster').innerHTML = (s.collars || []).map(c => {
    const on = transmitting(c, cycle);
    return `<button class="collar${on ? '' : ' silent'}${c.fast ? ' fast' : ''}" data-collar="${c.collar}"
      aria-pressed="${room.collar === c.collar}">
      <b>${c.collar}</b><small>${on ? dutyLabel(c) : t('night.silent')}</small></button>`;
  }).join('');
  $('roster').querySelectorAll('.collar').forEach(b => {
    b.addEventListener('click', () => { room.collar = b.dataset.collar; renderNight(true); });
  });

  $('ntabs').innerHTML = ['sweep', 'move', 'log'].map(m =>
    `<button class="tab" role="tab" data-mode="${m}" aria-selected="${room.mode === m}">${t('night.' + m)}</button>`
  ).join('');
  $('ntabs').querySelectorAll('.tab').forEach(b => {
    b.addEventListener('click', () => { room.mode = b.dataset.mode; room.pendingCell = null; renderNight(true); });
  });

  if (mine) {
    $('nacts').innerHTML = `<div class="waiting">${t('night.waiting', { name: (s.partner && s.partner.name) || '...' })}</div>`;
  } else {
    const ready = room.mode === 'sweep' ? true : room.pendingCell !== null;
    $('nacts').innerHTML =
      `<button class="btn btn--fill" id="commitCycle"${ready ? '' : ' disabled'}>${t('night.commit')}</button>`
      + (read && read.bearing != null && !room.posted
          ? `<button class="btn narrow" id="postRead">${t('night.post')}</button>` : '');
    const cc = $('commitCycle');
    if (cc) cc.addEventListener('click', commitCycle);
    const pr = $('postRead');
    if (pr) pr.addEventListener('click', postReading);
  }

  $('nhelp').textContent = mine ? ''
    : room.mode === 'move' ? t('night.helpMove')
    : room.mode === 'log' ? t('night.helpLog')
    : (room.trace ? t('night.traceFrom', { seat: SEAT_LETTER[s.you.seat] }) : t('night.pickSweep'));
}

/* the practice chart draws into #chart; the night needs the same picture in
   its own well, so the one drawing routine takes a target */
function drawChartInto(target) {
  const keep = chart.innerHTML;
  drawChart();
  target.innerHTML = chart.innerHTML;
  chart.innerHTML = keep;
}

async function commitCycle() {
  const s = room.snap;
  const action = room.mode === 'sweep'
    ? { kind: 'sweep', collar: room.collar }
    : room.mode === 'move'
      ? { kind: 'move', at: room.pendingCell }
      : { kind: 'log', collar: room.collar, at: room.pendingCell };
  const res = await post('commit', { code: s.room.code, token: room.session.token, action });
  if (!res.ok) return refuse('refuse.' + ((res.body && res.body.reason) || 'network'));
  room.pendingCell = null;
  schedulePoll(0);
}

async function postReading() {
  const read = currentReading();
  if (!read || read.bearing == null || !room.trace) return;
  const res = await post('read', {
    code: room.snap.room.code, token: room.session.token,
    collar: room.trace.collar, deg: read.bearing, sigma: read.sigma || 2
  });
  if (!res.ok) return refuse('refuse.' + ((res.body && res.body.reason) || 'network'));
  room.posted = true;
  schedulePoll(0);
}

/* ---- night input ---- */

function cellFromEvent(target, e) {
  const r = target.getBoundingClientRect();
  const x = Math.round(((e.clientX - r.left) / r.width * VB - PAD) / STEP);
  const y = Math.round(((e.clientY - r.top) / r.height * VB - PAD) / STEP);
  if (x < 0 || y < 0 || x >= N || y >= N) return null;
  return y * N + x;
}
nsvg.addEventListener('click', e => {
  if (!room.snap || room.snap.you.committed === room.snap.room.cycle) return;
  if (room.mode === 'sweep') return;
  const cell = cellFromEvent(nsvg, e);
  if (cell === null) return;
  if (room.mode === 'move' && !withinWalk(room.snap.you.pos, cell, N)) return refuse('refuse.tooFar');
  room.pendingCell = cell;
  renderNight(true);
});
nchart.addEventListener('pointerdown', e => {
  if (!room.trace) return;
  const peak = lobePeak(room.trace.samples);
  if (!peak) return;
  const r = nchart.getBoundingClientRect();
  const level = Math.max(0, Math.min(1, (CH_TOP - (e.clientY - r.top) / r.height * 84) / CH_SCALE));
  room.gateFrac = Math.max(0.05, Math.min(0.95, level / Math.max(1e-6, peak.level)));
  state.gateFrac = room.gateFrac;
  renderNight(true);
});
nchart.addEventListener('keydown', e => {
  if (!room.trace) return;
  const d = e.shiftKey ? 0.10 : 0.02;
  if (e.key === 'ArrowUp') { room.gateFrac = Math.min(0.95, room.gateFrac + d); e.preventDefault(); }
  else if (e.key === 'ArrowDown') { room.gateFrac = Math.max(0.05, room.gateFrac - d); e.preventDefault(); }
  else return;
  state.gateFrac = room.gateFrac; renderNight(true);
});

/* ---- dawn ---- */

function renderDawn() {
  const r = room.report;
  nightPlate(dsvg, {});
  if (!r) return;
  $('dawnCap').textContent = t('dawn.title').toUpperCase() + ' · ' + t('brief.' + r.brief, { collar: r.collar });
  $('dreadout').innerHTML =
    `<div class="big">${r.tight}<span class="deg">/${r.fixes}</span></div>`
    + `<div class="meta">${t('dawn.tight').toUpperCase()}</div>`
    + `<div class="meta"><b${r.answered ? '' : ' class="bad"'}>${r.answered ? t('dawn.answered') : t('dawn.missed')}</b></div>`;
  $('dhelp').textContent = t('dawn.' + r.grade);
  $('againBtn').textContent = t('dawn.again');
  $('leaveBtn').textContent = t('dawn.leave');
}
$('againBtn').addEventListener('click', async () => {
  await post('again', { code: room.session.code, token: room.session.token });
  schedulePoll(0);
});
$('leaveBtn').addEventListener('click', async () => {
  await post('leave', { code: room.session.code, token: room.session.token });
  dropSession(null);
});
