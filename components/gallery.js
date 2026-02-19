/**
 * Reusable Gallery/Carousel Component
 *
 * Usage:
 *   const gallery = new Gallery({
 *     track: document.getElementById('gallery-track'),
 *     prevBtn: document.getElementById('gallery-prev'),
 *     nextBtn: document.getElementById('gallery-next'),
 *     dotsContainer: document.getElementById('gallery-dots'),
 *     options: {
 *       slidesPerView: { desktop: 3, tablet: 2, mobile: 1 },
 *       gap: 16,
 *       mobilePeek: 80,
 *       infinite: true
 *     }
 *   });
 *   gallery.init();
 */

class Gallery {
    constructor(config) {
        this.track = config.track;
        this.prevBtn = config.prevBtn || null;
        this.nextBtn = config.nextBtn || null;
        this.dotsContainer = config.dotsContainer || null;

        // Default options
        this.options = {
            slidesPerView: { desktop: 3, tablet: 2, mobile: 1 },
            gap: 16,
            mobileGap: 12,
            mobilePeek: 80,
            infinite: true,
            autoplay: false,
            autoplayDelay: 5000,
            ...config.options
        };

        // State
        this.slides = [];
        this.realCount = 0;
        this.cloneCount = 0;
        this.currentIndex = 0;
        this.slideWidth = 0;
        this.isAnimating = false;
        this.isDragging = false;
        this.startX = 0;
        this.currentX = 0;
        this.startY = 0;
        this.startTime = 0;
        this.autoplayInterval = null;
        this.resizeTimeout = null;
        this.lastWindowWidth = window.innerWidth;

        // Bound event handlers (for proper removal)
        this._handleTransitionEnd = this._handleTransitionEnd.bind(this);
        this._handleResize = this._handleResize.bind(this);
        this._handleKeydown = this._handleKeydown.bind(this);
    }

    /* ========================================
       Public Methods
       ======================================== */

    init() {
        if (!this.track) return this;

        this._setupSlides();
        this._setupDots();
        this._setupControls();
        this._setupDrag();
        this._setupEvents();

        if (this.options.autoplay) {
            this.startAutoplay();
        }

        return this;
    }

    destroy() {
        this.stopAutoplay();
        this._removeEvents();

        if (this.track) {
            this.track.removeEventListener('transitionend', this._handleTransitionEnd);
        }

        // Clear dots
        if (this.dotsContainer) {
            this.dotsContainer.innerHTML = '';
        }
    }

    next() {
        if (this.isAnimating || this.realCount <= 1) return;
        this.isAnimating = true;
        this.currentIndex++;
        this._setTransform(this.currentIndex, true);
    }

    prev() {
        if (this.isAnimating || this.realCount <= 1) return;
        this.isAnimating = true;
        this.currentIndex--;
        this._setTransform(this.currentIndex, true);
    }

    goTo(realIndex) {
        if (this.isAnimating || this.realCount <= 1) return;
        this.isAnimating = true;
        this.currentIndex = realIndex + this.cloneCount;
        this._setTransform(this.currentIndex, true);
    }

    startAutoplay() {
        if (this.autoplayInterval) return;
        this.autoplayInterval = setInterval(() => this.next(), this.options.autoplayDelay);
    }

    stopAutoplay() {
        if (this.autoplayInterval) {
            clearInterval(this.autoplayInterval);
            this.autoplayInterval = null;
        }
    }

    refresh() {
        this._setupSlides();
        this._setupDots();
        this._updateUI();
    }

    /* ========================================
       Private Methods - Setup
       ======================================== */

