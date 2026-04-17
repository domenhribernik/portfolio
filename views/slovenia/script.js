(() => {
    // Gallery
    const gallery = new Gallery({
        track: document.getElementById('galleryTrack'),
        prevBtn: document.getElementById('galleryPrev'),
        nextBtn: document.getElementById('galleryNext'),
        dotsContainer: document.getElementById('galleryDots'),
        options: {
            slidesPerView: { desktop: 3, tablet: 2, mobile: 1 },
            gap: 20,
            mobileGap: 12,
            mobilePeek: 60,
            infinite: true,
            autoplay: true,
            autoplayDelay: 5000,
        }
    });
    gallery.init();

    // Era tabs
    const tabs = document.querySelectorAll('.era-tab');
    const panels = document.querySelectorAll('.era-panel');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const era = tab.dataset.era;

            tabs.forEach(t => t.classList.remove('active'));
            panels.forEach(p => p.classList.remove('active'));

            tab.classList.add('active');
            document.getElementById(`era-${era}`).classList.add('active');

            tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        });
    });
})();
