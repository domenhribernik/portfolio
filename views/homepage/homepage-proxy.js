// ===== Code Stats =====

(async () => {
    try {
        const res = await fetch('app/proxys/stats-proxy.php');
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();

        const totalEl = document.getElementById('stats-total-number');
        const breakdownEl = document.getElementById('stats-breakdown');
        if (!totalEl || !breakdownEl) return;

        totalEl.textContent = data.total.toLocaleString();

        const colors = {
            html: '#e34c26',
            css: '#563d7c',
            js: '#f1e05a',
            php: '#4F5D95',
            sql: '#e38c00'
        };

        const labels = {
            html: 'HTML',
            css: 'CSS',
            js: 'JavaScript',
            php: 'PHP',
            sql: 'SQL'
        };

        breakdownEl.innerHTML = '';
        for (const [lang, info] of Object.entries(data.counts)) {
            const item = document.createElement('div');
            item.className = 'stats-lang';
            item.innerHTML = `
                <div class="stats-lang-header">
                    <span class="stats-lang-name">${labels[lang] || lang}</span>
                    <span class="stats-lang-info">${info.lines.toLocaleString()} lines · ${info.files} files</span>
                </div>
                <div class="stats-bar">
                    <div class="stats-bar-fill" style="width: 0%; background: ${colors[lang] || '#667eea'}"></div>
                </div>
            `;
            breakdownEl.appendChild(item);

            // Animate bar after append
            requestAnimationFrame(() => {
                item.querySelector('.stats-bar-fill').style.width = info.percent + '%';
            });
        }
    } catch (e) {
        const content = document.getElementById('stats-content');
        if (content) content.innerHTML = '<p style="text-align:center;color:var(--text-muted)">Unable to load stats.</p>';
    }
})();

// ===== APOD (Astronomy Picture of the Day) =====

(async () => {
    const spinner = document.getElementById('apod-spinner');
    const body    = document.getElementById('apod-body');
    const imgEl   = document.getElementById('apod-img');

    const renderApod = (d) => {
        document.getElementById('apod-title').textContent   = d.title;
        document.getElementById('apod-date').textContent    = new Date(d.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        document.getElementById('apod-explain').textContent = d.explanation;
        document.getElementById('apod-link').href           = `https://apod.nasa.gov/apod/ap${d.date.replace(/-/g, '').slice(2)}.html`;
        document.getElementById('apod-copy').textContent    = d.copyright ? `© ${d.copyright}` : '';

        imgEl.src   = d.url;
        imgEl.alt   = d.title;
        imgEl.title = d.title;
        imgEl.onclick = () => window.open(d.hdurl || d.url, '_blank');
    };

    try {
        const res = await fetch('app/proxys/apod-proxy.php');
        if (!res.ok) throw new Error(res.status);
        const d = await res.json();

        renderApod(d);
        spinner.hidden = true;
        body.hidden    = false;

        // If what we got isn't today's date, try to fetch fresh in the background
        const today = new Date().toISOString().slice(0, 10);
        if (d.date !== today) {
            fetch('app/proxys/apod-proxy.php?refresh=1')
                .then(r => r.ok ? r.json() : null)
                .then(fresh => { if (fresh?.date && fresh.date !== d.date) renderApod(fresh); })
                .catch(() => {});
        }
    } catch (e) {
        spinner.hidden = true;
        body.hidden    = false;
        body.innerHTML = `<p style="text-align:center;color:var(--error)">Unable to load picture.</p>`;
    }
})();

// ===== OTD (On This Day) =====

window.addEventListener('DOMContentLoaded', () => {
    const loadingOverlay = document.getElementById('loading-overlay');

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

    let featuredGallery = null;

    const initFeaturedGallery = () => {
        const track = document.getElementById('featured-track');
        const prevBtn = document.getElementById('gallery-prev');
        const nextBtn = document.getElementById('gallery-next');
        const dotsContainer = document.getElementById('featured-dots');

        if (!track) return;

        if (featuredGallery) {
            featuredGallery.destroy();
        }

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

    const showError = (container) => {
        container.innerHTML = `<div class="error-state"><span class="error-icon">⚠️</span><p>Unable to load data.</p></div>`;
    };

    const populateFeatured = (data) => {
        const track = document.getElementById('featured-track');
        const section = document.getElementById('on-this-day-section');

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

    const fetchData = async () => {
        const track = document.getElementById('featured-track');

        if (track) {
            track.innerHTML = '';
            for (let i = 0; i < 3; i++) track.appendChild(createGalleryPlaceholder());
        }

        try {
            const response = await fetch('app/proxys/otd-proxy.php');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();

            loadingOverlay?.classList.add('hidden');
            populateFeatured(data.selected?.selected);
        } catch (error) {
            console.error('Error:', error);
            loadingOverlay?.classList.add('hidden');
            if (track) showError(track);
        }
    };

    fetchData();
});
