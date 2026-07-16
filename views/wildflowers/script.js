/* script.js : page wiring for Wild Flowers.
   Boots the renderer, grows a bouquet or a meadow, and drives the stage
   controls (orbit drag, bloom slider, wind, x-ray wireframe, shadows, spin,
   density) plus the live HUD (fps, draw calls, triangles). All scene
   construction lives in petals-gl.js; all math in logic.js. */

import * as THREE from 'three';
import {
  uniforms, createWorld, buildBouquet, buildMeadow, disposeGroup, setWireframe,
} from './petals-gl.js';
import {
  PRESETS, MEADOW_STEPS, SPECIES, surpriseOrder, fpsStats, fmtCount, clamp,
} from './logic.js';
import { easeOutCubic, renderTier } from '../flowers/logic.js';

const sceneEl = document.getElementById('scene');
const canvas = document.getElementById('gl-canvas');
const bootLabel = document.getElementById('boot-label');
const fallbackEl = document.getElementById('gl-fallback');

const showFallback = () => {
  bootLabel?.remove();
  fallbackEl?.classList.remove('hidden');
  canvas?.remove();
};

/* ==========================================================================
   Boot. Anything that throws here (no WebGL, blocked CDN) folds the page
   back to a graceful "kept it analog" card instead of a black hero.
   ========================================================================== */

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch {
  showFallback();
  throw new Error('WebGL unavailable');
}
window.__wf_boot = true;

renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(new THREE.Color('#0b100c'));

const scene = new THREE.Scene();
const world = createWorld(scene);
const camera = new THREE.PerspectiveCamera(36, 2, 5, 8000);

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const tier = renderTier({ coarse: matchMedia('(pointer: coarse)').matches });

/* ==========================================================================
   State
   ========================================================================== */

const CAMS = {
  bouquet: { target: new THREE.Vector3(0, 152, 0), dist: 590, pitch: 8, pitchMin: 1, pitchMax: 46 },
  meadow: { target: new THREE.Vector3(0, 55, 0), dist: 1140, pitch: 15, pitchMin: 3, pitchMax: 40 },
};

let mode = 'bouquet';
let order = PRESETS[0].order;
let density = tier === 'lite' ? MEADOW_STEPS[0] : MEADOW_STEPS[1];
let built = null;

let spin = !reducedMotion;
let wind = !reducedMotion;
let xray = false;
let shadows = tier !== 'lite';

let yaw = 26;
let pitch = CAMS.bouquet.pitch;
let dist = CAMS.bouquet.dist;
let camTarget = CAMS.bouquet.target.clone();

renderer.shadowMap.enabled = shadows;

function pixelRatio() {
  const base = Math.min(devicePixelRatio || 1, tier === 'lite' ? 1.75 : 2);
  return mode === 'meadow' && density >= 2200 ? Math.min(base, 1.5) : base;
}

/* ==========================================================================
   Growing and regrowing
   ========================================================================== */

let bloomToken = 0;
let bloomAnim = null;

function regrow(duration = 2400) {
  const token = ++bloomToken;
  if (reducedMotion) {
    uniforms.uBloom.value = 1;
    syncBloomSlider();
    return;
  }
  uniforms.uBloom.value = 0;
  bloomAnim = { token, t0: performance.now(), duration };
}

function refreshShadows() {
  scene.traverse((o) => {
    if (o.material) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
    }
  });
}

function rebuild({ bloom = true } = {}) {
  if (built) {
    scene.remove(built.group);
    disposeGroup(built.group);
  }
  built = mode === 'bouquet'
    ? buildBouquet(order, { tier })
    : buildMeadow(density, { tier: 'lite' });
  scene.add(built.group);
  if (xray) setWireframe(built.group, true);

  world.setShadowRange(mode === 'bouquet' ? 340 : 1450);
  scene.fog.near = mode === 'bouquet' ? 1400 : 620;
  scene.fog.far = mode === 'bouquet' ? 3600 : 3100;
  renderer.setPixelRatio(pixelRatio());

  const cam = CAMS[mode];
  dist = cam.dist;
  pitch = clamp(pitch, cam.pitchMin, cam.pitchMax);

  updateStaticHud();
  if (bloom) regrow();
}

/* ==========================================================================
   HUD
   ========================================================================== */

const hudFps = document.getElementById('hud-fps');
const hudCalls = document.getElementById('hud-calls');
const hudTris = document.getElementById('hud-tris');
const equivLine = document.getElementById('equiv-line');