    _setupSlides() {
        // Get real slides (remove any existing clones first)
        const allSlides = Array.from(this.track.querySelectorAll('.gallery-slide'));
        const realSlides = allSlides.filter(s => !s.classList.contains('clone'));
        this.realCount = realSlides.length;

        if (this.realCount <= 1) return;

        const slidesPerView = this._getSlidesPerView();
        this.cloneCount = this.options.infinite
            ? Math.min(slidesPerView, this.realCount - 1)
            : 0;

        // Clear track
        this.track.innerHTML = '';

        // Add left clones (last N slides)
        for (let i = this.realCount - this.cloneCount; i < this.realCount; i++) {
            const clone = realSlides[i].cloneNode(true);
            clone.classList.add('clone');
            clone.dataset.originalIndex = i;
            clone.removeAttribute('id');
            this.track.appendChild(clone);
        }

        // Add real slides
        realSlides.forEach((slide, i) => {
            slide.dataset.index = i;
            this.track.appendChild(slide);
        });

        // Add right clones (first N slides)
        for (let i = 0; i < this.cloneCount; i++) {
            const clone = realSlides[i].cloneNode(true);
            clone.classList.add('clone');
            clone.dataset.originalIndex = i;
            clone.removeAttribute('id');
            this.track.appendChild(clone);
        }

        // Set initial position to first real slide
        this.currentIndex = this.cloneCount;
        this._setTransform(this.currentIndex, false);
        this._updateUI();
    }

    _setupDots() {
        if (!this.dotsContainer || !this.options.infinite) return;

        this.dotsContainer.innerHTML = '';
        for (let i = 0; i < this.realCount; i++) {
            const dot = document.createElement('button');
            dot.className = 'gallery-dot' + (i === 0 ? ' active' : '');
            dot.setAttribute('aria-label', `Go to slide ${i + 1}`);
            dot.addEventListener('click', () => this.goTo(i));
            this.dotsContainer.appendChild(dot);
        }
    }

    _setupControls() {
        if (this.prevBtn) {
            this.prevBtn.addEventListener('click', () => this.prev());
        }
        if (this.nextBtn) {
            this.nextBtn.addEventListener('click', () => this.next());
        }
    }

