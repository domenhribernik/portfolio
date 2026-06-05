/* ============================================================
   Loader controller for the homepage intro.

   Drives the percentage counter, the rising clay name-fill (a wavy
   clip-path recomputed each frame), the progress bar, and the cycling
   letterpress status line. Progress eases on a timeline so it's always
   seen (MIN_DURATION) but never finishes before the page has actually
   loaded; once both are true it snaps to 100% and hands off to the CSS
   reveal by toggling html.preload -> html.intro-done.

   Pairs with views/homepage/loader.css. The inline head script arms
   `html.preload` before first paint and sets a failsafe in case this
   file never runs; we clear that failsafe on takeover.
   ============================================================ */
(function () {
    var root = document.documentElement;
    var loader = document.getElementById('loadingOverlay');
    if (!loader) return;

    clearTimeout(window.__introFailsafe);

    var countEl = document.getElementById('knCount');
    var barEl = document.getElementById('knBar');
    var statusEl = document.getElementById('knStatus');
    var nameFill = loader.querySelector('.kn-loader__name-layer--fill');

    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var MIN_DURATION = reduceMotion ? 400 : 2200; // ms — long enough to enjoy the fill

    // Wavy waterline: the clay fill rises to height `progress` with a gentle
    // sine surface that drifts sideways (phase) so it ripples like liquid ink.
    var WAVES = 3;      // crests across the name's width
    var AMP = 3;        // amplitude, % of the name box height
    var SPEED = 0.16;   // phase advance per frame
    var STEP = 4;       // sample the curve every STEP% of the width
    var phase = 0;

    function fillClip(p) {
        if (reduceMotion) return 'inset(' + (100 - p) + '% 0 0 0)';
        var top = 100 - p; // waterline measured from the top, in %
        var pts = [];
        for (var x = 0; x <= 100; x += STEP) {
            var y = top + AMP * Math.sin((x / 100) * WAVES * Math.PI * 2 + phase);
            y = y < 0 ? 0 : (y > 100 ? 100 : y);
            pts.push(x + '% ' + y.toFixed(2) + '%');
        }
        pts.push('100% 100%', '0% 100%');
        return 'polygon(' + pts.join(',') + ')';
    }

    function applyFill(p) {
        if (!nameFill) return;
        var clip = fillClip(p);
        nameFill.style.clipPath = clip;
        nameFill.style.webkitClipPath = clip;
    }

    // Letterpress stages, swapped in as progress crosses each threshold.
    var STAGES = [
        { at: 0,  text: 'Setting the type' },
        { at: 32, text: 'Mixing the inks' },
        { at: 64, text: 'Pulling a proof' },
        { at: 90, text: 'Almost ready' }
    ];
    var stageIdx = -1;

    var pageLoaded = document.readyState === 'complete';
    if (!pageLoaded) {
        window.addEventListener('load', function () { pageLoaded = true; });
    }

    var progress = 0;
    var startTs = performance.now();
    var done = false;

    function pad(n) {
        n = Math.round(n);
        return n < 10 ? '0' + n : '' + n;
    }

    function swapStatus(text) {
        if (!statusEl) return;
        statusEl.style.opacity = '0';
        setTimeout(function () {
            statusEl.textContent = text;
            statusEl.style.opacity = '';
        }, 170);
    }

    function render(p) {
        progress = p < 0 ? 0 : (p > 100 ? 100 : p);
        if (countEl) countEl.textContent = pad(progress);
        if (barEl) barEl.style.width = progress + '%';
        applyFill(progress);

        for (var i = STAGES.length - 1; i >= 0; i--) {
            if (progress >= STAGES[i].at) {
                if (i !== stageIdx) {
                    stageIdx = i;
                    swapStatus(STAGES[i].text);
                }
                break;
            }
        }
    }

    function tick(now) {
        if (done) return;

        phase += SPEED;
        var elapsed = now - startTs;
        var minReached = elapsed >= MIN_DURATION;
        var canFinish = pageLoaded && minReached;

        // Target tracks elapsed time, but stalls at 94% until the page
        // is actually ready so we never flash 100% before content exists.
        var timeTarget = (elapsed / MIN_DURATION) * 100;
        var target = canFinish ? 100 : Math.min(94, timeTarget);

        var next = progress + (target - progress) * 0.09 + 0.18;
        if (!canFinish && next > 94) next = 94;
        render(next);

        if (canFinish && progress >= 99.4) {
            render(100);
            finish();
            return;
        }
        requestAnimationFrame(tick);
    }

    function finish() {
        if (done) return;
        done = true;
        // Brief hold so 100% and the fully inked name register before we leave.
        setTimeout(reveal, reduceMotion ? 90 : 280);
    }

    function reveal() {
        root.classList.remove('preload');
        root.classList.add('intro-done');
        // Pull the overlay out of the document once its transition is done.
        setTimeout(function () { loader.setAttribute('hidden', ''); }, 1200);
    }

    requestAnimationFrame(tick);
})();
