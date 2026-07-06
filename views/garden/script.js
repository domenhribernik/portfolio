/* script.js : page wiring for the Paper Garden.
   Grows the bouquet, runs the entrance bloom, and drives the three
   controls (orbit drag, bloom slider, x-ray toggle). */

import { buildBouquet } from './flowers.js';
import { clamp, easeOutCubic } from './logic.js';

const scene = document.getElementById('scene');
const stage = document.getElementById('stage');
const bouquetRoot = document.getElementById('bouquet-root');
const bloomSlider = document.getElementById('bloom-slider');
const xrayToggle = document.getElementById('xray-toggle');
const spinToggle = document.getElementById('spin-toggle');

const stats = buildBouquet(bouquetRoot);
for (const el of document.querySelectorAll('[data-plane-count]')) {
  el.textContent = stats.planes;
}

/* Scale the bouquet to the scene height. */
function fit() {
  const s = clamp(Math.min(scene.clientHeight / 520, scene.clientWidth / 560), 0.68, 1.5);
  bouquetRoot.style.setProperty('--s', s.toFixed(3));
  bouquetRoot.style.setProperty('--y', scene.clientWidth < 640 ? '48px' : '0px');
}
fit();
addEventListener('resize', fit);

/* Entrance: bloom from bud to full flower once, unless the visitor
   prefers reduced motion or grabs the slider first. */
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let entranceDone = reducedMotion;

function setBloom(v) {
  stage.style.setProperty('--bloom', v);
  bloomSlider.value = String(Math.round(v * 100));
}

if (entranceDone) {
  setBloom(1);
} else {
  setBloom(0);
  const t0 = performance.now();
  const DURATION = 2600;
  (function grow(now) {
    if (entranceDone) return;
    const t = Math.min(1, (now - t0) / DURATION);
    setBloom(easeOutCubic(t));
    if (t < 1) requestAnimationFrame(grow);
    else entranceDone = true;
  })(t0);
}

bloomSlider.addEventListener('input', () => {
  entranceDone = true;
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
