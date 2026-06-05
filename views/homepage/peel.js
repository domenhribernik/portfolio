(function () {
    'use strict';

    // ============================================================
    //  PEEL CONFIG — the three knobs you can tweak.
    // ============================================================
    var PEEL_CONFIG = {
        // 1) ON / OFF. Master switch for the whole book-flip effect.
        //    false -> the homepage scrolls as plain normal flow (exactly the
        //    same as the touch / reduced-motion fallback): nothing flips,
        //    nothing is pinned. true -> the page-flip is active on desktop.
        enabled: false,

        // 2) ANIMATION SPEED. How long (in milliseconds) a page takes to finish
        //    flipping once the transition triggers and snaps into place.
        //    Lower = faster / snappier flip. Higher = slower, more deliberate.
        flipDurationMs: 380,

        // 3) TRANSITION STRENGTH. How far you keep scrolling past the bottom of
        //    a section before its page flips away, as a fraction of screen
        //    height. 0.4 = about 40% of a screen of extra scroll.
        //    Smaller = hair-trigger (flips almost as soon as you hit the bottom).
        //    Larger  = you have to push further before it flips.
        scrollToTrigger: 1.2,
    };

    // Off, or on a touch / reduced-motion device -> no peel, plain scrolling.
    if (!PEEL_CONFIG.enabled) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (window.matchMedia('(hover: none), (pointer: coarse)').matches) return;

    // (internal) Once a downward peel passes this fraction it commits to the
    // next section instead of settling back. Tiny, so a small nudge flips.
    var SNAP_FORWARD_AT = 0.04;

    function init() {
        var html  = document.documentElement;
        var book  = document.querySelector('.book');
        var stage = document.querySelector('.book__stage');
        if (!book || !stage) return;

        var leaves = Array.from(book.querySelectorAll('.leaf'));
        if (!leaves.length) return;

        html.classList.add('peel-on');

        // Static z-index: first leaf on top, last on bottom
        leaves.forEach(function (leaf, i) {
            leaf.style.zIndex = leaves.length - i;
        });

        var leafData = [];

        function measure() {
            var vh = window.innerHeight;
            var cumulative = 0;
            leafData = leaves.map(function (leaf, i) {
                var inner    = leaf.querySelector('.leaf__inner');
                var contentH = inner ? inner.scrollHeight : vh;
                var readDist = Math.max(0, contentH - vh);
                // Last leaf has no peel phase — it just gets read (contact + footer)
                var peelDist = i < leaves.length - 1 ? PEEL_CONFIG.scrollToTrigger * vh : 0;
                var runway   = readDist + peelDist;
                var start    = cumulative;
                cumulative  += runway;
                return { leaf: leaf, inner: inner, readDist: readDist, peelDist: peelDist, runway: runway, start: start };
            });
            // Total book height = one viewport (to see the last leaf) + all runways
            book.style.height = (vh + cumulative) + 'px';
        }

        function bookTop() {
            // Recompute each call so it stays accurate after layout shifts
            return book.getBoundingClientRect().top + window.scrollY;
        }

        function tick() {
            var scrolled = window.scrollY - bookTop();

            leafData.forEach(function (d) {
                var local  = scrolled - d.start;
                var readPx = 0;
                var peel   = 0;

                if (local > 0) {
                    if (local >= d.runway) {
                        readPx = d.readDist;
                        peel   = d.peelDist > 0 ? 1 : 0;
                    } else {
                        readPx = d.readDist > 0 ? Math.min(d.readDist, local) : 0;
                        var afterRead = Math.max(0, local - d.readDist);
                        peel = d.peelDist > 0 ? Math.min(1, afterRead / d.peelDist) : 0;
                    }
                }

                d.leaf.style.setProperty('--peel', peel);
                if (d.inner) d.inner.style.setProperty('--read-px', readPx);
            });
        }

        // ---- Scroll snapping ----------------------------------------------
        // A half-turned page is an unstable place to stop. When scrolling
        // settles inside a peel slice, glide to the nearest stable state:
        // back to the fully-shown current section, or forward to the next one.
        // This is the "you get locked, then the next section shows" behaviour.
        var snapping = false;
        var prevY = window.scrollY;
        var dir = 1; // 1 = scrolling down, -1 = scrolling up

        function animateScrollTo(target) {
            var startY = window.scrollY;
            var dist   = target - startY;
            if (Math.abs(dist) < 1) return;
            // Scale the glide to flipDurationMs: a full peel takes flipDurationMs,
            // shorter snaps take proportionally less (min 120ms so it never lags).
            var peelPx = window.innerHeight * PEEL_CONFIG.scrollToTrigger || window.innerHeight;
            var frac   = Math.min(1, Math.abs(dist) / peelPx);
            var dur    = Math.max(120, PEEL_CONFIG.flipDurationMs * frac);
            var t0     = null;
            snapping = true;
            function step(now) {
                if (t0 === null) t0 = now;
                var p = Math.min(1, (now - t0) / dur);
                var e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // easeInOutQuad
                window.scrollTo(0, startY + dist * e);
                if (p < 1) {
                    requestAnimationFrame(step);
                } else {
                    snapping = false;
                    prevY = window.scrollY;
                }
            }
            requestAnimationFrame(step);
        }

        function maybeSnap() {
            if (snapping) return;
            var top      = bookTop();
            var scrolled = window.scrollY - top;
            for (var i = 0; i < leafData.length; i++) {
                var d = leafData[i];
                if (d.peelDist <= 0) continue;
                var local = scrolled - d.start;
                // Only the peel slice is unstable; any reading position is fine
                if (local <= d.readDist || local >= d.runway) continue;
                var peel    = (local - d.readDist) / d.peelDist;
                var backY   = top + d.start + d.readDist; // peel = 0 (this section, fully shown)
                var fwdY    = top + d.start + d.runway;   // peel = 1 (next section, fully shown)
                var forward = dir >= 0 ? peel > SNAP_FORWARD_AT : peel > (1 - SNAP_FORWARD_AT);
                animateScrollTo(forward ? fwdY : backY);
                return;
            }
        }

        // rAF-throttled scroll handler; snap fires once scrolling settles
        var rafPending = false;
        var snapTimer  = null;
        window.addEventListener('scroll', function () {
            var y = window.scrollY;
            if (y > prevY) dir = 1; else if (y < prevY) dir = -1;
            prevY = y;

            if (!rafPending) {
                rafPending = true;
                requestAnimationFrame(function () {
                    rafPending = false;
                    tick();
                });
            }

            if (snapping) return;
            if (snapTimer) clearTimeout(snapTimer);
            snapTimer = setTimeout(maybeSnap, 90);
        }, { passive: true });

        // Anchor click override — capture phase fires before the navbar's bubbling handler,
        // so we can redirect the scroll to the correct runway start position.
        document.addEventListener('click', function (e) {
            if (!document.documentElement.classList.contains('peel-on')) return;
            var anchor = e.target.closest('a[href^="#"]');
            if (!anchor) return;

            e.preventDefault();
            e.stopImmediatePropagation();

            var hash     = anchor.getAttribute('href');
            var targetEl = document.querySelector(hash);
            if (!targetEl) return;

            // Find the leaf that contains (or is) the anchor target
            var leafEl = targetEl.classList.contains('leaf')
                ? targetEl
                : targetEl.closest('.leaf');
            var idx = leafEl ? leaves.indexOf(leafEl) : -1;

            var scrollY = idx >= 0
                ? bookTop() + leafData[idx].start
                : targetEl.getBoundingClientRect().top + window.scrollY;

            animateScrollTo(scrollY);
        }, true /* capture */);

        // Re-measure when APOD image loads, Show-More expands, or viewport resizes
        var ro = new ResizeObserver(function () { measure(); tick(); });
        leaves.forEach(function (leaf) {
            var inner = leaf.querySelector('.leaf__inner');
            if (inner) ro.observe(inner);
        });
        window.addEventListener('resize', function () { measure(); tick(); }, { passive: true });

        measure();
        tick();
    }

    // Defer until the loader hands off (html.intro-done), so we don't measure mid-intro
    var html = document.documentElement;
    if (html.classList.contains('intro-done')) {
        init();
    } else {
        var mo = new MutationObserver(function (_, obs) {
            if (html.classList.contains('intro-done')) {
                obs.disconnect();
                init();
            }
        });
        mo.observe(html, { attributeFilter: ['class'] });
        // Hard fallback: if the loader never fires intro-done, init on window load
        window.addEventListener('load', function () {
            if (!html.classList.contains('peel-on')) init();
        });
    }
})();
