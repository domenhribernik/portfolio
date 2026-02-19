(() => {
    const loadingOverlay = document.getElementById('loading-overlay');
    const currentDateEl = document.getElementById('current-date');

    const today = new Date();
    currentDateEl.textContent = today.toLocaleDateString('en-US', { 
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
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

    const createCategoryItem = (item, type) => {
        const div = document.createElement('div');
        div.className = 'category-item';

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
        const imageUrl = getFirstImage(item.pages);
        const pageUrl = getFirstPageUrl(item.pages);

        const imageHtml = imageUrl ? `<img src="${imageUrl}" alt="" class="category-item-image" loading="lazy">` : '';
        const linkStart = pageUrl ? `<a href="${pageUrl}" target="_blank" rel="noopener" class="category-item-link">` : '';
        const linkEnd = pageUrl ? '</a>' : '';
        const textHtml = description 
            ? `<p class="category-item-text"><strong class="category-item-title">${title}</strong> ${description}</p>`
            : `<p class="category-item-text"><strong class="category-item-title">${title}</strong></p>`;

        div.innerHTML = `
            ${linkStart}
            ${imageHtml}
            <div class="category-item-content">
                ${year ? `<span class="category-item-year ${type}">${year}</span>` : ''}
                ${textHtml}
            </div>
            ${linkEnd}
        `;

        return div;
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
        div.className = 'category-item loading';
        div.innerHTML = `
            <div class="loading-block category-item-image"></div>
            <div class="category-item-content">
                <div class="loading-line short"></div>
                <div class="loading-line"></div>
            </div>
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
                for (let i = 0; i < 5; i++) container.appendChild(createCategoryPlaceholder());
            }
        });

        try {
            const response = await fetch('../php/otd-proxy.php');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            
            loadingOverlay?.classList.add('hidden');
            populateFeatured(data.selected?.selected);
            populateCategory('events-container', data.events?.events, 'events');
            populateCategory('births-container', data.births?.births, 'births');
            populateCategory('deaths-container', data.deaths?.deaths, 'deaths');
        } catch (error) {
            console.error('Error:', error);
            loadingOverlay?.classList.add('hidden');
            if (track) showError(track);
            [eventsContainer, birthsContainer, deathsContainer].forEach(c => { if (c) showError(c); });
        }
    };

    fetchData();
})();
