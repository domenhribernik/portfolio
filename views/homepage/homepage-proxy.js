// ===== Code Stats =====

(async () => {
    try {
        const res = await fetch('app/proxys/stats-proxy.php');
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();

        const totalEl = document.getElementById('stats-total-number');
        const filesEl = document.getElementById('stats-total-files');
        const updatedEl = document.getElementById('stats-updated');
        const barEl = document.getElementById('stats-bar');
        const legendEl = document.getElementById('stats-legend');
        if (!totalEl || !barEl || !legendEl) return;

        // Editorial palette so the chart sits in the same world as the rest of the page.
        const colors = {
            html: '#d4451f', // clay
            css: '#1f35e0', // cobalt
            js: '#f2b705', // marigold
            php: '#2f5b53', // pine
            sql: '#6b6256'  // stone
        };

        const labels = {
            html: 'HTML',
            css: 'CSS',
            js: 'JavaScript',
            php: 'PHP',
            sql: 'SQL'
        };

        // Biggest languages first, drop anything with no lines.
        const langs = Object.entries(data.counts)
            .filter(([, info]) => info.lines > 0)
            .sort((a, b) => b[1].lines - a[1].lines);

        const totalFiles = langs.reduce((n, [, info]) => n + info.files, 0);

        animateNumber(totalEl, data.total);
        filesEl.textContent = totalFiles.toLocaleString();
        if (updatedEl && data.date) {
            updatedEl.textContent = new Date(data.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }

        // Single stacked composition bar.
        barEl.innerHTML = '';
        langs.forEach(([lang, info], i) => {
            const seg = document.createElement('span');
            seg.className = 'stats-comp-seg';
            seg.style.background = colors[lang] || '#6b6256';
            seg.style.width = '0%';
            seg.title = `${labels[lang] || lang} · ${info.percent}%`;
            barEl.appendChild(seg);
            requestAnimationFrame(() => {
                setTimeout(() => { seg.style.width = info.percent + '%'; }, 90 * i);
            });
        });

        // Legend grid.
        legendEl.innerHTML = '';
        langs.forEach(([lang, info], i) => {
            const row = document.createElement('div');
            row.className = 'stats-legend__item';
            row.style.setProperty('--seg', colors[lang] || '#6b6256');
            row.style.transitionDelay = (i * 0.06) + 's';
            row.innerHTML = `
                <span class="stats-legend__dot" aria-hidden="true"></span>
                <span class="stats-legend__name">${labels[lang] || lang}</span>
                <span class="stats-legend__pct">${Math.round(info.percent)}%</span>
                <span class="stats-legend__detail">${info.lines.toLocaleString()} lines · ${info.files} files</span>
            `;
            legendEl.appendChild(row);
            requestAnimationFrame(() => row.classList.add('is-in'));
        });
    } catch (e) {
        const content = document.getElementById('stats-content');
        if (content) content.innerHTML = '<p style="text-align:center;color:var(--stone)">Unable to load stats.</p>';
    }
})();

// Count-up for the headline figure (ease-out cubic).
function animateNumber(el, target) {
    const dur = 1300;
    const start = performance.now();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { el.textContent = Math.round(target).toLocaleString(); return; }
    (function tick(now) {
        const t = Math.min((now - start) / dur, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = Math.round(target * eased).toLocaleString();
        if (t < 1) requestAnimationFrame(tick);
    })(start);
}

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
        body.innerHTML = `<p style="text-align:center;color:var(--clay)">Unable to load picture.</p>`;
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
