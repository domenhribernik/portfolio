/* ============================================================
   Kinetic hero interactions: cursor-following blend blobs and
   magnetic buttons. Pure decoration, so everything degrades to
   the CSS idle-float fallback when there's no fine pointer or the
   visitor prefers reduced motion.
   ============================================================ */
(function () {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const finePointer = window.matchMedia('(pointer: fine)').matches;
    if (reduceMotion || !finePointer) return;

    const hero = document.querySelector('.kinetic-hero');
    const blobClay = document.querySelector('.kinetic-blob--clay');
    const blobCobalt = document.querySelector('.kinetic-blob--cobalt');

    if (hero && blobClay && blobCobalt) {
        // Start centred; lerp toward the pointer each frame.
        let targetX = window.innerWidth / 2;
        let targetY = window.innerHeight * 0.4;
        let clayX = targetX, clayY = targetY;
        let cobaltX = targetX, cobaltY = targetY;

        hero.classList.add('blobs-live');

        window.addEventListener('pointermove', (e) => {
            targetX = e.clientX;
            targetY = e.clientY;
        }, { passive: true });

        const tick = () => {
            clayX += (targetX - clayX) * 0.085;
            clayY += (targetY - clayY) * 0.085;
            cobaltX += (targetX - cobaltX) * 0.045;
            cobaltY += (targetY - cobaltY) * 0.045;
            blobClay.style.transform = `translate(${clayX}px, ${clayY}px) translate(-50%, -50%)`;
            blobCobalt.style.transform = `translate(${cobaltX}px, ${cobaltY}px) translate(-50%, -50%)`;
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    // Magnetic pull on tagged buttons.
    document.querySelectorAll('[data-magnetic]').forEach((el) => {
        const strength = 0.28;
        el.addEventListener('pointermove', (e) => {
            const rect = el.getBoundingClientRect();
            const x = (e.clientX - rect.left - rect.width / 2) * strength;
            const y = (e.clientY - rect.top - rect.height / 2) * strength;
            el.style.setProperty('--mag-x', `${x}px`);
            el.style.setProperty('--mag-y', `${y}px`);
            el.style.transform = `translate(${x}px, ${y}px)`;
        });
        el.addEventListener('pointerleave', () => {
            el.style.transform = '';
        });
    });
})();
