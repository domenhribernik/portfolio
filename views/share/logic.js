// DOM-free decision logic for the share page, unit-tested by
// tests/share-logic.test.mjs (node --test tests/). script.js imports this as
// an ES module and does nothing but move the results into the page.
//
// Everything in views/share is deliberately self-contained: no ../../ imports,
// no shared components. The share subdomain's document root points straight at
// this directory, so a path that climbs out of it works on the main domain and
// silently 404s on the subdomain. See CLAUDE.md next to this file.

export const PAPER = '#f6f2ea';
export const INK = '#1c1a17';
export const CLAY = '#d4451f';

//? How far a card's colour is pulled toward paper before it is drawn as the
//? band across the top of the card. High enough that the band reads as a tint
//? of the project rather than a slab of colour on a paper ground.
const SUBTLE_MIX = 0.78;

//? The accent carries the icon, the rules and the hard shadows. 3.5:1 clears
//? the 3:1 floor WCAG sets for large text and UI components with a little
//? headroom, and is chosen so that clay itself (4.03:1 on paper, the site's
//? own voice) passes untouched rather than being darkened into something else.
export const ACCENT_MIN_CONTRAST = 3.5;
const ACCENT_STEPS = 24;

const FALLBACK_ICON = 'fas fa-link';
const FALLBACK_GRADIENT = 'linear-gradient(45deg, #1c1a17 0%, #d4451f 100%)';

//? A share address is a page path and nothing else. Everything outside this
//? set is refused rather than escaped, because the result is concatenated onto
//? the site origin and put in an href.
const SAFE_PATH = /^[A-Za-z0-9._~/-]*$/;
const MAX_PATH_LENGTH = 200;

//? ------------------------------------------------------------------ routing

function isShareHost(hostname) {
    return /^share\./i.test(String(hostname || ''));
}

// Where the visitor is asking to point the code. On the share subdomain the
// path is the target, so share.<site>/views/tells/ shares /views/tells/. Read
// off any other host the pathname is this page's own address, so only an
// explicit ?p= counts there and the page cannot end up sharing itself.
export function targetPathFrom({ hostname = '', pathname = '', search = '' } = {}) {
    const explicit = new URLSearchParams(search).get('p');
    if (explicit !== null) return explicit;
    if (isShareHost(hostname)) return String(pathname).replace(/^\/+/, '');
    return '';
}

// Reduce a raw address to a site-root-relative page path, or null if it is not
// one. Returns '' for the homepage, which is a valid target, so callers must
// check for null rather than falsiness.
export function normalizeSharePath(raw, knownPages) {
    if (raw === null || raw === undefined) return null;

    let text = String(raw);
    if (text.length > MAX_PATH_LENGTH) return null;
    try {
        text = decodeURIComponent(text);
    } catch {
        return null; // a malformed escape is not a page
    }
    if (text.length > MAX_PATH_LENGTH) return null;
    if (!SAFE_PATH.test(text)) return null;
    if (text.includes('..')) return null;

    const segments = text.split('/').filter(Boolean);
    if (segments.at(-1) === 'index.html') segments.pop();

    // No page on this site has a dot in a path segment. Refusing them is what
    // separates the collapsible "//views//tells//" from "//evil.test", which
    // is otherwise made of the same characters.
    if (segments.some((segment) => segment.includes('.'))) return null;

    const path = segments.join('/');
    if (path === '') return '';

    // Accept the pretty form the production rewrites serve, so share.<site>/rocks
    // finds the same card as share.<site>/views/rocks.
    const known = Array.isArray(knownPages) ? knownPages : Object.keys(knownPages || {});
    if (known.includes(path)) return path;
    if (known.includes(`views/${path}`)) return `views/${path}`;
    return path;
}

export function targetUrl(origin, path) {
    const base = String(origin || '').replace(/\/+$/, '');
    const clean = String(path || '').replace(/^\/+|\/+$/g, '');
    return clean ? `${base}/${clean}/` : `${base}/`;
}

export function shareOriginFor(origin) {
    const url = String(origin || '').replace(/\/+$/, '');
    const parts = url.match(/^([a-z][a-z0-9+.-]*:\/\/)(.+)$/i);
    if (!parts) return url;
    const [, scheme, host] = parts;
    return isShareHost(host) ? url : `${scheme}share.${host}`;
}

