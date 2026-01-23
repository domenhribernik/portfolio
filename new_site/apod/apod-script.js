class APODViewer {
    constructor() {
        this.cacheKey = 'nasa-apod-cache';
        this.cacheDuration = 24 * 60 * 60 * 1000; // 24 hours
        this.phpProxyUrl = 'apod-proxy.php'; // Adjust path if needed
        
        this.elements = {
            loading: document.getElementById('apod-loading'),
            error: document.getElementById('apod-error'),
            content: document.getElementById('apod-content'),
            title: document.getElementById('apod-title'),
            date: document.getElementById('apod-date'),
            image: document.getElementById('apod-image'),
            video: document.getElementById('apod-video'),
            explanation: document.getElementById('apod-explanation'),
            link: document.getElementById('apod-link'),
            copyright: document.getElementById('apod-copyright'),
            retryBtn: document.getElementById('retry-btn')
        };

        this.elements.retryBtn.addEventListener('click', () => this.loadAPOD());
        
        // Load on page load
        this.loadAPOD();
    }

    async loadAPOD() {
        this.showLoading();
        
        try {
            const data = await this.fetchAPOD();
            this.render(data);
        } catch (error) {
            console.error('APOD Load Error:', error);
            this.showError(error.message);
        }
    }

    async fetchAPOD() {
        // Try cache first
        const cached = this.getCachedAPOD();
        if (cached) {
            console.log('Serving from cache');
            return cached;
        }

        // Fetch from server
        const response = await fetch(this.phpProxyUrl);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        // Validate required fields
        if (!data.title || !data.url) {
            throw new Error('Invalid API response format');
        }

        // Cache the data
        this.cacheAPOD(data);
        
        return data;
    }

    getCachedAPOD() {
        try {
            const cached = localStorage.getItem(this.cacheKey);
            if (!cached) return null;

            const { data, timestamp } = JSON.parse(cached);
            
            // Check if cache is stale
            if (Date.now() - timestamp > this.cacheDuration) {
                localStorage.removeItem(this.cacheKey);
                return null;
            }

            return data;
        } catch (error) {
            console.warn('Cache read failed:', error);
            return null;
        }
    }

    cacheAPOD(data) {
        try {
            const toCache = {
                data: data,
                timestamp: Date.now()
            };
            localStorage.setItem(this.cacheKey, JSON.stringify(toCache));
        } catch (error) {
            console.warn('Cache write failed:', error);
        }
    }

    render(data) {
        // Update content
        this.elements.title.textContent = data.title;
        this.elements.date.textContent = new Date(data.date).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        this.elements.explanation.textContent = data.explanation;
        this.elements.link.href = `https://apod.nasa.gov/apod/ap${data.date.replace(/-/g, '').slice(2)}.html`;

        // Handle media type
        if (data.media_type === 'video') {
            this.elements.image.classList.add('hidden');
            this.elements.video.classList.remove('hidden');
            this.elements.video.src = data.url;
            this.elements.image.alt = '';
        } else {
            this.elements.video.classList.add('hidden');
            this.elements.image.classList.remove('hidden');
            this.elements.image.src = data.url;
            this.elements.image.alt = data.title;
        }

        // Handle copyright
        if (data.copyright) {
            this.elements.copyright.textContent = `© ${data.copyright}`;
            this.elements.copyright.classList.remove('hidden');
        } else {
            this.elements.copyright.classList.add('hidden');
        }

        this.showContent();
    }

    showLoading() {
        this.elements.loading.classList.add('active');
        this.elements.error.classList.add('hidden');
        this.elements.content.classList.add('hidden');
    }

    showContent() {
        this.elements.loading.classList.remove('active');
        this.elements.error.classList.add('hidden');
        this.elements.content.classList.remove('hidden');
    }

    showError(message) {
        this.elements.loading.classList.remove('active');
        this.elements.error.classList.remove('hidden');
        this.elements.content.classList.add('hidden');
        
        this.elements.error.querySelector('.error-message').textContent = 
            message || 'Unable to load the cosmic view. Please try again later.';
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new APODViewer());
} else {
    new APODViewer();
}