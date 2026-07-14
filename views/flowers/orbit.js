/* orbit.js : drag-to-turn for a c3d stage, shared by the flowers builder,
   the share page, and the bloom hero (which each used to carry their own
   near-identical copy). Two things matter for performance here:

   - Pointer moves are coalesced into ONE rAF write per frame. A 120Hz touch
     digitizer fires several moves per frame, and every write to --ry/--rx
     invalidates the whole preserve-3d scene, so writing per-event did the
     scene's expensive re-sort several times a frame.
   - Horizontal-only mode (axes: 'x') leaves vertical swipes to scroll the
     page, for the share and bloom pages whose scene sits in a scrolling
     document (touch-action: pan-y).

   Also exports pauseOffscreen: pause the scene's animations while it is
   scrolled out of view, so an idle bouquet never taxes the rest of the page. */

export function attachOrbit(scene, stage, opts = {}) {
  const {
    axes = 'both',
    ry0 = 0,
    rx0 = -10,
    rxMin = -42,
    rxMax = 14,
    sensX = 0.4,
    sensY = 0.25,
    inertia = true,
  } = opts;
  const useRx = axes !== 'x';

  let ry = ry0;
  let rx = rx0;
  let vy = 0;
  let dragging = false;
  let last = null;
  let raf = 0;
  let coasting = 0;

  const clampRx = (v) => Math.min(rxMax, Math.max(rxMin, v));

  function write() {
    raf = 0;
    stage.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
    if (useRx) stage.style.setProperty('--rx', `${rx.toFixed(2)}deg`);
  }
  function schedule() {
    if (!raf) raf = requestAnimationFrame(write);
  }

  // Initial pose (rx is written once even in horizontal-only mode).
  stage.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
  stage.style.setProperty('--rx', `${rx.toFixed(2)}deg`);

  scene.addEventListener('pointerdown', (e) => {
    dragging = true;
    vy = 0;
    if (coasting) {
      cancelAnimationFrame(coasting);
      coasting = 0;
    }
    last = { x: e.clientX, y: e.clientY };
    scene.classList.add('grabbing');
    scene.setPointerCapture(e.pointerId);
  });

  scene.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    last = { x: e.clientX, y: e.clientY };
    ry += dx * sensX;
    if (useRx) rx = clampRx(rx - dy * sensY);
    vy = dx * sensX;
    schedule();
  });

  function release() {
    if (!dragging) return;
    dragging = false;
    scene.classList.remove('grabbing');
    if (!inertia) return;
    (function coast() {
      if (dragging || Math.abs(vy) < 0.05) {
        coasting = 0;
        return;
      }
      ry += vy;
      vy *= 0.94;
      write();
      coasting = requestAnimationFrame(coast);
    })();
  }
  scene.addEventListener('pointerup', release);
  scene.addEventListener('pointercancel', release);
}

/* Toggle a class on the scene while it is off screen, so CSS can pause the
   autospin and sway (a bouquet nobody is looking at should not repaint every
   frame and steal the main thread from the rest of the page). Silently does
   nothing where IntersectionObserver is unavailable. */
export function pauseOffscreen(scene, cls = 'offstage') {
  if (typeof IntersectionObserver === 'undefined') return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) scene.classList.toggle(cls, !entry.isIntersecting);
    },
    { threshold: 0 },
  );
  io.observe(scene);
}
