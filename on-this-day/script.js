(() => {
    // DOM Elements
    const loadingOverlay = document.getElementById('loading-overlay');
    const currentDateEl = document.getElementById('current-date');
    const featuredTrack = document.getElementById('featured-track');
    const featuredDots = document.getElementById('featured-dots');

    // Set current date
    const today = new Date();
    const dateOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    currentDateEl.textContent = today.toLocaleDateString('en-US', dateOptions);

    // Helper: Strip HTML tags from text
    const stripHtml = (html) => {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        return tmp.textContent || tmp.innerText || '';
    };

    // Helper: Get first image from pages array
    const getFirstImage = (pages) => {
        if (!pages || !Array.isArray(pages) || pages.length === 0) return null;
        const pageWithImage = pages.find(p => p.thumbnail?.source);
        return pageWithImage?.thumbnail?.source || null;
    };

    // Helper: Get extract_html from first page
    const getExtractHtml = (pages) => {
        if (!pages || !Array.isArray(pages) || pages.length === 0) return null;
        return pages[0]?.extract_html || null;
    };

    // Helper: Get first page URL
    const getFirstPageUrl = (pages) => {
        if (!pages || !Array.isArray(pages) || pages.length === 0) return null;
        const page = pages[0];
        return page?.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${page?.title}`;
    };

    // Extract title from text
    const extractTitle = (text) => {
        if (!text) return { title: '', description: '' };
        
        const patterns = [
            /^([^,]+),\s*(.+)$/,
            /^([^:]+):\s*(.+)$/,
            /^(.+?\([^)]+\))\s*,?\s*(.+)$/,
        ];
        
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                return { title: match[1].trim(), description: match[2].trim() };
            }
        }
        
        const firstSentence = text.split(/[.!?]\s+/)[0];
        if (firstSentence && firstSentence.length < text.length) {
            return { title: firstSentence, description: text.substring(firstSentence.length + 1).trim() };
        }
        
        return { title: text, description: '' };
    };

    // Get slides per view based on viewport
    const getSlidesPerView = () => {
        if (window.innerWidth >= 992) return 3;
        if (window.innerWidth >= 768) return 2;
        return 1;
    };

    // Check if mobile
    const isMobile = () => window.innerWidth < 768;

    // Create gallery slide element
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
        ` : `<div class="gallery-image gallery-image-placeholder">
            <span>📜</span>
        </div>`;

        const extractHtml2 = extractHtml ? `
            <div class="gallery-extract">${extractHtml}</div>
        ` : '';

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

    // Create category item element with bold title
    const createCategoryItem = (item, type) => {
        const div = document.createElement('div');
        div.className = 'category-item';

        const year = item.year || '';
        const text = stripHtml(item.text || '');
        const { title, description } = extractTitle(text);
        const imageUrl = getFirstImage(item.pages);
        const pageUrl = getFirstPageUrl(item.pages);

        const imageHtml = imageUrl ? `
            <img src="${imageUrl}" alt="" class="category-item-image" loading="lazy">
        ` : '';

        const linkStart = pageUrl ? `<a href="${pageUrl}" target="_blank" rel="noopener" class="category-item-link">` : '';
        const linkEnd = pageUrl ? '</a>' : '';

        let textHtml = '';
        if (title && description) {
            textHtml = `<p class="category-item-text"><strong class="category-item-title">${title}</strong> ${description}</p>`;
        } else {
            textHtml = `<p class="category-item-text"><strong class="category-item-title">${text}</strong></p>`;
        }

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

    // Create loading placeholder for gallery
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

    // Create loading placeholder for category
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

    // Show error message
    const showError = (container) => {
        container.innerHTML = `
            <div class="error-state">
                <span class="error-icon">⚠️</span>
                <p>Unable to load data. Please try again later.</p>
            </div>
        `;
    };

    // Show empty message
    const showEmpty = (container) => {
        container.innerHTML = `
            <div class="empty-state">
                <p>No entries available.</p>
            </div>
        `;
    };

    // Gallery state
    let galleryState = {
        currentIndex: 0,
        slidesPerView: 3,
        totalSlides: 0,
        realSlides: 0,
        isDragging: false,
        startX: 0,
        currentX: 0,
        isTransitioning: false
    };

    // Get the actual slide index (accounting for clones)
    const getRealIndex = (visualIndex) => {
        const numClones = galleryState.slidesPerView;
        if (visualIndex < numClones) {
            return galleryState.realSlides - numClones + visualIndex;
        } else if (visualIndex >= numClones + galleryState.realSlides) {
            return visualIndex - (numClones + galleryState.realSlides);
        }
        return visualIndex - numClones;
    };

    // Update active class on slides
    const updateActiveSlide = () => {
        const track = document.getElementById('featured-track');
        if (!track) return;
        
        const slides = track.querySelectorAll('.gallery-slide');
        slides.forEach((slide, index) => {
            slide.classList.toggle('active', index === galleryState.currentIndex);
        });
    };

    // Initialize gallery with infinite scroll
    const initGallery = () => {
        const track = document.getElementById('featured-track');
        const dots = document.getElementById('featured-dots');
        const prevBtn = document.getElementById('gallery-prev');
        const nextBtn = document.getElementById('gallery-next');
        
        if (!track) return;

        const realSlides = track.querySelectorAll('.gallery-slide:not(.loading)');
        galleryState.realSlides = realSlides.length;
        galleryState.slidesPerView = getSlidesPerView();
        
        // Check if we have enough slides for infinite scroll
        if (galleryState.realSlides <= galleryState.slidesPerView) {
            // Simple mode without infinite scroll
            galleryState.currentIndex = 0;
            createDots(dots, galleryState.realSlides);
            updateGallerySimple();
            setupEventListeners(prevBtn, nextBtn, track, false);
            return;
        }

        // Create clones for infinite scroll
        const slidesArray = Array.from(realSlides);
        const numClones = galleryState.slidesPerView;
        
        // Clone last N slides and prepend
        for (let i = slidesArray.length - numClones; i < slidesArray.length; i++) {
            const clone = slidesArray[i].cloneNode(true);
            clone.classList.add('clone');
            clone.dataset.clone = 'true';
            track.insertBefore(clone, slidesArray[0]);
        }
        
        // Clone first N slides and append
        for (let i = 0; i < numClones; i++) {
            const clone = slidesArray[i].cloneNode(true);
            clone.classList.add('clone');
            clone.dataset.clone = 'true';
            track.appendChild(clone);
        }

        galleryState.currentIndex = numClones;
        galleryState.totalSlides = galleryState.realSlides + (numClones * 2);
        
        createDots(dots, galleryState.realSlides);
        updateActiveSlide();
        updateGallery(true);
        setupEventListeners(prevBtn, nextBtn, track, true);
    };

    // Create dots
    const createDots = (dots, count) => {
        dots.innerHTML = '';
        for (let i = 0; i < count; i++) {
            const dot = document.createElement('button');
            dot.className = 'gallery-dot' + (i === 0 ? ' active' : '');
            dot.setAttribute('aria-label', `Go to slide ${i + 1}`);
            dot.addEventListener('click', () => {
                const numClones = galleryState.slidesPerView;
                galleryState.currentIndex = i + numClones;
                updateActiveSlide();
                updateGallery();
            });
            dots.appendChild(dot);
        }
    };

    // Setup all event listeners
    const setupEventListeners = (prevBtn, nextBtn, track, isInfinite) => {
        if (prevBtn) prevBtn.addEventListener('click', () => {
            if (galleryState.isTransitioning) return;
            if (isInfinite) {
                prevSlideInfinite();
            } else {
                prevSlideSimple();
            }
        });

        if (nextBtn) nextBtn.addEventListener('click', () => {
            if (galleryState.isTransitioning) return;
            if (isInfinite) {
                nextSlideInfinite();
            } else {
                nextSlideSimple();
            }
        });

        // Touch events
        track.addEventListener('touchstart', (e) => {
            galleryState.startX = e.touches[0].clientX;
            galleryState.isDragging = true;
            track.style.transition = 'none';
        }, { passive: true });

        track.addEventListener('touchmove', (e) => {
            if (!galleryState.isDragging) return;
            galleryState.currentX = e.touches[0].clientX;
            const diff = galleryState.currentX - galleryState.startX;
            
            if (isMobile()) {
                const viewportWidth = track.parentElement.offsetWidth;
                const slideWidth = viewportWidth - 80 - 12;
                const centerOffset = (viewportWidth - slideWidth) / 2;
                const baseOffset = centerOffset - (galleryState.currentIndex * (slideWidth + 12));
                track.style.transform = `translateX(${baseOffset + diff}px)`;
            } else {
                const slideWidth = track.offsetWidth / galleryState.slidesPerView;
                const gapPixels = 16;
                const baseOffset = -(galleryState.currentIndex * (slideWidth + gapPixels));
                track.style.transform = `translateX(${baseOffset + diff}px)`;
            }
        }, { passive: true });

        track.addEventListener('touchend', () => {
            handleDragEnd(isInfinite);
        });

        // Mouse events
        track.addEventListener('mousedown', (e) => {
            galleryState.startX = e.clientX;
            galleryState.isDragging = true;
            track.style.transition = 'none';
            track.style.cursor = 'grabbing';
        });

        track.addEventListener('mousemove', (e) => {
            if (!galleryState.isDragging) return;
            e.preventDefault();
            galleryState.currentX = e.clientX;
            const diff = galleryState.currentX - galleryState.startX;
            
            if (isMobile()) {
                const viewportWidth = track.parentElement.offsetWidth;
                const slideWidth = viewportWidth - 80 - 12;
                const centerOffset = (viewportWidth - slideWidth) / 2;
                const baseOffset = centerOffset - (galleryState.currentIndex * (slideWidth + 12));
                track.style.transform = `translateX(${baseOffset + diff}px)`;
            } else {
                const slideWidth = track.offsetWidth / galleryState.slidesPerView;
                const gapPixels = 16;
                const baseOffset = -(galleryState.currentIndex * (slideWidth + gapPixels));
                track.style.transform = `translateX(${baseOffset + diff}px)`;
            }
        });

        track.addEventListener('mouseup', () => {
            handleDragEnd(isInfinite);
        });

        track.addEventListener('mouseleave', () => {
            if (galleryState.isDragging) {
                handleDragEnd(isInfinite);
            }
        });

        // Keyboard navigation
        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') {
                if (isInfinite) prevSlideInfinite();
                else prevSlideSimple();
            }
            if (e.key === 'ArrowRight') {
                if (isInfinite) nextSlideInfinite();
                else nextSlideSimple();
            }
        });

        // Listen for transition end for infinite loop
        if (isInfinite) {
            track.addEventListener('transitionend', () => {
                const numClones = galleryState.slidesPerView;
                
                if (galleryState.currentIndex >= numClones + galleryState.realSlides) {
                    // Use double rAF for truly seamless jump
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            galleryState.currentIndex = numClones;
                            updateGallery(true);
                            galleryState.isTransitioning = false;
                        });
                    });
                } else if (galleryState.currentIndex < numClones) {
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            galleryState.currentIndex = numClones + galleryState.realSlides - 1;
                            updateGallery(true);
                            galleryState.isTransitioning = false;
                        });
                    });
                } else {
                    galleryState.isTransitioning = false;
                }
            });
        }
    };

    // Handle drag end
    const handleDragEnd = (isInfinite) => {
        if (!galleryState.isDragging) return;
        galleryState.isDragging = false;
        
        const track = document.getElementById('featured-track');
        track.style.transition = '';
        track.style.cursor = '';
        
        const diff = galleryState.currentX - galleryState.startX;
        const threshold = isMobile() ? 50 : (track.offsetWidth / galleryState.slidesPerView) * 0.2;
        
        if (diff > threshold) {
            if (isInfinite) prevSlideInfinite();
            else prevSlideSimple();
        } else if (diff < -threshold) {
            if (isInfinite) nextSlideInfinite();
            else nextSlideSimple();
        } else {
            updateGallery();
        }
    };

    // Simple navigation (non-infinite)
    const prevSlideSimple = () => {
        galleryState.currentIndex = Math.max(0, galleryState.currentIndex - 1);
        updateActiveSlide();
        updateGallerySimple();
    };

    const nextSlideSimple = () => {
        const maxIndex = Math.max(0, galleryState.realSlides - galleryState.slidesPerView);
        galleryState.currentIndex = Math.min(maxIndex, galleryState.currentIndex + 1);
        updateActiveSlide();
        updateGallerySimple();
    };

    const updateGallerySimple = () => {
        const track = document.getElementById('featured-track');
        const dots = document.getElementById('featured-dots');
        
        if (!track) return;

        if (isMobile()) {
            const viewportWidth = track.parentElement.offsetWidth;
            const slideWidth = viewportWidth - 80 - 12;
            const centerOffset = (viewportWidth - slideWidth) / 2;
            const offset = centerOffset - (galleryState.currentIndex * (slideWidth + 12));
            track.style.transform = `translateX(${offset}px)`;
        } else {
            const slideWidthPercent = 100 / galleryState.slidesPerView;
            const gapPercent = (16 / track.offsetWidth) * 100;
            const offset = galleryState.currentIndex * (slideWidthPercent + gapPercent);
            track.style.transform = `translateX(-${offset}%)`;
        }

        dots.querySelectorAll('.gallery-dot').forEach((dot, index) => {
            dot.classList.toggle('active', index === galleryState.currentIndex);
        });
    };

    // Infinite navigation
    const prevSlideInfinite = () => {
        galleryState.isTransitioning = true;
        galleryState.currentIndex--;
        updateActiveSlide();
        updateGallery();
    };

    const nextSlideInfinite = () => {
        galleryState.isTransitioning = true;
        galleryState.currentIndex++;
        updateActiveSlide();
        updateGallery();
    };

    // Update gallery position and UI
    const updateGallery = (noAnimation = false) => {
        const track = document.getElementById('featured-track');
        const dots = document.getElementById('featured-dots');
        
        if (!track) return;

        if (noAnimation) {
            track.style.transition = 'none';
        } else {
            track.style.transition = '';
        }

        if (isMobile()) {
            // Mobile: center the active slide with peek
            const viewportWidth = track.parentElement.offsetWidth;
            const peekWidth = Math.min(40, viewportWidth * 0.1);
            const gap = 12;
            const slideWidth = viewportWidth - (peekWidth * 2) - gap;
            const centerOffset = (viewportWidth - slideWidth) / 2;
            const offset = centerOffset - (galleryState.currentIndex * (slideWidth + gap));
            track.style.transform = `translateX(${offset}px)`;
        } else {
            // Desktop: percentage-based
            const slideWidthPercent = 100 / galleryState.slidesPerView;
            const gapPercent = (16 / track.offsetWidth) * 100;
            const offset = galleryState.currentIndex * (slideWidthPercent + gapPercent);
            track.style.transform = `translateX(-${offset}%)`;
        }

        // Update dots based on real index
        const realIndex = getRealIndex(galleryState.currentIndex);
        dots.querySelectorAll('.gallery-dot').forEach((dot, index) => {
            dot.classList.toggle('active', index === realIndex);
        });

        if (noAnimation) {
            requestAnimationFrame(() => {
                track.style.transition = '';
            });
        }
    };

    // Populate featured gallery
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

    // Populate category section
    const populateCategory = (containerId, data, type) => {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = '';

        if (!data || data.length === 0) {
            showEmpty(container);
            return;
        }

        const itemsToShow = data.slice(0, 15);
        itemsToShow.forEach(item => {
            container.appendChild(createCategoryItem(item, type));
        });
    };

    // Fetch data from API
    const fetchData = async () => {
        const eventsContainer = document.getElementById('events-container');
        const birthsContainer = document.getElementById('births-container');
        const deathsContainer = document.getElementById('deaths-container');
        const track = document.getElementById('featured-track');

        if (track) {
            track.innerHTML = '';
            for (let i = 0; i < 3; i++) {
                track.appendChild(createGalleryPlaceholder());
            }
        }

        [eventsContainer, birthsContainer, deathsContainer].forEach(container => {
            if (container) {
                container.innerHTML = '';
                for (let i = 0; i < 5; i++) {
                    container.appendChild(createCategoryPlaceholder());
                }
            }
        });

        try {
            const response = await fetch('../php/otd-proxy.php');
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            loadingOverlay?.classList.add('hidden');
            populateFeatured(data.selected?.selected);
            populateCategory('events-container', data.events?.events, 'events');
            populateCategory('births-container', data.births?.births, 'births');
            populateCategory('deaths-container', data.deaths?.deaths, 'deaths');

        } catch (error) {
            console.error('Error fetching data:', error);
            loadingOverlay?.classList.add('hidden');
            if (track) showError(track);
            [eventsContainer, birthsContainer, deathsContainer].forEach(container => {
                if (container) showError(container);
            });
        }
    };

    // Initialize
    fetchData();
})();
