// Pure, DOM-free logic for the homepage APOD section. Imported by both
// apod.js (the page renderer) and tests/homepage-apod.test.mjs.

export function resolveMedia(d) {
    if (d.media_type === 'video') {
        return { kind: 'video', src: d.url, full: d.url };
    }
    return { kind: 'image', src: d.url, full: d.hdurl || d.url };
}

export function classifyAspect(width, height) {
    const r = width / height;
    if (!(r > 0) || !isFinite(r)) return 'landscape';
    if (r < 0.8) return 'portrait';
    if (r < 1.25) return 'square';
    if (r <= 2.2) return 'landscape';
    return 'panorama';
}
