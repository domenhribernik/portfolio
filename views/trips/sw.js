// Trips service worker. The page has to open on a phone with no signal (a
// ferry, a mountain hut, roaming switched off), show the trips it last saw and
// take new photos into the queue, so the whole shell is precached:
// tests/trips-logic.test.mjs walks the page's imports and fails if a module is
// missing here, because one missing module breaks the whole module graph
// offline.
//
// Three caches:
//   trips-shell-vN  the app itself; bump N on a deploy that changes this list
//   trips-photos    photo bytes already seen, cache-first (a stored photo never
//                   changes; a new photo is a new uuid). Capped.
//   trips-tiles     map tiles already seen, never prefetched (OSM tile policy).
//                   Capped.
// JSON from the controller is never cached: it varies with the session, and
// the page keeps its own copy of what it last saw in IndexedDB.
const SHELL_CACHE = 'trips-shell-v1';
const PHOTO_CACHE = 'trips-photos';
const TILE_CACHE = 'trips-tiles';
const PHOTO_LIMIT = 900;
const TILE_LIMIT = 1500;

const SHELL = [
    './',
    'style.css',
    'script.js',
    'logic.js',
    'api.js',
    'map.js',
    'outbox.js',
    'photo.js',
    'storage.js',
    'manifest.json',
    'icon-192.png',
    'icon-512.png',
    'lib/leaflet/leaflet.js',
    'lib/leaflet/leaflet.css',
    'lib/leaflet/images/layers.png',
    'lib/leaflet/images/layers-2x.png',
    '../nebo/geo.js',
    '../../components/auth-gate.js',
    '../../components/back-link.js',
    '../../components/site-footer.js',
    '../../assets/favicon.ico',
    '../../assets/fonts/fonts.css',
    '../../assets/fonts/files/overpass-400-normal-latin-m81GlU9s.woff2',
    '../../assets/fonts/files/overpass-400-normal-latin-ext-GrU9vyww.woff2',
    '../../assets/fonts/files/overpass-mono-400-normal-latin-AC1i-0tg.woff2',
    '../../assets/fonts/files/overpass-mono-400-normal-latin-ext-1iG0ts-2.woff2',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            // addAll is all-or-nothing; one 404 would leave no shell at all.
            .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys
                .filter((k) => k.startsWith('trips-shell-') && k !== SHELL_CACHE)
                .map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

/** Drop the oldest entries past the cap. Cache keys come back in insertion order. */
async function trim(name, limit) {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    const extra = keys.length - limit;
    for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
}

function cacheFirst(request, name, limit) {
    return caches.open(name).then((cache) => cache.match(request).then((hit) => {
        if (hit) return hit;
        return fetch(request).then((response) => {
            if (response.ok) {
                cache.put(request, response.clone()).then(() => trim(name, limit));
            }
            return response;
        });
    }));
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.hostname.includes('google-analytics') || url.hostname.includes('googletagmanager')) return;

    if (url.hostname === 'tile.openstreetmap.org') {
        event.respondWith(cacheFirst(request, TILE_CACHE, TILE_LIMIT).catch(() => Response.error()));
        return;
    }

    if (url.pathname.includes('/app/controllers/')) {
        // Photo bytes only: immutable per uuid, and private to this browser.
        if (url.pathname.endsWith('/trips-controller.php') && url.searchParams.get('resource') === 'photo') {
            event.respondWith(cacheFirst(request, PHOTO_CACHE, PHOTO_LIMIT).catch(() => Response.error()));
        }
        return;
    }

    if (url.origin !== self.location.origin) return;

    // The page network-first, so a deploy reaches people who are online, with
    // the cached shell answering when nothing does. Every hash route is the
    // same document, which is what lets #join= and deep links open offline.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(SHELL_CACHE).then((cache) => cache.put('./', copy));
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
                    if (response.ok) {
                        const copy = response.clone();
                        caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
                    }
                    return response;
                })
                .catch(() => cached);
            return cached || refresh;
        })
    );
});
