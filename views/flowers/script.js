/* script.js : page wiring for Paper Flowers.
   Renders the flower stall menu, grows the bouquet from the visitor's
   order, replays the bloom on every generate, and drives the stage
   controls (orbit drag, bloom slider, x-ray toggle, spin toggle). */

import { buildBouquet, countPlanes, FLOWER_TYPES, DEFAULT_ORDER, MAX_STEMS } from './flowers.js';
import { clamp, easeOutCubic, orderTotal, stepCount, surpriseCounts } from './logic.js';

const scene = document.getElementById('scene');
const stage = document.getElementById('stage');
const bouquetRoot = document.getElementById('bouquet-root');
const bloomSlider = document.getElementById('bloom-slider');
const xrayToggle = document.getElementById('xray-toggle');
const spinToggle = document.getElementById('spin-toggle');
const menuEl = document.getElementById('flower-menu');
const stemTotalEl = document.getElementById('stem-total');
const planeEstimateEl = document.getElementById('plane-estimate');
const stallNoteEl = document.getElementById('stall-note');
const generateBtn = document.getElementById('generate-btn');
const surpriseBtn = document.getElementById('surprise-btn');

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ==========================================================================
   The order: how many of each species, seeded from the default bouquet.
   ========================================================================== */

let counts = Object.fromEntries(FLOWER_TYPES.map((t) => [t.key, 0]));
for (const { type, count } of DEFAULT_ORDER) counts[type] = count;

const currentOrder = () =>
  FLOWER_TYPES.map((t) => ({ type: t.key, count: counts[t.key] }))
    .filter((o) => o.count > 0);

/* ==========================================================================
   Growing and regrowing
   ========================================================================== */

function updatePlaneCounts(planes) {
  for (const el of document.querySelectorAll('[data-plane-count]')) {
    el.textContent = planes;
  }
}

function setBloom(v) {
  stage.style.setProperty('--bloom', v);
  bloomSlider.value = String(Math.round(v * 100));
}

/* Animate --bloom 0 -> 1. The token cancels a running growth when the
   visitor generates again or grabs the slider mid-bloom. */
let growToken = 0;

function regrow(duration = 1900) {
  const token = ++growToken;
  if (reducedMotion) {
    setBloom(1);
    return;
  }
  setBloom(0);
  const t0 = performance.now();
  (function step(now) {
    if (token !== growToken) return;
    const t = Math.min(1, (now - t0) / duration);
    setBloom(easeOutCubic(t));
    if (t < 1) requestAnimationFrame(step);
  })(t0);
  /* rAF can stall (backgrounded tab, frame throttling); make sure the
     bloom always lands fully open unless something else took over. */
  setTimeout(() => {
    if (token === growToken) setBloom(1);
  }, duration + 150);
}

function generate({ scroll = false, duration = 1900 } = {}) {
  bouquetRoot.innerHTML = '';
  const stats = buildBouquet(bouquetRoot, currentOrder());
  updatePlaneCounts(stats.planes);
  regrow(duration);
  if (scroll) scene.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
}

generate({ duration: 2600 });

/* ==========================================================================
   The stall menu: one card per species, live preview, stepper.
   ========================================================================== */

const STEP_BTN =
  'step-btn w-8 h-8 rounded-full border border-hairline text-sage font-mono text-base leading-none ' +
  'hover:text-cream hover:border-cream/40 disabled:opacity-30 disabled:cursor-not-allowed ' +
  'disabled:hover:text-sage disabled:hover:border-hairline transition-colors';

