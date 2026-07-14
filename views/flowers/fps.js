/* fps.js : a tiny opt-in on-screen frame meter, mounted only when the page
   URL carries ?fps=1. Lets the owner sanity-check rotation smoothness on a
   real phone (the headless CPU-throttled traces are only the desktop proxy).
   Because it is dynamically imported behind that query check, nothing here is
   fetched unless asked, so it never weighs on the bloom cold open. */
export function mount() {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:9999;pointer-events:none;' +
    'font:12px/1.35 ui-monospace,Menlo,monospace;color:#8fe36f;' +
    'background:rgba(0,0,0,0.62);padding:4px 7px;border-radius:5px;white-space:pre;';
  document.body.appendChild(el);

  let frames = 0;
  let acc = 0;
  let last = performance.now();
  (function loop(now) {
    frames += 1;
    acc += now - last;
    last = now;
    if (acc >= 500) {
      const fps = Math.round((frames * 1000) / acc);
      const ms = (acc / frames).toFixed(1);
      el.textContent = `${fps} fps\n${ms} ms/frame`;
      frames = 0;
      acc = 0;
    }
    requestAnimationFrame(loop);
  })(last);
}
