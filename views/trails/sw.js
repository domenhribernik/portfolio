// Trails service worker. This view is the one on the site that genuinely has
// to work with the network off, so the shell is precached in full: Leaflet,
// the fonts, and the whole vector chart, not just the HTML.
//
// There is no tile cache, because there are no tiles. The chart is drawn from
// the bundled Natural Earth data, so once this list is cached the entire app
// is offline-complete and there is nothing left that a flight could need and
// not have.
// v2: v1 installed against a deploy where these assets were missing (they sat
// under a folder named `vendor`, which .gitignore and the deploy both skip),
// so every Leaflet and font entry failed its `cache.add` and the shell was
// cached incomplete. Bumping forces a reinstall so those users get back to
// offline-complete rather than silently depending on the network for the chart.
const CACHE = 'trails-v2';

const SHELL = [
    './',
    'style.css',
    'script.js',
    'logic.js',
    'storage.js',
    'map.js',
    'sync.js',
    'manifest.json',
    'icon-192.png',
    'icon-512.png',
    'lib/leaflet/leaflet.js',
    'lib/leaflet/leaflet.css',
    'lib/leaflet/images/marker-icon.png',
    'lib/leaflet/images/marker-icon-2x.png',
    'lib/leaflet/images/marker-shadow.png',
    'lib/leaflet/images/layers.png',
    'lib/leaflet/images/layers-2x.png',
    'lib/fonts/b612-400.woff2',
    'lib/fonts/b612-700.woff2',
    'lib/fonts/b612mono-400.woff2',
    'lib/fonts/b612mono-700.woff2',
    'data/countries.geojson',
    'data/lakes.geojson',
    'data/places.json',
    '../../components/back-link.js',
    // script.js imports this: miss it and the whole module graph fails offline.
    '../../components/auth-gate.js',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            // addAll is all-or-nothing; one 404 would leave the app with no
            // shell at all, so each entry is allowed to fail on its own.
            .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys
                .filter((k) => k.startsWith('trails-') && k !== CACHE)
                .map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.hostname.includes('google-analytics') || url.hostname.includes('googletagmanager')) return;

    // Never cache the controller: its responses vary with the session cookie
    // and are sent no-store for exactly that reason.
    if (url.pathname.includes('/app/controllers/')) return;

    // HTML network-first, so a deploy reaches people who are online, with the
    // cached shell answering when nothing does. Query strings and hashes all
    // resolve to the same shell, which is what makes ?t=<token> work offline
    // far enough to render its "needs a connection" state.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(CACHE).then((cache) => cache.put('./', copy));
                    return response;
                })
                .catch(() => caches.match('./'))
        );
        return;
    }

    event.respondWith(
        caches.match(request).then((cached) => {
            const refresh = fetch(request)
                .then((response) => {
                    if (response.ok || response.type === 'opaque') {
                        const copy = response.clone();
                        caches.open(CACHE).then((cache) => cache.put(request, copy));
                    }
                    return response;
                })
                .catch(() => cached);
            return cached || refresh;
        })
    );
});
