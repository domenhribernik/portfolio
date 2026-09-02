// Wires the anchor with id="back-link" (a view's back arrow) so it returns to
// the previous screen rather than always following its hardcoded href.
//
// Two levels, checked in that order:
//
//   1. Screens inside this view. A hash-routed page (tells' `#/t/strawman`,
//      beseda's `#topic/x`) is several screens in one document, and the arrow
//      has to walk those back before it leaves the page at all. Otherwise
//      opening a plate and pressing back throws the reader out to the homepage.
//   2. How the visitor got here. Same-origin referrer (the Dashboard, the
//      projects index) means back should return there.
//
// The href stays the fallback for a direct visit or a cross-origin referrer,
// so the arrow still leads to the homepage when there is nothing to go back to.
//
// Depth is stamped into history.state rather than read off history.length,
// which counts the whole tab and says nothing about this document: a visitor
// who arrived after five other pages must still not be able to "go back"
// out of a plate they opened directly.
(() => {
    const DEPTH = '__backLinkDepth';

    const depthOf = (state) =>
        (state && typeof state[DEPTH] === 'number') ? state[DEPTH] : null;

    const stamp = (value) => {
        try {
            history.replaceState({ ...history.state, [DEPTH]: value }, '');
        } catch { /* replaceState can throw on file:// in some browsers */ }
    };

    // The entry we booted on is depth zero, whatever hash it carries. Landing
    // straight on a deep link means that screen is where this visit started,
    // so back means leave.
    let depth = depthOf(history.state) ?? 0;
    stamp(depth);

    window.addEventListener('hashchange', () => {
        // A screen the visitor just opened arrives with null state (the browser
        // does not copy it forward), so it is unstamped and deepens the trail.
        // A stamped entry is one we have already seen: the visitor moved back
        // or forward through it, and it carries its own depth.
        const seen = depthOf(history.state);
        if (seen !== null) { depth = seen; return; }
        depth += 1;
        stamp(depth);
    });

    const cameFromThisSite = () => {
        try {
            return new URL(document.referrer).origin === location.origin;
        } catch {
            return false; // no referrer, or one that will not parse
        }
    };

    const wire = () => {
        const link = document.getElementById('back-link');
        if (!link) return;
        link.addEventListener('click', (e) => {
            if (depth > 0 || (cameFromThisSite() && history.length > 1)) {
                e.preventDefault();
                history.back();
            }
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    } else {
        wire();
    }
})();
