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

    const getSlidesPerView = () => {
        if (window.innerWidth >= 992) return 3;
        if (window.innerWidth >= 768) return 2;
        return 1;
    };

    const isMobile = () => window.innerWidth < 768;

    // ========================================
    // CLEAN INFINITE CAROUSEL
    // ========================================

    const gallery = {
        track: null,
        slides: [],
        realCount: 0,
        cloneCount: 0,
        currentIndex: 0,     // Visual index (includes clones)
        slideWidth: 0,
        gap: 16,
        isAnimating: false,
        isDragging: false,
        startX: 0,
        currentX: 0
    };

    const getRealIndex = () => {
        const { currentIndex, cloneCount, realCount } = gallery;
        let idx = currentIndex - cloneCount;
        while (idx < 0) idx += realCount;
        while (idx >= realCount) idx -= realCount;
        return idx;
    };

    const updateDots = () => {
        const dots = document.getElementById('featured-dots');
        if (!dots) return;
        const realIdx = getRealIndex();
        dots.querySelectorAll('.gallery-dot').forEach((dot, i) => {
            dot.classList.toggle('active', i === realIdx);
        });
    };

    const updateActiveSlide = () => {
        if (!gallery.track) return;
        const realIdx = getRealIndex();
        const allSlides = gallery.track.querySelectorAll('.gallery-slide');
        allSlides.forEach((slide, i) => {
            // Calculate the real index for this slide
            let slideRealIdx;
            if (slide.classList.contains('clone')) {
                // For clones, find the original index
                const originalIndex = slide.dataset.originalIndex;
                slideRealIdx = originalIndex !== undefined ? parseInt(originalIndex) : -1;
            } else {
                // For real slides, use their dataset.index
                slideRealIdx = parseInt(slide.dataset.index);
            }
            slide.classList.toggle('active', slideRealIdx === realIdx);
        });
    };

    const getOffset = (index) => {
        const track = gallery.track;
        if (!track) return 0;

        if (isMobile()) {
            const viewportWidth = track.parentElement.offsetWidth;
            const peekWidth = Math.min(40, viewportWidth * 0.1);
            const gap = 12;
            const slideW = viewportWidth - (peekWidth * 2) - gap;
            const centerOffset = (viewportWidth - slideW) / 2;
            return centerOffset - (index * (slideW + gap));
        } else {
            const viewportWidth = track.parentElement.offsetWidth;
            const slidesPerView = getSlidesPerView();
            const gapPixels = 16;
            const totalGap = gapPixels * (slidesPerView - 1);
            const slideW = (viewportWidth - totalGap) / slidesPerView;
            gallery.slideWidth = slideW + gapPixels;
            return -(index * gallery.slideWidth);
        }
    };

    const setTransform = (index, animate = true) => {
        const track = gallery.track;
        if (!track) return;

        track.style.transition = animate ? 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)' : 'none';
        track.style.transform = `translateX(${getOffset(index)}px)`;
        
        // Update active slide immediately for responsive feel
        if (animate) {
            updateActiveSlide();
        }
    };

    const handleTransitionEnd = () => {
        const { currentIndex, cloneCount, realCount } = gallery;
        let jumped = false;

        // If we're in the right clones, jump to beginning
        if (currentIndex >= cloneCount + realCount) {
            gallery.currentIndex = cloneCount;
            jumped = true;
        }
        // If we're in the left clones, jump to end
        else if (currentIndex < cloneCount) {
            gallery.currentIndex = cloneCount + realCount - 1;
            jumped = true;
        }

        if (jumped) {
            // Force reflow
            gallery.track.offsetHeight;
            setTransform(gallery.currentIndex, false);
        }

        gallery.isAnimating = false;
        updateDots();
        updateActiveSlide();
    };

    const next = () => {
        if (gallery.isAnimating) return;
        gallery.isAnimating = true;
        gallery.currentIndex++;
        setTransform(gallery.currentIndex, true);
    };

    const prev = () => {
        if (gallery.isAnimating) return;
        gallery.isAnimating = true;
        gallery.currentIndex--;
        setTransform(gallery.currentIndex, true);
    };

    const goTo = (realIndex) => {
        if (gallery.isAnimating) return;
        gallery.isAnimating = true;
        gallery.currentIndex = realIndex + gallery.cloneCount;
        setTransform(gallery.currentIndex, true);
    };

    const initGallery = () => {
        const track = document.getElementById('featured-track');
        const prevBtn = document.getElementById('gallery-prev');
        const nextBtn = document.getElementById('gallery-next');
        
        if (!track) return;
        gallery.track = track;

        // Get real slides (remove any existing clones first)
        const allSlides = Array.from(track.querySelectorAll('.gallery-slide'));
        const realSlides = allSlides.filter(s => !s.classList.contains('clone'));
        gallery.realCount = realSlides.length;

        if (gallery.realCount <= 1) return;

        const slidesPerView = getSlidesPerView();
        gallery.cloneCount = Math.min(slidesPerView, gallery.realCount - 1);

        // Clear track
        track.innerHTML = '';

        // Add left clones (last N slides)
        for (let i = gallery.realCount - gallery.cloneCount; i < gallery.realCount; i++) {
            const clone = realSlides[i].cloneNode(true);
            clone.classList.add('clone');
            clone.dataset.originalIndex = i;
            track.appendChild(clone);
        }

        // Add real slides
        realSlides.forEach((slide, i) => {
            slide.dataset.index = i;
            track.appendChild(slide);
        });

        // Add right clones (first N slides)
        for (let i = 0; i < gallery.cloneCount; i++) {
            const clone = realSlides[i].cloneNode(true);
            clone.classList.add('clone');
            clone.dataset.originalIndex = i;
            track.appendChild(clone);
        }

        // Set initial position to first real slide
        gallery.currentIndex = gallery.cloneCount;
        setTransform(gallery.currentIndex, false);

        // Create dots
        const dotsContainer = document.getElementById('featured-dots');
        dotsContainer.innerHTML = '';
        for (let i = 0; i < gallery.realCount; i++) {
            const dot = document.createElement('button');
            dot.className = 'gallery-dot' + (i === 0 ? ' active' : '');
            dot.setAttribute('aria-label', `Go to slide ${i + 1}`);
            dot.addEventListener('click', () => goTo(i));
            dotsContainer.appendChild(dot);
        }

        updateDots();
        updateActiveSlide();

        // Transition end listener
        track.addEventListener('transitionend', handleTransitionEnd);

        // Button listeners
        if (prevBtn) prevBtn.addEventListener('click', prev);
        if (nextBtn) nextBtn.addEventListener('click', next);

        // Touch/Drag support
        setupDrag();

        // Keyboard
        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') prev();
            if (e.key === 'ArrowRight') next();
        });
    };

    const setupDrag = () => {
        const track = gallery.track;
        if (!track) return;

        // Detect iOS/Safari for special handling
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

        const onStart = (clientX) => {
            if (gallery.isAnimating) return;
            gallery.isDragging = true;
            gallery.startX = clientX;
            gallery.currentX = clientX;
            gallery.startTime = Date.now();
            track.style.transition = 'none';
            track.style.cursor = 'grabbing';
        };

        const onMove = (clientX) => {
            if (!gallery.isDragging) return;
            gallery.currentX = clientX;
            const diff = clientX - gallery.startX;
            const currentOffset = getOffset(gallery.currentIndex);
            track.style.transform = `translateX(${currentOffset + diff}px)`;
        };

        const onEnd = () => {
            if (!gallery.isDragging) return;
            gallery.isDragging = false;
            track.style.cursor = '';

            const diff = gallery.currentX - gallery.startX;
            const elapsed = Date.now() - gallery.startTime;
            const threshold = 50;
            
            // Velocity-based swipe detection for better mobile feel
            const velocity = Math.abs(diff) / (elapsed || 1);
            const isFlick = velocity > 0.5 && Math.abs(diff) > 30;

            if (diff > threshold || (isFlick && diff > 0)) {
                prev();
            } else if (diff < -threshold || (isFlick && diff < 0)) {
                next();
            } else {
                setTransform(gallery.currentIndex, true);
            }
        };

        // Touch events with better iOS handling
        track.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            gallery.startY = touch.clientY;
            onStart(touch.clientX);
        }, { passive: true });
        
        track.addEventListener('touchmove', (e) => {
            // On iOS, we need to check if user is scrolling horizontally
            if (gallery.isDragging) {
                const touch = e.touches[0];
                const diffX = Math.abs(touch.clientX - gallery.startX);
                const diffY = Math.abs(touch.clientY - (gallery.startY || touch.clientY));
                
                // If horizontal movement is greater, prevent default to enable swipe
                if (diffX > diffY && diffX > 10) {
                    // Don't preventDefault with passive:true, just handle the swipe
                    onMove(touch.clientX);
                }
            }
        }, { passive: true });
        
        track.addEventListener('touchend', (e) => {
            // Store the last touch position before ending
            if (e.changedTouches.length > 0) {
                gallery.currentX = e.changedTouches[0].clientX;
            }
            onEnd();
        });
        
        track.addEventListener('touchcancel', onEnd);

        // Mouse events (desktop)
        track.addEventListener('mousedown', (e) => {
            e.preventDefault();
            onStart(e.clientX);
        });
        
        const onMouseMove = (e) => onMove(e.clientX);
        const onMouseUp = () => {
            onEnd();
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        track.addEventListener('mousedown', () => {
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
        
        // Prevent default drag behavior on images (iOS Safari fix)
        track.querySelectorAll('img').forEach(img => {
            img.addEventListener('dragstart', (e) => e.preventDefault());
            img.style.webkitUserDrag = 'none';
        });
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

        initGallery();
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

    // Handle resize (with iOS Safari fix for toolbar height changes)
    let resizeTimeout;
    let lastWindowWidth = window.innerWidth;
    window.addEventListener('resize', () => {
        // On iOS, ignore resize events that only change height (toolbar show/hide)
        const currentWidth = window.innerWidth;
        if (currentWidth === lastWindowWidth) return;
        lastWindowWidth = currentWidth;
        
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            initGallery();
        }, 200);
    });

    fetchData();
})();
