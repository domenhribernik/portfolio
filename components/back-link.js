// Wires the anchor with id="back-link" (a view's back arrow) so it returns
// to wherever the user came from on this site (e.g. the Dashboard launcher)
// instead of always following its hardcoded href. The href stays as the
// fallback for direct visits and cross-origin referrers, so the arrow still
// leads to the homepage when there is nothing to go back to.
(() => {
    const wire = () => {
        const link = document.getElementById('back-link');
        if (!link) return;
        link.addEventListener('click', (e) => {
            let sameOrigin = false;
            try {
                sameOrigin = new URL(document.referrer).origin === location.origin;
            } catch { /* no referrer */ }
            if (sameOrigin && history.length > 1) {
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
