// Nebo service worker. The whole planetarium is computed client-side, so a
// cached shell makes it work with no signal at all: the right tool under a
// dark-site sky. HTML goes network-first (updates propagate), everything else
// stale-while-revalidate.
const CACHE = 'nebo-v3';
const SHELL = [
    './',
    'style.css',
    'script.js',
    'logic.js',
    'render.js',
    'i18n.js',
    'zoom.js',
    'geo.js',
    'location-map.js',
    'lang/en.json',
    'lang/sl.json',
    'stars.json',
    'constellations.json',
    'manifest.json',
    '../../components/back-link.js',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k.startsWith('nebo-') && k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.hostname.includes('google-analytics') || url.hostname.includes('googletagmanager')) return;

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

    // stale-while-revalidate for the shell, catalogs, Tailwind and fonts
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