for (const def of FLOWER_TYPES) {
  const card = document.createElement('article');
  card.className = 'flower-card border border-hairline rounded-md bg-moss/50 p-4 flex flex-col';
  card.dataset.type = def.key;
  card.innerHTML = `
    <div class="menu-scene c3d-scene" style="--bloom:1">
      <div class="c3d" style="--rx:-12deg">
        <div class="c3d menu-spin">
          <div class="c3d preview-seat" style="--s:${def.preview.s};--y:${def.preview.y}px"></div>
        </div>
      </div>
    </div>
    <div class="flex items-baseline justify-between gap-2 mt-3">
      <h3 class="font-display italic text-xl leading-none">${def.label}</h3>
      <span class="font-mono text-[0.6rem] tracking-[0.18em] uppercase text-sage/60">${def.latin}</span>
    </div>
    <div class="flex items-center justify-between mt-3">
      <span class="flex gap-1.5">
        ${def.variants.map((v) => `<span class="swatch ${v}" title="${v.split('--')[1]}"></span>`).join('')}
      </span>
      <div class="flex items-center gap-2.5">
        <button type="button" class="${STEP_BTN}" data-step="-1" aria-label="One ${def.label.toLowerCase()} less">&minus;</button>
        <span class="count font-mono text-sm text-cream min-w-[1.2em] text-center" aria-live="polite">0</span>
        <button type="button" class="${STEP_BTN}" data-step="1" aria-label="One ${def.label.toLowerCase()} more">+</button>
      </div>
    </div>`;
  def.build(card.querySelector('.preview-seat'), def.variants[0], 0);
  card.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-step]');
    if (!btn) return;
    const next = stepCount(counts, def.key, Number(btn.dataset.step));
    if (next === counts) return;
    counts = next;
    syncMenu();
  });
  menuEl.appendChild(card);
}

function syncMenu() {
  const total = orderTotal(counts);
  const full = total >= MAX_STEMS;
  for (const card of menuEl.children) {
    const n = counts[card.dataset.type];
    card.querySelector('.count').textContent = n;
    card.classList.toggle('picked', n > 0);
    card.querySelector('[data-step="-1"]').disabled = n === 0;
    card.querySelector('[data-step="1"]').disabled = full;
  }
  stemTotalEl.textContent = total;
  planeEstimateEl.textContent = countPlanes(currentOrder());
  stallNoteEl.classList.toggle('hidden', !full);
  generateBtn.disabled = total === 0;
}
syncMenu();

generateBtn.addEventListener('click', () => generate({ scroll: true }));

surpriseBtn.addEventListener('click', () => {
  counts = surpriseCounts(FLOWER_TYPES.map((t) => t.key));
  syncMenu();
  generate({ scroll: true });
});

/* ==========================================================================
   Stage controls
   ========================================================================== */

bloomSlider.addEventListener('input', () => {
  growToken += 1;
  stage.style.setProperty('--bloom', String(bloomSlider.value / 100));
});

xrayToggle.addEventListener('click', () => {
  const on = scene.classList.toggle('xray');
  xrayToggle.setAttribute('aria-pressed', String(on));
});

spinToggle.addEventListener('click', () => {
  const paused = scene.classList.toggle('spin-paused');
  spinToggle.setAttribute('aria-pressed', String(paused));
  spinToggle.querySelector('span').textContent = paused ? 'spin' : 'still';
});

/* Scale the bouquet to the scene height. */
function fit() {
  const s = clamp(Math.min(scene.clientHeight / 520, scene.clientWidth / 560), 0.68, 1.5);
  bouquetRoot.style.setProperty('--s', s.toFixed(3));
  bouquetRoot.style.setProperty('--y', scene.clientWidth < 640 ? '48px' : '0px');
}
fit();
addEventListener('resize', fit);

/* Orbit: drag to turn the stage, with a little inertia on release. */
let ry = 0;
let rx = -10;
let vy = 0;
let dragging = false;
let last = null;

function applyOrbit() {
  stage.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
  stage.style.setProperty('--rx', `${rx.toFixed(2)}deg`);
}
applyOrbit();

scene.addEventListener('pointerdown', (e) => {
  dragging = true;
  vy = 0;
  last = { x: e.clientX, y: e.clientY };
  scene.classList.add('grabbing');
  scene.setPointerCapture(e.pointerId);
});

scene.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - last.x;
  const dy = e.clientY - last.y;
  last = { x: e.clientX, y: e.clientY };
  ry += dx * 0.4;
  rx = clamp(rx - dy * 0.25, -42, 14);
  vy = dx * 0.4;
  applyOrbit();
});

function release() {
  if (!dragging) return;
  dragging = false;
  scene.classList.remove('grabbing');
  (function coast() {
    if (dragging || Math.abs(vy) < 0.05) return;
    ry += vy;
    vy *= 0.94;
    applyOrbit();
    requestAnimationFrame(coast);
  })();
}
scene.addEventListener('pointerup', release);
scene.addEventListener('pointercancel', release);
