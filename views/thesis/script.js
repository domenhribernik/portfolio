window.addEventListener('DOMContentLoaded', () => {
    const yearEl = document.getElementById('currentYear');
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    //? Scroll reveal (gate hidden state on JS so content stays visible if this script never runs)
    document.body.classList.add('reveals-on');

    const revealObserver = new IntersectionObserver((entries, obs) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
                obs.unobserve(entry.target);
            }
        });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));
});

//? Hide the loading overlay once everything (fonts, video) has settled
window.addEventListener('load', () => {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.classList.add('hidden');
});
