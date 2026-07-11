// ===== APOD (Astronomy Picture of the Day) =====
// Renders the homepage APOD section. Layout logic (aspect classification,
// image vs video resolution) lives in apod-logic.js and is unit-tested in
// tests/homepage-apod.test.mjs; this file is the DOM glue only.

import { classifyAspect, resolveMedia } from './apod-logic.js';

(async () => {
    const spinner = document.getElementById('apod-spinner');
    const body    = document.getElementById('apod-body');
    const content = document.querySelector('.apod-content');
    const mediaEl = document.getElementById('apod-media');

    // The whole media column carries the orientation hook so CSS can tune the
    // image caps AND the text column from a single attribute.
    const setOrientation = (o) => content.setAttribute('data-orientation', o);

    const buildImage = (media, title) => {
        const img = document.createElement('img');
        img.className = 'apod-img';
        img.alt = title;
        img.title = title;
        img.decoding = 'async';
        // Neutral default until we can measure the real aspect ratio.
        setOrientation('landscape');
        img.addEventListener('load', () => {
            setOrientation(classifyAspect(img.naturalWidth, img.naturalHeight));
        }, { once: true });
        img.src = media.src;

        // Floating tag signalling the picture opens at full resolution. It is
        // pointer-events:none in CSS, so a click on it falls through to the
        // media wrapper's handler below.
        const tag = document.createElement('span');
        tag.className = 'apod-open-tag';
        tag.innerHTML = '<i class="fas fa-expand" aria-hidden="true"></i> View full size';

        mediaEl.onclick = () => window.open(media.full, '_blank', 'noopener');
        mediaEl.replaceChildren(img, tag);
    };

    const buildVideo = (media, title) => {
        // Videos have no meaningful still aspect; treat as landscape and let the
        // 16:9 frame do the sizing.
        setOrientation('landscape');
        mediaEl.onclick = null; // the video plays in place; nothing to open
        const frame = document.createElement('div');
        frame.className = 'apod-video';
        const iframe = document.createElement('iframe');
        iframe.src = media.src;
        iframe.title = title;
        iframe.loading = 'lazy';
        iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
        iframe.setAttribute('allowfullscreen', '');
        frame.appendChild(iframe);
        mediaEl.replaceChildren(frame);
    };

    const renderApod = (d) => {
        document.getElementById('apod-title').textContent   = d.title;
        document.getElementById('apod-date').textContent    = new Date(d.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        document.getElementById('apod-explain').textContent = d.explanation;
        document.getElementById('apod-link').href           = `https://apod.nasa.gov/apod/ap${d.date.replace(/-/g, '').slice(2)}.html`;
        document.getElementById('apod-copy').textContent    = d.copyright ? `© ${d.copyright.trim()}` : '';

        const media = resolveMedia(d);
        content.setAttribute('data-kind', media.kind);
        if (media.kind === 'video') buildVideo(media, d.title);
        else buildImage(media, d.title);
    };

    try {
        const res = await fetch('app/proxys/apod-proxy.php');
        if (!res.ok) throw new Error(res.status);
        const d = await res.json();

        renderApod(d);
        spinner.hidden = true;
        body.hidden    = false;

        // If what we got isn't today's date, try to fetch fresh in the background.
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