//? --------------------------------------------------------------- card lookup

// A readable name for a page the catalog has never heard of, so an unlisted
// URL still gets a card with something on it rather than a bare address.
export function prettyTitleFromPath(path) {
    const last = String(path || '').split('/').filter(Boolean).at(-1);
    if (!last) return 'Home';
    return last.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function resolveCard(catalog, path) {
    const key = String(path ?? '');
    const url = targetUrl(catalog?.origin, key);
    const card = catalog?.pages?.[key];

    if (card) {
        return {
            registered: true,
            path: key,
            url,
            title: card.title,
            description: card.description,
            icon: card.icon,
            gradient: card.gradient,
        };
    }

    return {
        registered: false,
        path: key,
        url,
        title: prettyTitleFromPath(key),
        description: '',
        icon: FALLBACK_ICON,
        gradient: FALLBACK_GRADIENT,
    };
}

export function indexEntries(catalog) {
    const origin = catalog?.origin;
    return Object.entries(catalog?.pages || {}).map(([path, card]) => ({
        path,
        title: card.title,
        description: card.description,
        icon: card.icon,
        gradient: card.gradient,
        url: targetUrl(origin, path),
    }));
}

//? ------------------------------------------------------------------- colour

function toRgb(hex) {
    const clean = String(hex || '').replace('#', '');
    return [
        parseInt(clean.slice(0, 2), 16) || 0,
        parseInt(clean.slice(2, 4), 16) || 0,
        parseInt(clean.slice(4, 6), 16) || 0,
    ];
}

function toHex(r, g, b) {
    return '#' + [r, g, b]
        .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
        .join('');
}

// The registry writes every gradient as linear-gradient(45deg, #x 0%, #y 100%).
// Anything else is not something this page can take a colour from.
export function parseGradientStops(gradient) {
    if (typeof gradient !== 'string') return null;
    const hexes = gradient.match(/#[0-9a-f]{6}\b/gi);
    if (!hexes || hexes.length < 2) return null;
    return [hexes[0].toLowerCase(), hexes[1].toLowerCase()];
}

export function mixHex(from, to, amount) {
    const a = toRgb(from);
    const b = toRgb(to);
    const t = Math.max(0, Math.min(1, Number(amount) || 0));
    return toHex(
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    );
}

export function relativeLuminance(hex) {
    const [r, g, b] = toRgb(hex).map((value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// The project's colour, pulled far enough toward paper to sit as a band on a
// warm ground without becoming a second surface.
export function subtleGradient(gradient) {
    const [from, to] = parseGradientStops(gradient) || [INK, CLAY];
    return `linear-gradient(90deg, ${mixHex(from, PAPER, SUBTLE_MIX)} 0%, `
        + `${mixHex(to, PAPER, SUBTLE_MIX)} 100%)`;
}

// The card's single accent, taken from the gradient's second stop and inked
// down until it actually reads on paper. Several registry gradients end pale
// (#f093fb, #a779e9), and used as given they disappear as a hairline.
export function readableAccent(gradient, ground = PAPER) {
    const stops = parseGradientStops(gradient);
    const source = stops ? stops[1] : CLAY;
    for (let step = 0; step <= ACCENT_STEPS; step++) {
        const candidate = step === 0 ? source : mixHex(source, INK, step / ACCENT_STEPS);
        if (contrastRatio(candidate, ground) >= ACCENT_MIN_CONTRAST) return candidate;
    }
    return INK;
}

//? ----------------------------------------------------------------- svg path

// The whole module grid as one path, merging each horizontal run into a single
// rectangle. One <path> in one <svg> keeps the DOM at a couple of nodes and
// stays crisp at any size, which a grid of hundreds of <rect> elements does not.
export function qrSvgPath(modules, size) {
    const parts = [];
    for (let row = 0; row < size; row++) {
        let run = 0;
        for (let col = 0; col <= size; col++) {
            if (col < size && modules[row * size + col]) {
                run++;
                continue;
            }
            if (run) {
                parts.push(`M${col - run} ${row}h${run}v1h-${run}z`);
                run = 0;
            }
        }
    }
    return parts.join('');
}