function updateStaticHud() {
  const { stems, instances, cssPlanes } = built.stats;
  for (const el of document.querySelectorAll('[data-instance-count]')) {
    el.textContent = fmtCount(instances);
  }
  for (const el of document.querySelectorAll('[data-stem-count]')) {
    el.textContent = fmtCount(stems);
  }
  if (equivLine) {
    equivLine.textContent = mode === 'bouquet'
      ? `the paper version spends ≈${fmtCount(cssPlanes)} divs on this exact bouquet`
      : `≈${fmtCount(cssPlanes)} planes if you tried this with divs; the paper stall caps out near 520`;
  }
}

const frameMs = [];
let lastHud = 0;

function updateLiveHud(now) {
  if (now - lastHud < 500) return;
  lastHud = now;
  const { fps, low } = fpsStats(frameMs.slice(-180));
  if (hudFps) hudFps.textContent = `${Math.round(fps)} fps · 1% low ${Math.round(low)}`;
  if (hudCalls) hudCalls.textContent = fmtCount(renderer.info.render.calls);
  if (hudTris) hudTris.textContent = fmtCount(renderer.info.render.triangles);
}

/* ==========================================================================
   Orbit: drag to turn, matching the paper page's feel. On touch only the
   yaw responds, so vertical swipes still scroll the page (touch-action:
   pan-y in style.css).
   ========================================================================== */

let dragging = false;
let last = null;
let vy = 0;

sceneEl.addEventListener('pointerdown', (e) => {
  if (e.target.closest('a, button')) return;
  dragging = true;
  vy = 0;
  last = { x: e.clientX, y: e.clientY };
  sceneEl.classList.add('grabbing');
  sceneEl.setPointerCapture(e.pointerId);
});

sceneEl.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - last.x;
  const dy = e.clientY - last.y;
  last = { x: e.clientX, y: e.clientY };
  yaw -= dx * 0.4;
  if (e.pointerType !== 'touch') {
    const cam = CAMS[mode];
    pitch = clamp(pitch + dy * 0.25, cam.pitchMin, cam.pitchMax);
  }
  vy = -dx * 0.4;
});

function release() {
  dragging = false;
  sceneEl.classList.remove('grabbing');
}
sceneEl.addEventListener('pointerup', release);
sceneEl.addEventListener('pointercancel', release);

/* ==========================================================================
   The frame loop
   ========================================================================== */

let visible = true;
if ('IntersectionObserver' in window) {
  new IntersectionObserver((entries) => {
    for (const e of entries) visible = e.isIntersecting;
  }).observe(sceneEl);
}

function fit() {
  const w = sceneEl.clientWidth;
  const h = sceneEl.clientHeight;
  camera.aspect = w / h;
  /* Tall phone viewports widen the lens so the bouquet is not cropped. */
  camera.fov = camera.aspect < 0.8 ? 46 : 36;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
addEventListener('resize', fit);

const bloomSlider = document.getElementById('bloom-slider');
function syncBloomSlider() {
  bloomSlider.value = String(Math.round(uniforms.uBloom.value * 100));
}

let lastT = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  if (!visible || document.hidden) {
    lastT = now;
    return;
  }
  const dt = Math.min(0.1, (now - lastT) / 1000);
  frameMs.push(now - lastT);
  if (frameMs.length > 300) frameMs.splice(0, frameMs.length - 300);
  lastT = now;

  uniforms.uTime.value += dt;

  /* Wind eases toward its target so toggling feels like weather, not a switch. */
  const windGoal = wind ? (mode === 'meadow' ? 1 : 0.22) : 0;
  uniforms.uWind.value += (windGoal - uniforms.uWind.value) * Math.min(1, dt * 2.5);

  if (bloomAnim && bloomAnim.token === bloomToken) {
    const t = Math.min(1, (now - bloomAnim.t0) / bloomAnim.duration);
    uniforms.uBloom.value = easeOutCubic(t);
    syncBloomSlider();
    if (t >= 1) bloomAnim = null;
  }

  if (spin && !dragging) yaw += dt * (360 / 80);
  if (!dragging && Math.abs(vy) > 0.05) {
    yaw += vy;
    vy *= 0.94;
  }

  const goal = CAMS[mode];
  camTarget.lerp(goal.target, Math.min(1, dt * 4));
  const p = pitch * (Math.PI / 180);
  const y = yaw * (Math.PI / 180);
  camera.position.set(
    camTarget.x + dist * Math.cos(p) * Math.sin(y),
    camTarget.y + dist * Math.sin(p),
    camTarget.z + dist * Math.cos(p) * Math.cos(y),
  );
  camera.lookAt(camTarget);

  renderer.render(scene, camera);
  updateLiveHud(now);
}

