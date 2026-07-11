// On This Day — loads today's record from otd-proxy.php and typesets it as a
// broadsheet: a folio masthead, a featured front page (one lead dispatch above
// a slider of the rest) and three tabbed ledgers. DOM-free shaping lives in
// logic.js (unit-tested); this file owns the DOM and the Gallery wiring.
import {
    splitFeatured, splitEntry, pickImage, pickExtractHtml, pickPageUrl, dayOfYear, pad2
} from './logic.js';

(() => {
    const loadingOverlay = document.getElementById('loading-overlay');
    const today = new Date();

    //? Masthead dateline
    const currentDateEl = document.getElementById('current-date');
    if (currentDateEl) {
        currentDateEl.textContent = today.toLocaleDateString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        });
    }

    const editionEl = document.getElementById('masthead-edition');
    if (editionEl) {
        editionEl.textContent = `${today.toLocaleDateString('en-US', { weekday: 'long' })} Edition`;
    }

    //? Day-of-year drives the issue number, the hero corner tag and the giant
    //  ghost figure behind the masthead.
    const doy = dayOfYear(today);
    const isLeap = (y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)(today.getFullYear());
    const totalDays = isLeap ? 366 : 365;

    const issueEl = document.getElementById('masthead-issue');
    if (issueEl) issueEl.textContent = `No. ${pad2(doy)} / ${totalDays}`;

    const cornerEl = document.getElementById('hero-corner');
    if (cornerEl) cornerEl.textContent = `Day ${doy} / ${totalDays}`;

    const daynumEl = document.getElementById('hero-daynum');
    if (daynumEl) daynumEl.textContent = String(doy).padStart(3, '0');

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

    const READ_MORE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;

    // ========================================
    // GALLERY INSTANCE (the "more dispatches" slider)
    // ========================================

    let featuredGallery = null;

    const initFeaturedGallery = () => {
        const track = document.getElementById('featured-track');
        if (!track) return;

        if (featuredGallery) featuredGallery.destroy();

        featuredGallery = new Gallery({
            track,
            prevBtn: document.getElementById('gallery-prev'),
            nextBtn: document.getElementById('gallery-next'),
            dotsContainer: document.getElementById('featured-dots'),
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

    // The lead dispatch: the front-page lead story. Replaces #featured-lead so
    // the whole plate can be an <a> when the dispatch links to Wikipedia.
    const buildLead = (item) => {
        const holder = document.getElementById('featured-lead');
        if (!holder) return;

        const year = item.year || '';
        const text = stripHtml(item.text || '');
        const imageUrl = pickImage(item.pages);
        const extract = pickExtractHtml(item.pages);
        const pageUrl = pickPageUrl(item.pages);

        const el = document.createElement(pageUrl ? 'a' : 'article');
        el.id = 'featured-lead';
        el.className = 'otd-lead is-in';
        if (pageUrl) { el.href = pageUrl; el.target = '_blank'; el.rel = 'noopener'; }

        const media = imageUrl
            ? `<div class="otd-lead__media"><span class="otd-lead__ribbon">Lead dispatch</span><img src="${imageUrl}" alt="${text.substring(0, 60)}" loading="lazy"></div>`
            : `<div class="otd-lead__media otd-lead__media--placeholder"><span class="otd-lead__ribbon">Lead dispatch</span>📜</div>`;

        el.innerHTML = `
            ${media}
            <div class="otd-lead__body">
                <div class="otd-lead__meta">
                    ${year ? `<span class="otd-lead__year">${year}</span>` : ''}
                    <span class="otd-lead__kicker">Today's lead</span>
                </div>
                <h3 class="otd-lead__title">${text}</h3>
                ${extract ? `<div class="otd-lead__extract">${extract}</div>` : ''}
                ${pageUrl ? `<span class="otd-lead__more">Read the full entry ${READ_MORE_SVG}</span>` : ''}
            </div>
        `;

        holder.replaceWith(el);
    };

    const createGallerySlide = (item, index, total) => {
        const article = document.createElement('article');
        article.className = 'gallery-slide';
        article.dataset.index = index;

        const year = item.year || '';
        const text = stripHtml(item.text || '');
        const imageUrl = pickImage(item.pages);
        const extract = pickExtractHtml(item.pages);
        const pageUrl = pickPageUrl(item.pages);

        const imageHtml = imageUrl
            ? `<div class="gallery-image"><img src="${imageUrl}" alt="${text.substring(0, 50)}" loading="lazy"></div>`
            : `<div class="gallery-image gallery-image-placeholder"><span>📜</span></div>`;

        const extractHtml = extract ? `<div class="gallery-extract">${extract}</div>` : '';
        const linkHtml = pageUrl
            ? `<a href="${pageUrl}" target="_blank" rel="noopener" class="gallery-link">Read more ${READ_MORE_SVG}</a>`
            : '';

        article.innerHTML = `
            ${imageHtml}
            <div class="gallery-content">
                <div class="gallery-meta">
                    ${year ? `<span class="gallery-year">${year}</span>` : ''}
                    <span class="gallery-counter">${index + 1} / ${total}</span>
                </div>
                <h3 class="gallery-title">${text}</h3>
                ${extractHtml}
                ${linkHtml}
            </div>
        `;

        return article;
    };

    const createCategoryItem = (item) => {
        const { title, description } = splitEntry(stripHtml(item.text || ''));
        const year = item.year || '';
        const pageUrl = pickPageUrl(item.pages);

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

    const leadSkeleton = () => `
        <div class="otd-lead__media loading-block"></div>
        <div class="otd-lead__body">
            <div class="otd-lead__sk otd-lead__sk--short"></div>
            <div class="otd-lead__sk otd-lead__sk--title"></div>
            <div class="otd-lead__sk"></div>
            <div class="otd-lead__sk"></div>
            <div class="otd-lead__sk" style="width:66%"></div>
        </div>
    `;

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
        const section = document.getElementById('featured-section');
        const track = document.getElementById('featured-track');
        const more = document.querySelector('.otd-more');
        if (!section) return;

        const { lead, rest } = splitFeatured(data);

        if (!lead) {
            section.style.display = 'none';
            return;
        }

        buildLead(lead);

        // The slider only exists when there are dispatches beyond the lead.
        if (track) track.innerHTML = '';
        if (rest.length === 0) {
            if (more) more.style.display = 'none';
            return;
        }

        if (more) more.style.display = '';
        rest.forEach((item, index) => {
            track.appendChild(createGallerySlide(item, index, rest.length));
        });
        initFeaturedGallery();
    };

    const populateCategory = (containerId, data) => {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';

        if (!data || data.length === 0) {
            showEmpty(container);
            return;
        }

        data.slice(0, 15).forEach(item => container.appendChild(createCategoryItem(item)));
    };

    const fetchData = async () => {
        const lead = document.getElementById('featured-lead');
        const track = document.getElementById('featured-track');
        const eventsContainer = document.getElementById('events-container');
        const birthsContainer = document.getElementById('births-container');
        const deathsContainer = document.getElementById('deaths-container');

        if (lead) {
            lead.className = 'otd-lead loading';
            lead.innerHTML = leadSkeleton();
        }
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
            populateCategory('events-container', data.events?.events);
            populateCategory('births-container', data.births?.births);
            populateCategory('deaths-container', data.deaths?.deaths);

            //? Live counts for the hero stat strip + the record tabs
            const setCount = (id, arr) => {
                const el = document.getElementById(id);
                if (el) el.textContent = pad2(arr?.length ?? 0);
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
            const leadNow = document.getElementById('featured-lead');
            if (leadNow) { leadNow.className = 'otd-lead'; showError(leadNow); }
            [eventsContainer, birthsContainer, deathsContainer].forEach(c => { if (c) showError(c); });
        }
    };

    fetchData();
})();
