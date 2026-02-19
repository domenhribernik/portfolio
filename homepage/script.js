window.addEventListener('load', () => {
    document.getElementById('loadingOverlay').classList.add('hidden');
});

window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('currentYear').textContent = new Date().getFullYear();

    //? Intersection Observer for scroll animations
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = '1';
                entry.target.style.transform = 'translateY(0)';
            }
        });
    }, observerOptions);

    //? Observe elements for animations
    document.querySelectorAll('.project-card, .contact-card').forEach(el => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(30px)';
        el.style.transition = 'all 0.6s ease';
        observer.observe(el);
    });

    //? Typing effect for hero subtitle
    function typeWriter(element, text, speed = 100) {
        let i = 0;
        element.innerHTML = '';

        function type() {
            if (i < text.length) {
                element.innerHTML += text.charAt(i);
                i++;
                setTimeout(type, speed);
            }
        }

        type();
    }

    setTimeout(() => {
        if (heroSubtitle) {
            typeWriter(heroSubtitle, subtitles, 80);
        }
    }, 1000);

    //? Particle effect for hero background
    function createParticles() {
        const hero = document.querySelector('.hero');
        if (!hero) return;

        const particlesContainer = document.createElement('div');
        particlesContainer.className = 'particles-container';
        particlesContainer.style.position = 'absolute';
        particlesContainer.style.top = '0';
        particlesContainer.style.left = '0';
        particlesContainer.style.width = '100%';
        particlesContainer.style.height = '100%';
        particlesContainer.style.pointerEvents = 'none';
        particlesContainer.style.zIndex = '1';
        particlesContainer.style.overflow = 'hidden';

        hero.appendChild(particlesContainer);

        function createSingleParticle() {
            const particle = document.createElement('div');
            const size = Math.random() * 3 + 1; // 1-4px
            const opacity = Math.random() * 0.2 + 0.1; // 0.1-0.3 opacity
            const animationDuration = Math.random() * 8 + 10; // 10-18s

            particle.style.position = 'absolute';
            particle.style.width = size + 'px';
            particle.style.height = size + 'px';
            particle.style.background = `rgba(255, 255, 255, ${opacity})`;
            particle.style.borderRadius = '50%';
            particle.style.left = Math.random() * 100 + '%';
            particle.style.top = '100vh';
            particle.style.boxShadow = `0 0 ${size * 3}px rgba(255, 255, 255, ${opacity * 0.5})`;
            particle.style.animation = `floatUp ${animationDuration}s linear forwards`;

            particlesContainer.appendChild(particle);

            setTimeout(() => {
                if (particle.parentNode) {
                    particle.parentNode.removeChild(particle);
                }
            }, animationDuration * 1000);
        }

        for (let i = 0; i < 50; i++) {
            setTimeout(() => createSingleParticle(), Math.random() * 5000);
        }

        // Continuously create new particles
        setInterval(() => {
            createSingleParticle();
        }, 300); // New particle every 300ms
    }

    const style = document.createElement('style');
    style.textContent = `
        @keyframes floatUp {
            0% {
                transform: translateY(0) translateX(0) rotate(0deg) scale(0.8);
                opacity: 0;
            }
            10% {
                opacity: 1;
                transform: translateY(-10vh) translateX(5px) rotate(36deg) scale(1);
            }
            50% {
                transform: translateY(-50vh) translateX(-10px) rotate(180deg) scale(1.2);
            }
            90% {
                opacity: 1;
                transform: translateY(-90vh) translateX(8px) rotate(324deg) scale(1);
            }
            100% {
                transform: translateY(-110vh) translateX(0) rotate(360deg) scale(0.8);
                opacity: 0;
            }
        }

        .project-card:hover .project-image i {
            transform: scale(1.2) rotate(5deg);
            transition: transform 0.3s ease;
        }

        .contact-card:hover .contact-icon {
            transform: scale(1.1) rotate(5deg);
            transition: transform 0.3s ease;
        }

        .hero-content {
            animation: fadeInUp 1s ease 0.5s both;
        }

        @keyframes fadeInUp {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
    `;
    document.head.appendChild(style);

    createParticles();

    //? Parallax effect for sections
    window.addEventListener('scroll', () => {
        const scrolled = window.pageYOffset;
        const rate = scrolled * -0.5;

        const hero = document.querySelector('.hero');
        if (hero) {
            hero.style.transform = `translateY(${rate}px)`;
        }
    });

    //? Add ripple effect to buttons
    function addRippleEffect() {
        const buttons = document.querySelectorAll('.cta-button, .project-link, .social-link');

        buttons.forEach(button => {
            button.addEventListener('click', function (e) {
                const ripple = document.createElement('span');
                const rect = this.getBoundingClientRect();
                const size = Math.max(rect.width, rect.height);
                const x = e.clientX - rect.left - size / 2;
                const y = e.clientY - rect.top - size / 2;

                ripple.style.width = ripple.style.height = size + 'px';
                ripple.style.left = x + 'px';
                ripple.style.top = y + 'px';
                ripple.classList.add('ripple');

                this.appendChild(ripple);

                setTimeout(() => {
                    ripple.remove();
                }, 600);
            });
        });
    }

    const rippleStyle = document.createElement('style');
    rippleStyle.textContent = `
                .ripple {
                    position: absolute;
                    border-radius: 50%;
                    background: rgba(255, 255, 255, 0.3);
                    transform: scale(0);
                    animation: rippleEffect 0.6s linear;
                    pointer-events: none;
                }

                @keyframes rippleEffect {
                    to {
                        transform: scale(4);
                        opacity: 0;
                    }
                }

                .cta-button, .project-link, .social-link {
                    position: relative;
                    overflow: hidden;
                }
            `;
    document.head.appendChild(rippleStyle);

    addRippleEffect();

    //? Show More functionality for project categories
    const initShowMore = () => {
        const categories = document.querySelectorAll('.project-category');

        categories.forEach(category => {
            // Skip if already initialized
            if (category.dataset.showMoreInitialized) return;

            const projects = category.querySelectorAll('.project-card');
            if (projects.length > 3) {
                projects.forEach((project, index) => {
                    if (index >= 3) {
                        project.style.display = 'none';
                    }
                });

                const toggleBtn = document.createElement('button');
                toggleBtn.className = 'show-more-btn';
                toggleBtn.style.marginTop = '1rem';

                const engSpan = document.createElement('span');
                engSpan.className = 'lang-eng';
                engSpan.textContent = 'Show More...';

                const sloSpan = document.createElement('span');
                sloSpan.className = 'lang-slo';
                sloSpan.textContent = 'Prikaži Več...';

                toggleBtn.appendChild(engSpan);
                toggleBtn.appendChild(sloSpan);

                let expanded = false;
                toggleBtn.addEventListener('click', () => {
                    expanded = !expanded;

                    projects.forEach((project, index) => {
                        if (index >= 3) {
                            project.style.display = expanded ? 'flex' : 'none';
                        }
                    });

                    engSpan.textContent = expanded ? 'Show Less...' : 'Show More...';
                    sloSpan.textContent = expanded ? 'Prikaži Manj...' : 'Prikaži Več...';
                });

                category.querySelector('.projects-grid').after(toggleBtn);
                category.dataset.showMoreInitialized = 'true';
            }
        });
    };

    // Wait for custom elements to be defined before initializing
    customElements.whenDefined('project-card').then(() => {
        // Small delay to ensure all cards are rendered
        setTimeout(initShowMore, 100);
    });

    //? Thesis video zoom effect
    const videoWrapper = document.querySelector('.overview-video');
    if (window.matchMedia('(min-width: 769px)').matches && videoWrapper) {
        videoWrapper.addEventListener('click', () => videoWrapper.classList.toggle('active'));
    }

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

    const fetchData = async () => {
        const track = document.getElementById('featured-track');

        if (track) {
            track.innerHTML = '';
            for (let i = 0; i < 3; i++) track.appendChild(createGalleryPlaceholder());
        }

        try {
            const response = await fetch('../php/otd-proxy.php');
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