/* ==========================================================================
   Controls
   ========================================================================== */

const modeBtns = {
  bouquet: document.getElementById('mode-bouquet'),
  meadow: document.getElementById('mode-meadow'),
};
const densityWrap = document.getElementById('density-wrap');
const densitySlider = document.getElementById('density-slider');
const densityValue = document.getElementById('density-value');

function setMode(next) {
  if (mode === next) return;
  mode = next;
  for (const [key, btn] of Object.entries(modeBtns)) {
    btn.setAttribute('aria-pressed', String(key === mode));
  }
  densityWrap.classList.toggle('hidden', mode !== 'meadow');
  rebuild();
}

modeBtns.bouquet.addEventListener('click', () => setMode('bouquet'));
modeBtns.meadow.addEventListener('click', () => setMode('meadow'));

function syncDensity() {
  densitySlider.value = String(density);
  densityValue.textContent = fmtCount(density);
}
let densityTimer = 0;
densitySlider.addEventListener('input', () => {
  density = Number(densitySlider.value);
  densityValue.textContent = fmtCount(density);
  clearTimeout(densityTimer);
  densityTimer = setTimeout(() => {
    if (mode === 'meadow') rebuild({ bloom: false });
    uniforms.uBloom.value = 1;
    syncBloomSlider();
  }, 260);
});
syncDensity();

bloomSlider.addEventListener('input', () => {
  bloomToken += 1;
  bloomAnim = null;
  uniforms.uBloom.value = Number(bloomSlider.value) / 100;
});

function wireToggle(id, get, set) {
  const btn = document.getElementById(id);
  btn.setAttribute('aria-pressed', String(get()));
  btn.addEventListener('click', () => {
    set(!get());
    btn.setAttribute('aria-pressed', String(get()));
  });
  return btn;
}

wireToggle('wind-toggle', () => wind, (v) => { wind = v; });
wireToggle('xray-toggle', () => xray, (v) => {
  xray = v;
  if (built) setWireframe(built.group, xray);
});
wireToggle('shadow-toggle', () => shadows, (v) => {
  shadows = v;
  renderer.shadowMap.enabled = shadows;
  refreshShadows();
});
const spinBtn = wireToggle('spin-toggle', () => spin, (v) => { spin = v; });
spinBtn.querySelector('span').textContent = spin ? 'still' : 'spin';
spinBtn.addEventListener('click', () => {
  spinBtn.querySelector('span').textContent = spin ? 'still' : 'spin';
});

/* ==========================================================================
   The counter: preset arrangements, the surprise, the field densities.
   ========================================================================== */

const presetGrid = document.getElementById('preset-grid');
const speciesLabel = (type) => SPECIES.find((s) => s.key === type)?.label.toLowerCase() ?? type;

for (const preset of PRESETS) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'preset-card border border-hairline rounded-md bg-moss/50 p-5 text-left flex flex-col gap-2 transition-colors hover:border-corn/50';
  card.innerHTML = `
    <span class="font-display italic text-2xl leading-none">${preset.label}</span>
    <span class="font-mono text-[0.6rem] tracking-[0.18em] uppercase text-sage/60">${preset.note}</span>
    <span class="mt-auto pt-3 font-mono text-[0.72rem] text-sage leading-relaxed">${
      preset.order.map((o) => `${o.count} ${speciesLabel(o.type)}`).join(' · ')
    }</span>
    <span class="font-mono text-[0.62rem] tracking-[0.25em] uppercase text-corn">grow it &rarr;</span>`;
  card.addEventListener('click', () => {
    order = preset.order;
    if (mode !== 'bouquet') setMode('bouquet');
    else rebuild();
    sceneEl.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
  });
  presetGrid.appendChild(card);
}

document.getElementById('surprise-btn').addEventListener('click', () => {
  order = surpriseOrder();
  if (mode !== 'bouquet') setMode('bouquet');
  else rebuild();
  sceneEl.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
});

for (const btn of document.querySelectorAll('[data-density]')) {
  btn.addEventListener('click', () => {
    density = Number(btn.dataset.density);
    syncDensity();
    if (mode !== 'meadow') setMode('meadow');
    else rebuild({ bloom: true });
    sceneEl.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
  });
}

/* ==========================================================================
   Grow.
   ========================================================================== */

fit();
rebuild();
bootLabel?.remove();
requestAnimationFrame(frame);

/* Handy for headless verification and curious consoles. */
window.__wf = { renderer, scene, camera, uniforms, get built() { return built; } };
