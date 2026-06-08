(() => {
    const loadingOverlay = document.getElementById('loading-overlay');
    const currentDateEl = document.getElementById('current-date');

    const today = new Date();

    //? Masthead dateline + colophon details
    if (currentDateEl) {
        currentDateEl.textContent = today.toLocaleDateString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        });
    }

    const editionEl = document.getElementById('masthead-edition');
    if (editionEl) {
        editionEl.textContent = `${today.toLocaleDateString('en-US', { weekday: 'long' })} Edition`;
    }

    //? Day-of-year readout for the hero corner tag ("Day 158 / 365")
    const cornerEl = document.getElementById('hero-corner');
    if (cornerEl) {
        const startOfYear = new Date(today.getFullYear(), 0, 0);
        const dayOfYear = Math.floor((today - startOfYear) / 86400000);
        const isLeap = (y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)(today.getFullYear());
        cornerEl.textContent = `Day ${dayOfYear} / ${isLeap ? 366 : 365}`;
    }

    const yearEl = document.getElementById('currentYear');
    if (yearEl) yearEl.textContent = today.getFullYear();

    //? Scroll reveal (gate hidden state on JS so content stays visible if this never runs)
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

    //? Record tabs: show one category (events / births / deaths) at a time
    const recordTabs = document.querySelectorAll('.otd-tab');
    const recordPanels = document.querySelectorAll('.otd-panel');
    recordTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.target;
            recordTabs.forEach(t => {
                const on = t === tab;
                t.classList.toggle('is-active', on);
                t.setAttribute('aria-selected', String(on));
            });
            recordPanels.forEach(p => p.classList.toggle('is-active', p.dataset.panel === target));
        });
    });

    const stripHtml = (html) => {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        return tmp.textContent || tmp.innerText || '';
    };

    const getFirstImage = (pages) => {
        if (!pages || !Array.isArray(pages) || pages.length === 0) return null;
        const pageWithImage = pages.find(p => p.thumbnail?.source);
        return pageWithImage?.thumbnail?.source || null;
    };

    const getExtractHtml = (pages) => {
        if (!pages || !Array.isArray(pages) || pages.length === 0) return null;
        return pages[0]?.extract_html || null;
    };

    const getFirstPageUrl = (pages) => {
        if (!pages || !Array.isArray(pages) || pages.length === 0) return null;
        const page = pages[0];
        return page?.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${page?.title}`;
    };

    // ========================================
    // GALLERY INSTANCE
    // ========================================

    let featuredGallery = null;

    const initFeaturedGallery = () => {
        const track = document.getElementById('featured-track');
        const prevBtn = document.getElementById('gallery-prev');
        const nextBtn = document.getElementById('gallery-next');
        const dotsContainer = document.getElementById('featured-dots');

        if (!track) return;

        // Destroy existing gallery if any
        if (featuredGallery) {
            featuredGallery.destroy();
        }

        // Create new gallery instance
        featuredGallery = new Gallery({
            track: track,
            prevBtn: prevBtn,
            nextBtn: nextBtn,
            dotsContainer: dotsContainer,
            options: {
                slidesPerView: { desktop: 3, tablet: 2, mobile: 1 },
                gap: 16,
                mobileGap: 12,
                mobilePeek: 80,
                infinite: true,
                autoplay: false
            }
        });

        featuredGallery.init();
    };

    // ========================================
    // UI COMPONENTS
    // ========================================

    const createGallerySlide = (item, index, total) => {
        const article = document.createElement('article');
        article.className = 'gallery-slide';
        article.dataset.index = index;

        const year = item.year || '';
        const text = stripHtml(item.text || '');
        const imageUrl = getFirstImage(item.pages);
        const extractHtml = getExtractHtml(item.pages);
        const pageUrl = getFirstPageUrl(item.pages);

        const imageHtml = imageUrl ? `
            <div class="gallery-image">
                <img src="${imageUrl}" alt="${text.substring(0, 50)}" loading="lazy">
            </div>
        ` : `<div class="gallery-image gallery-image-placeholder"><span>📜</span></div>`;

        const extractHtml2 = extractHtml ? `<div class="gallery-extract">${extractHtml}</div>` : '';
        const linkHtml = pageUrl ? `
            <a href="${pageUrl}" target="_blank" rel="noopener" class="gallery-link">
                Read more
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
            </a>
        ` : '';

        article.innerHTML = `
            ${imageHtml}
            <div class="gallery-content">
                <div class="gallery-meta">
                    ${year ? `<span class="gallery-year">${year}</span>` : ''}
                    <span class="gallery-counter">${index + 1} / ${total}</span>
                </div>
                <h3 class="gallery-title">${text}</h3>
                ${extractHtml2}
                ${linkHtml}
            </div>
        `;

        return article;
    };

    const createCategoryItem = (item) => {
        const patterns = [
            /^([^,]+),\s*(.+)$/, /^([^:]+):\s*(.+)$/, /^(.+?\([^)]+\))\s*,?\s*(.+)$/,
        ];

        let title = '', description = '';
        const text = stripHtml(item.text || '');
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) { title = match[1].trim(); description = match[2].trim(); break; }
        }
        if (!title) { title = text; }

        const year = item.year || '';
        const pageUrl = getFirstPageUrl(item.pages);

        // The whole entry is the link when a Wikipedia page exists
        const el = document.createElement(pageUrl ? 'a' : 'div');
        el.className = 'otd-entry';
        if (pageUrl) { el.href = pageUrl; el.target = '_blank'; el.rel = 'noopener'; }

        const descHtml = description ? `<span class="otd-entry__desc">${description}</span>` : '';

        el.innerHTML = `
            <span class="otd-entry__year">${year || '—'}</span>
            <span class="otd-entry__body"><span class="otd-entry__title">${title}</span>${descHtml}</span>
        `;

        return el;
    };

    const createGalleryPlaceholder = () => {
        const div = document.createElement('div');
        div.className = 'gallery-slide loading';
        div.innerHTML = `
            <div class="gallery-image loading-block"></div>
            <div class="gallery-content">
                <div class="loading-line short" style="width: 60px; margin-bottom: 12px;"></div>
                <div class="loading-line" style="height: 20px; margin-bottom: 8px;"></div>
                <div class="loading-line" style="width: 90%;"></div>
            </div>
        `;
        return div;
    };

    const createCategoryPlaceholder = () => {
        const div = document.createElement('div');
        div.className = 'otd-entry loading';
        div.innerHTML = `
            <span class="otd-entry__year"><span class="loading-line" style="width: 2.2rem;"></span></span>
            <span class="otd-entry__body">
                <span class="loading-line"></span>
                <span class="loading-line"></span>
            </span>
        `;
        return div;
    };

    const showError = (container) => {
        container.innerHTML = `<div class="error-state"><span class="error-icon">⚠️</span><p>Unable to load data.</p></div>`;
    };

    const showEmpty = (container) => {
        container.innerHTML = `<div class="empty-state"><p>No entries available.</p></div>`;
    };

    // ========================================
    // DATA LOADING
    // ========================================

    const populateFeatured = (data) => {
        const track = document.getElementById('featured-track');
        const section = document.getElementById('featured-section');

        if (!track || !section) return;
        track.innerHTML = '';

        if (!data || data.length === 0) {
            section.style.display = 'none';
            return;
        }

        data.forEach((item, index) => {
            track.appendChild(createGallerySlide(item, index, data.length));
        });

        initFeaturedGallery();
    };

    const populateCategory = (containerId, data, type) => {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';

        if (!data || data.length === 0) {
            showEmpty(container);
            return;
        }

        data.slice(0, 15).forEach(item => {
            container.appendChild(createCategoryItem(item, type));
        });
    };

    const fetchData = async () => {
        const track = document.getElementById('featured-track');
        const eventsContainer = document.getElementById('events-container');
        const birthsContainer = document.getElementById('births-container');
        const deathsContainer = document.getElementById('deaths-container');

        if (track) {
            track.innerHTML = '';
            for (let i = 0; i < 3; i++) track.appendChild(createGalleryPlaceholder());
        }

        [eventsContainer, birthsContainer, deathsContainer].forEach(container => {
            if (container) {
                container.innerHTML = '';
                for (let i = 0; i < 8; i++) container.appendChild(createCategoryPlaceholder());
            }
        });

        try {
            const response = await fetch('../../app/proxys/otd-proxy.php');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();

            loadingOverlay?.classList.add('hidden');
            populateFeatured(data.selected?.selected);
            populateCategory('events-container', data.events?.events, 'events');
            populateCategory('births-container', data.births?.births, 'births');
            populateCategory('deaths-container', data.deaths?.deaths, 'deaths');

            //? Live counts for the hero stat strip + the record tabs
            const setCount = (id, arr) => {
                const el = document.getElementById(id);
                if (el) el.textContent = String(arr?.length ?? 0).padStart(2, '0');
            };
            setCount('stat-events', data.events?.events);
            setCount('stat-births', data.births?.births);
            setCount('stat-deaths', data.deaths?.deaths);
            setCount('count-events', data.events?.events);
            setCount('count-births', data.births?.births);
            setCount('count-deaths', data.deaths?.deaths);
        } catch (error) {
            console.error('Error:', error);
            loadingOverlay?.classList.add('hidden');
            if (track) showError(track);
            [eventsContainer, birthsContainer, deathsContainer].forEach(c => { if (c) showError(c); });
        }
    };

    fetchData();
})();
