/* ============================================================
   Intro controller for the homepage.

   A fast kinetic-poster opening (~2.3s): a slot reel rolls through
   greetings in the site's translate languages on an ink field, the
   name stamps in set exactly like the hero headline, the ink lifts
   off in staggered column wipes, and the name FLIP-travels from
   center stage into the hero title's real position before handing
   off to the actual letters 1:1.

   Contract with the rest of the page (same as the old loader):
   html.preload is set by the inline head script before first paint
   and html.intro-done is added here at the reveal (peel.js watches
   for it). New here: html.intro-morph and html.intro-landed manage
   the hero title letters around the hand-off; both stay on <html>
   permanently, see intro.css. The head script's failsafe still
   covers the case where this file never runs; we clear it on
   takeover and arm our own instead.

   Pairs with views/homepage/intro.css.
   ============================================================ */
(function () {
    var root = document.documentElement;
    var intro = document.getElementById('introOverlay');
    if (!intro) return;

    clearTimeout(window.__introFailsafe);

    /* ============================================================
       SPEED KNOB: one multiplier for the whole intro's pace.
       1 is the designed pace (about 2.3s end to end), 1.5 runs 50%
       slower, 0.8 runs 20% quicker. It scales the beat sheet below
       and, through the --intro-speed CSS variable, every
       choreography transition in intro.css, so the beats and their
       animations always stay in step. The reduced-motion path is
       deliberately not affected.
       ============================================================ */
    var SPEED = 1;

    root.style.setProperty('--intro-speed', SPEED);

    var reel = document.getElementById('introReel');
    var indexEl = document.getElementById('introIndex');
    var barEl = document.getElementById('introBar');
    var nameEl = document.getElementById('introName');

    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var finished = false;

    function pad(n) {
        return n < 10 ? '0' + n : '' + n;
    }

    function reveal() {
        root.classList.remove('preload');
        root.classList.add('intro-done');
    }

    function forceFinish() {
        if (finished) return;
        finished = true;
        reveal();
        root.classList.add('intro-landed');
        intro.setAttribute('hidden', '');
    }

    // Belt and braces: if anything below stalls, still hand the page over.
    setTimeout(forceFinish, 4000 + 2850 * SPEED);

    /* ---- Reduced motion: calm static card, quick fade, no theatrics ---- */
    if (reduceMotion) {
        intro.classList.add('is-on', 'is-calm');
        setTimeout(function () {
            reveal();
            intro.classList.add('is-done');
        }, 750);
        setTimeout(function () {
            finished = true;
            intro.setAttribute('hidden', '');
        }, 1300);
        return;
    }

    /* ---- Full sequence. Beat sheet in ms from sequence start,
       everything scaled by the SPEED knob at the top of this file. ---- */
    var STEP_AT = [340, 540, 740, 920].map(function (t) { return t * SPEED; });
    // reel advances above (5 greetings, 4 steps)
    var NAME_AT = 1180 * SPEED;         // reel out, name stamps in
    var WIPE_AT = 1420 * SPEED;         // ink columns lift, hero fades in below
    var TRAVEL_AT = 1580 * SPEED;       // name starts its flight to the hero slot
    var LAND_AT = 2200 * SPEED;         // name docks, hero letters take over
    var HIDE_AT = 2850 * SPEED;         // overlay leaves the document

    // Park the hero title letters now so the traveling name has an
    // exact, unanimated target to dock onto at LAND_AT.
    root.classList.add('intro-morph');

    // Wait for the display face so the reel and the FLIP metrics are
    // measured against the real glyphs, capped so a slow font CDN can
    // never stall the intro.
    var fontsReady = (document.fonts && document.fonts.ready)
        ? Promise.race([
            document.fonts.ready,
            new Promise(function (resolve) { setTimeout(resolve, 900); })
        ])
        : Promise.resolve();

    fontsReady.then(function () {
        if (finished) return;

        intro.classList.add('is-on');

        // The progress hairline runs exactly until the wipe.
        if (barEl) {
            requestAnimationFrame(function () {
                barEl.style.transition = 'transform ' + WIPE_AT + 'ms linear';
                barEl.style.transform = 'scaleX(1)';
            });
        }

        STEP_AT.forEach(function (at, i) {
            setTimeout(function () {
                // Words are 1.3em tall (see intro.css), one word per step.
                if (reel) reel.style.transform = 'translateY(' + (-(i + 1) * 1.3) + 'em)';
                if (indexEl) indexEl.textContent = pad(i + 2);
            }, at);
        });

        setTimeout(function () {
            intro.classList.add('is-name');
            if (indexEl) indexEl.textContent = '06';
        }, NAME_AT);

        setTimeout(function () {
            intro.classList.add('is-wipe');
            // Hero fades in beneath the lifting columns; peel.js arms on this.
            // preload stays on until landing so the page cannot scroll (or
            // start its eyebrow/sub/cta entrances) under the traveling name.
            root.classList.add('intro-done');
        }, WIPE_AT);

        setTimeout(travel, TRAVEL_AT);

        setTimeout(function () {
            root.classList.remove('preload');
            root.classList.add('intro-landed'); // hero letters pop in under the name
            intro.classList.add('is-done');     // then the traveling copy fades away
        }, LAND_AT);

        setTimeout(function () {
            finished = true;
            intro.setAttribute('hidden', '');
        }, HIDE_AT);
    });

    // FLIP: measure where the hero headline actually sits and glide the
    // centered name onto it. Both ends share font, size and tracking
    // (see intro.css), so a translate plus a hair of scale lines the
    // glyphs up 1:1. Everything is measured off boxes that never
    // transform: the name's rise spans are still settling when this
    // runs, and the <h1> is a block whose own rect is container width,
    // not text width, so position comes from the first line blocks and
    // width from the second (widest) line's letter spans against the
    // name container, which shrink-wraps to that same widest line.
    function travel() {
        if (finished || !nameEl) return;

        var heroLines = document.querySelectorAll('#home .kinetic-title .kinetic-line');
        if (heroLines.length < 2) return; // fall back to fading out in place

        var chs = heroLines[1].querySelectorAll('.ch');
        if (!chs.length) return;

        var from = nameEl.getBoundingClientRect();
        var to = heroLines[0].getBoundingClientRect();
        var chFirst = chs[0].getBoundingClientRect();
        var chLast = chs[chs.length - 1].getBoundingClientRect();

        var scale = (chLast.right - chFirst.left) / from.width;
        if (!isFinite(scale) || scale < 0.5 || scale > 2) scale = 1;

        intro.classList.add('is-travel');
        nameEl.style.transform =
            'translate3d(' + (to.left - from.left) + 'px,' + (to.top - from.top) + 'px,0)' +
            ' scale(' + scale + ')';
    }
})();
