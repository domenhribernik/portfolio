(() => {
    // DOM Elements
    const loadingOverlay = document.getElementById('loading-overlay');
    const currentDateEl = document.getElementById('current-date');

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

    // Helper: Get first page title
    const getFirstPageTitle = (pages) => {
        if (!pages || !Array.isArray(pages) || pages.length === 0) return null;
        return stripHtml(pages[0]?.displaytitle || pages[0]?.title);
    };

    // Helper: Create item element with dropdown
    const createItemElement = (item, type) => {
        const div = document.createElement('div');
        div.className = 'otd-item';

        // Get year
        const year = item.year || '';
        
        // Get text and strip HTML
        const text = stripHtml(item.text || '');
        
        // Get first image
        const imageUrl = getFirstImage(item.pages);
        
        // Get extract_html and page info for dropdown
        const extractHtml = getExtractHtml(item.pages);
        const pageUrl = getFirstPageUrl(item.pages);
        const pageTitle = getFirstPageTitle(item.pages);

        // Year badge
        const yearBadge = year ? `<span class="year-badge">${year}</span>` : '';

        // Create dropdown HTML if extractHtml exists
        let dropdownHtml = '';
        if (extractHtml && pageUrl) {
            dropdownHtml = `
                <div class="item-dropdown">
                    <button class="dropdown-toggle" aria-expanded="false">
                        <span class="dropdown-text">Read more</span>
                        <span class="dropdown-arrow">▼</span>
                    </button>
                    <div class="dropdown-content">
                        <div class="extract-html">${extractHtml}</div>
                        <a href="${pageUrl}" target="_blank" rel="noopener" class="wiki-page-link">
                            <span>Read full article on Wikipedia</span>
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                        </a>
                    </div>
                </div>
            `;
        }

        // Build content based on whether we have an image
        if (imageUrl) {
            div.innerHTML = `
                <div class="item-with-image">
                    <img src="${imageUrl}" alt="${text.substring(0, 50)}" class="item-image" loading="lazy">
                    <div class="item-content">
                        ${yearBadge}
                        <p class="item-text">${text}</p>
                    </div>
                </div>
                ${dropdownHtml}
            `;
        } else {
            div.innerHTML = `
                ${yearBadge}
                <p class="item-text">${text}</p>
                ${dropdownHtml}
            `;
        }

        // Add click handler for dropdown
        const dropdownToggle = div.querySelector('.dropdown-toggle');
        if (dropdownToggle) {
            dropdownToggle.addEventListener('click', (e) => {
                e.preventDefault();
                const dropdown = dropdownToggle.closest('.item-dropdown');
                const isOpen = dropdown.classList.contains('open');
                
                // Close all other dropdowns
                document.querySelectorAll('.item-dropdown.open').forEach(d => {
                    if (d !== dropdown) {
                        d.classList.remove('open');
                        d.querySelector('.dropdown-toggle').setAttribute('aria-expanded', 'false');
                    }
                });
                
                // Toggle current dropdown
                dropdown.classList.toggle('open');
                dropdownToggle.setAttribute('aria-expanded', !isOpen);
            });
        }

        return div;
    };

    // Helper: Create loading placeholder
    const createLoadingPlaceholder = () => {
        const div = document.createElement('div');
        div.className = 'loading-item';
        div.innerHTML = `
            <div class="loading-badge"></div>
            <div class="loading-text"></div>
        `;
        return div;
    };

    // Helper: Show error message
    const showError = (container) => {
        container.innerHTML = `
            <div class="error-message">
                <div class="error-icon">⚠️</div>
                <p>Unable to load data. Please try again later.</p>
            </div>
        `;
    };

    // Helper: Show empty message
    const showEmpty = (container) => {
        container.innerHTML = `
            <div class="empty-message">
                No entries available for today.
            </div>
        `;
    };

    // Populate section with data
    const populateSection = (containerId, data, type) => {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = '';

        if (!data || data.length === 0) {
            showEmpty(container);
            return;
        }

        // Limit to first 20 items to prevent overwhelming the UI
        const itemsToShow = data.slice(0, 20);
        
        itemsToShow.forEach(item => {
            const itemEl = createItemElement(item, type);
            container.appendChild(itemEl);
        });
    };

    // Fetch data from API
    const fetchData = async () => {
        const eventsContainer = document.getElementById('events-container');
        const birthsContainer = document.getElementById('births-container');
        const deathsContainer = document.getElementById('deaths-container');

        // Add loading placeholders
        [eventsContainer, birthsContainer, deathsContainer].forEach(container => {
            if (container) {
                container.innerHTML = '';
                for (let i = 0; i < 4; i++) {
                    container.appendChild(createLoadingPlaceholder());
                }
            }
        });

        try {
            const response = await fetch('../php/otd-proxy.php');
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            // Hide loading overlay
            loadingOverlay?.classList.add('hidden');

            // Populate sections (no holidays)
            populateSection('events-container', data.events?.events, 'events');
            populateSection('births-container', data.births?.births, 'births');
            populateSection('deaths-container', data.deaths?.deaths, 'deaths');

        } catch (error) {
            console.error('Error fetching data:', error);
            
            // Hide loading overlay
            loadingOverlay?.classList.add('hidden');

            // Show error in all containers
            [eventsContainer, birthsContainer, deathsContainer].forEach(container => {
                if (container) showError(container);
            });
        }
    };

    // Initialize
    fetchData();
})();
