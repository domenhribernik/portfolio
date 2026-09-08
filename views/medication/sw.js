// Installability only: no caching. A medication log must never be read from a
// stale cache, and the page is useless without the server anyway.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* let network handle */ });
