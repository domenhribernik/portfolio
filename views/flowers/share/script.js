/* views/flowers/share : opens a shared bouquet.
   The inline script in index.html already started fetching the bouquet
   (window.__bouquet) before this module graph loaded; here we validate
   the payload, show the sender's note, grow the bouquet with the same
   builder as the stall, and replay the bloom. Anything missing, expired
   or malformed wilts gracefully. */

import { buildBouquet, FLOWER_TYPES } from '../flowers.js';
import { clamp, easeOutCubic, normalizeShareOrder } from '../logic.js';

const scene = document.getElementById('scene');
const stage = document.getElementById('stage');
const bouquetRoot = document.getElementById('bouquet-root');
const kickerEl = document.getElementById('kicker');
const messageEl = document.getElementById('message');

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ==========================================================================
   Bloom: same rAF ramp as the builder page, with the same setTimeout
   fallback because rAF can stall in throttled or background tabs.
   ========================================================================== */

const setBloom = (v) => stage.style.setProperty('--bloom', v);

function bloom(duration = 2600) {
  if (reducedMotion) {
    setBloom(1);
    return;
  }
  let done = false;
  const t0 = performance.now();
  (function step(now) {
    if (done) return;
    const t = Math.min(1, (now - t0) / duration);
    setBloom(easeOutCubic(t));
    if (t < 1) requestAnimationFrame(step);
    else done = true;
  })(t0);
  setTimeout(() => {
    if (!done) {
      done = true;
      setBloom(1);
    }
  }, duration + 150);
}

/* Scale the bouquet to the scene, exactly like the builder page. */
function fit() {
  const s = clamp(Math.min(scene.clientHeight / 520, scene.clientWidth / 560), 0.68, 1.5);
  bouquetRoot.style.setProperty('--s', s.toFixed(3));
  bouquetRoot.style.setProperty('--y', scene.clientWidth < 640 ? '48px' : '0px');
}
addEventListener('resize', fit);

/* ==========================================================================
   Orbit: horizontal drag only, so vertical swipes keep scrolling the page
   (the scene allows touch-action: pan-y). A little inertia on release.
   ========================================================================== */

let ry = 0;
let vy = 0;
let dragging = false;
let lastX = 0;

function applyOrbit() {
  stage.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
}
stage.style.setProperty('--rx', '-10deg');

scene.addEventListener('pointerdown', (e) => {
  dragging = true;
  vy = 0;
  lastX = e.clientX;
  scene.classList.add('grabbing');
  scene.setPointerCapture(e.pointerId);
});

scene.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  lastX = e.clientX;
  ry += dx * 0.4;
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

/* ==========================================================================
   Load the bouquet
   ========================================================================== */

function wilt() {
  document.body.classList.add('wilted');
  kickerEl.textContent = 'these flowers have wilted';
  messageEl.textContent =
    'Share links bloom for seven days, and this one has faded. Pick a fresh bunch from the stall instead.';
  messageEl.hidden = false;
  messageEl.classList.add('reveal', 'reveal-2');
}

async function init() {
  try {
    const res = await window.__bouquet;
    if (!res || !res.ok) throw new Error('not found');
    const data = await res.json();
    const order = normalizeShareOrder(data?.order, FLOWER_TYPES.map((t) => t.key));
    if (!order.length) throw new Error('empty order');

    if (typeof data.message === 'string' && data.message.trim()) {
      messageEl.textContent = data.message.trim();
      messageEl.hidden = false;
      /* The reveal class goes on only once the text exists, so the
         entrance animates the note, not an empty box. */
      messageEl.classList.add('reveal', 'reveal-2');
    }

    buildBouquet(bouquetRoot, order);
    fit();
    bloom();
  } catch {
    wilt();
  }
}
init();