    _setupDrag() {
        const track = this.track;
        if (!track) return;

        const onStart = (clientX, clientY) => {
            if (this.isAnimating) return;
            this.isDragging = true;
            this.startX = clientX;
            this.currentX = clientX;
            this.startY = clientY;
            this.startTime = Date.now();
            track.style.transition = 'none';
            track.style.cursor = 'grabbing';
            this.stopAutoplay();
        };

        const onMove = (clientX) => {
            if (!this.isDragging) return;
            this.currentX = clientX;
            const diff = clientX - this.startX;
            const currentOffset = this._getOffset(this.currentIndex);
            track.style.transform = `translateX(${currentOffset + diff}px)`;
        };

        const onEnd = () => {
            if (!this.isDragging) return;
            this.isDragging = false;
            track.style.cursor = '';

            const diff = this.currentX - this.startX;
            const elapsed = Date.now() - this.startTime;
            const threshold = 50;

            // Velocity-based swipe detection
            const velocity = Math.abs(diff) / (elapsed || 1);
            const isFlick = velocity > 0.5 && Math.abs(diff) > 30;

            if (diff > threshold || (isFlick && diff > 0)) {
                this.prev();
            } else if (diff < -threshold || (isFlick && diff < 0)) {
                this.next();
            } else {
                this._setTransform(this.currentIndex, true);
            }

            if (this.options.autoplay) {
                this.startAutoplay();
            }
        };

        // Touch events
        track.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            this.startY = touch.clientY;
            onStart(touch.clientX, touch.clientY);
        }, { passive: true });

        track.addEventListener('touchmove', (e) => {
            if (!this.isDragging) return;
            const touch = e.touches[0];
            const diffX = Math.abs(touch.clientX - this.startX);
            const diffY = Math.abs(touch.clientY - (this.startY || touch.clientY));

            // If horizontal movement is greater, handle the swipe
            if (diffX > diffY && diffX > 10) {
                onMove(touch.clientX);
            }
        }, { passive: true });

        track.addEventListener('touchend', (e) => {
            if (e.changedTouches.length > 0) {
                this.currentX = e.changedTouches[0].clientX;
            }
            onEnd();
        });

        track.addEventListener('touchcancel', onEnd);

        // Mouse events (desktop)
        track.addEventListener('mousedown', (e) => {
            e.preventDefault();
            onStart(e.clientX, e.clientY);
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

        // Prevent default drag behavior on images
        track.querySelectorAll('img').forEach(img => {
            img.addEventListener('dragstart', (e) => e.preventDefault());
            img.style.webkitUserDrag = 'none';
        });
    }

    _setupEvents() {
        // Transition end
        this.track.addEventListener('transitionend', this._handleTransitionEnd);

        // Resize
        window.addEventListener('resize', this._handleResize);

        // Keyboard
        document.addEventListener('keydown', this._handleKeydown);
    }

    _removeEvents() {
        window.removeEventListener('resize', this._handleResize);
        document.removeEventListener('keydown', this._handleKeydown);
    }

    /* ========================================
       Private Methods - Event Handlers
       ======================================== */

    _handleTransitionEnd() {
        const { currentIndex, cloneCount, realCount } = this;
        let jumped = false;

        // If we're in the right clones, jump to beginning
        if (currentIndex >= cloneCount + realCount) {
            this.currentIndex = cloneCount;
            jumped = true;
        }
        // If we're in the left clones, jump to end
        else if (currentIndex < cloneCount) {
            this.currentIndex = cloneCount + realCount - 1;
            jumped = true;
        }

        if (jumped) {
            // Force reflow
            this.track.offsetHeight;
            this._setTransform(this.currentIndex, false);
        }

        this.isAnimating = false;
        this._updateUI();
    }

    _handleResize() {
        // Ignore resize events that only change height (iOS toolbar show/hide)
        const currentWidth = window.innerWidth;
        if (currentWidth === this.lastWindowWidth) return;
        this.lastWindowWidth = currentWidth;

        clearTimeout(this.resizeTimeout);
        this.resizeTimeout = setTimeout(() => {
            this.refresh();
        }, 200);
    }

    _handleKeydown(e) {
        if (e.key === 'ArrowLeft') this.prev();
        if (e.key === 'ArrowRight') this.next();
    }

    /* ========================================
       Private Methods - Helpers
       ======================================== */

    _getSlidesPerView() {
        const width = window.innerWidth;
        if (width >= 992) return this.options.slidesPerView.desktop;
        if (width >= 768) return this.options.slidesPerView.tablet;
        return this.options.slidesPerView.mobile;
    }

    _isMobile() {
        return window.innerWidth < 768;
    }

    _getRealIndex() {
        const { currentIndex, cloneCount, realCount } = this;
        let idx = currentIndex - cloneCount;
        while (idx < 0) idx += realCount;
        while (idx >= realCount) idx -= realCount;
        return idx;
    }

    _getOffset(index) {
        if (!this.track) return 0;

        if (this._isMobile()) {
            const viewportWidth = this.track.parentElement.offsetWidth;
            const peekWidth = Math.min(40, viewportWidth * 0.1);
            const gap = this.options.mobileGap;
            const slideW = viewportWidth - (peekWidth * 2) - gap;
            const centerOffset = (viewportWidth - slideW) / 2;
            return centerOffset - (index * (slideW + gap));
        } else {
            const viewportWidth = this.track.parentElement.offsetWidth;
            const slidesPerView = this._getSlidesPerView();
            const gapPixels = this.options.gap;
            const totalGap = gapPixels * (slidesPerView - 1);
            const slideW = (viewportWidth - totalGap) / slidesPerView;
            this.slideWidth = slideW + gapPixels;
            return -(index * this.slideWidth);
        }
    }

    _setTransform(index, animate = true) {
        if (!this.track) return;

        this.track.style.transition = animate
            ? 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)'
            : 'none';
        this.track.style.transform = `translateX(${this._getOffset(index)}px)`;

        if (animate) {
            this._updateActiveSlide();
        }
    }

    _updateDots() {
        if (!this.dotsContainer) return;
        const realIdx = this._getRealIndex();
        this.dotsContainer.querySelectorAll('.gallery-dot').forEach((dot, i) => {
            dot.classList.toggle('active', i === realIdx);
        });
    }

    _updateActiveSlide() {
        if (!this.track) return;
        const realIdx = this._getRealIndex();
        const allSlides = this.track.querySelectorAll('.gallery-slide');

        allSlides.forEach((slide) => {
            let slideRealIdx;
            if (slide.classList.contains('clone')) {
                const originalIndex = slide.dataset.originalIndex;
                slideRealIdx = originalIndex !== undefined ? parseInt(originalIndex) : -1;
            } else {
                slideRealIdx = parseInt(slide.dataset.index);
            }
            slide.classList.toggle('active', slideRealIdx === realIdx);
        });
    }

    _updateUI() {
        this._updateDots();
        this._updateActiveSlide();
    }
}

// Export for module systems or attach to window
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Gallery;
} else {
    window.Gallery = Gallery;
}
