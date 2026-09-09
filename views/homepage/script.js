window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('currentYear').textContent = new Date().getFullYear();

    //? The footer's cookie link. <site-footer> wires its own; this page hand
    //? rolls the legal line, so it wires this one too.
    document.getElementById('cookieSettings')?.addEventListener('click', () => {
        if (window.portfolioConsent) window.portfolioConsent.open();
        else window.location.href = 'views/privacy/#cookies';
    });

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
