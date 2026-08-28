// Unit tests for the share page's decision logic (views/share/logic.js).
// Run with: node --test tests/
//
// Two things here are load-bearing beyond the usual. First, the page is
// reached two ways (a share. subdomain where the path is the target, and a
// ?p= query on the main domain), and getting that wrong makes the page either
// resolve itself forever or ignore its own address. Second, the target path
// arrives from the URL and ends up in an href, so normalizeSharePath is a
// security boundary, not a tidy-up: everything it lets through is later
// concatenated onto the site origin.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    targetPathFrom,
    normalizeSharePath,
    targetUrl,
    shareOriginFor,
    prettyTitleFromPath,
    resolveCard,
    indexEntries,
    parseGradientStops,
    mixHex,
    relativeLuminance,
    contrastRatio,
    subtleGradient,
    readableAccent,
    qrSvgPath,
    ACCENT_MIN_CONTRAST,
} from '../views/share/logic.js';

const ORIGIN = 'https://domenhribernik.com';

const catalog = {
    origin: ORIGIN,
    pages: {
        '': { title: 'Domen Hribernik', description: 'The site itself.', icon: 'fas fa-house', gradient: 'linear-gradient(45deg, #1c1a17 0%, #6b6256 100%)' },
        'views/tells': { title: 'Tells', description: 'Forty-eight of them on one grid.', icon: 'fas fa-crosshairs', gradient: 'linear-gradient(45deg, #1c1a17 0%, #d4451f 100%)' },
        'views/rocks': { title: 'Our Rock Pile', description: 'A small 3D museum.', icon: 'fas fa-gem', gradient: 'linear-gradient(45deg, #4a4036 0%, #a49a8a 100%)' },
    },
};

//? ------------------------------------------------------------------ routing

test('on the share subdomain the path itself is the target', () => {
    const at = (pathname) => targetPathFrom({
        hostname: 'share.domenhribernik.com', pathname, search: '',
    });
    assert.equal(at('/views/tells/'), 'views/tells/');
    assert.equal(at('/views/blog/building-this-blog/'), 'views/blog/building-this-blog/');
    assert.equal(at('/'), '');
    assert.equal(at(''), '');
});

test('anywhere else only the p query counts, so the page never resolves itself', () => {
    // Served from the main domain the pathname is /views/share/, which would
    // otherwise be read as a request to share the share page forever.
    assert.equal(targetPathFrom({
        hostname: 'domenhribernik.com', pathname: '/views/share/', search: '?p=views/tells',
    }), 'views/tells');
    assert.equal(targetPathFrom({
        hostname: 'domenhribernik.com', pathname: '/views/share/', search: '',
    }), '');
    assert.equal(targetPathFrom({
        hostname: 'localhost', pathname: '/portfolio/views/share/', search: '?p=views/nebo',
    }), 'views/nebo');
});

test('an explicit p query wins even on the share subdomain', () => {
    assert.equal(targetPathFrom({
        hostname: 'share.domenhribernik.com', pathname: '/views/tells/', search: '?p=views/nebo',
    }), 'views/nebo');
});

test('a host that merely contains "share" is not the share subdomain', () => {
    assert.equal(targetPathFrom({
        hostname: 'notshare.domenhribernik.com', pathname: '/views/tells/', search: '',
    }), '');
    assert.equal(targetPathFrom({
        hostname: 'domenhribernik.com.share.evil.test', pathname: '/views/tells/', search: '',
    }), '');
});

//? ------------------------------------------------------------ path hardening

test('normalizeSharePath trims the shapes a real address arrives in', () => {
    assert.equal(normalizeSharePath('views/tells'), 'views/tells');
    assert.equal(normalizeSharePath('/views/tells/'), 'views/tells');
    assert.equal(normalizeSharePath('views/tells/index.html'), 'views/tells');
    assert.equal(normalizeSharePath('//views//tells//'), 'views/tells');
    assert.equal(normalizeSharePath('views%2Ftells'), 'views/tells');
    assert.equal(normalizeSharePath(''), '');
    assert.equal(normalizeSharePath('/'), '');
});

test('normalizeSharePath accepts the pretty form when the catalog knows the page', () => {
    const known = Object.keys(catalog.pages);
    assert.equal(normalizeSharePath('rocks', known), 'views/rocks');
    assert.equal(normalizeSharePath('/rocks/', known), 'views/rocks');
    // Without a catalog there is nothing to match against, so it stays as given.
    assert.equal(normalizeSharePath('rocks'), 'rocks');
    // A page the catalog does not know is still shareable, just not expanded.
    assert.equal(normalizeSharePath('somewhere', known), 'somewhere');
});

test('normalizeSharePath refuses anything that could leave the site', () => {
    for (const bad of [
        '../../etc/passwd',
        'views/../../etc',
        '%2e%2e/%2e%2e/etc',
        '//evil.test',
        '///evil.test',
        'https://evil.test',
        'http://evil.test',
        'javascript:alert(1)',
        'JavaScript:alert(1)',
        'data:text/html,<script>',
        'views\\tells',
        'views/tells?x=1',
        'views/tells#frag',
        'views/<script>',
        'views/"quote',
        "views/'quote",
        'views/te lls',
        'x'.repeat(300),
    ]) {
        assert.equal(normalizeSharePath(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
});

test('normalizeSharePath survives a malformed percent escape', () => {
    assert.equal(normalizeSharePath('%'), null);
    assert.equal(normalizeSharePath('%zz'), null);
});

test('normalizeSharePath rejects whitespace and control characters', () => {
    assert.equal(normalizeSharePath('views/tells '), null);
    assert.equal(normalizeSharePath('views/tel\nls'), null);
    assert.equal(normalizeSharePath('views/tel\tls'), null);
    assert.equal(normalizeSharePath('%00'), null);
});

//? ----------------------------------------------------------------- addresses

test('targetUrl always lands on the site origin with a trailing slash', () => {
    assert.equal(targetUrl(ORIGIN, ''), 'https://domenhribernik.com/');
    assert.equal(targetUrl(ORIGIN, 'views/tells'), 'https://domenhribernik.com/views/tells/');
    assert.equal(targetUrl(ORIGIN + '/', 'views/tells'), 'https://domenhribernik.com/views/tells/');
    assert.equal(targetUrl(ORIGIN, 'views/blog/building-this-blog'),
        'https://domenhribernik.com/views/blog/building-this-blog/');
});

test('shareOriginFor puts the subdomain in front of the site origin', () => {
    assert.equal(shareOriginFor(ORIGIN), 'https://share.domenhribernik.com');
    assert.equal(shareOriginFor('http://example.test'), 'http://share.example.test');
    assert.equal(shareOriginFor('https://share.domenhribernik.com'), 'https://share.domenhribernik.com');
});

test('prettyTitleFromPath names a page the catalog has never heard of', () => {
    assert.equal(prettyTitleFromPath('views/on-this-day'), 'On This Day');
    assert.equal(prettyTitleFromPath('views/blog/building-this-blog'), 'Building This Blog');
    assert.equal(prettyTitleFromPath('rocks'), 'Rocks');
    assert.equal(prettyTitleFromPath('views/some_thing'), 'Some Thing');
    assert.equal(prettyTitleFromPath(''), 'Home');
});

//? --------------------------------------------------------------- card lookup

test('a known page resolves to its catalog card', () => {
    const card = resolveCard(catalog, 'views/tells');
    assert.equal(card.registered, true);
    assert.equal(card.title, 'Tells');
    assert.equal(card.description, 'Forty-eight of them on one grid.');
    assert.equal(card.icon, 'fas fa-crosshairs');
    assert.equal(card.url, 'https://domenhribernik.com/views/tells/');
    assert.equal(card.path, 'views/tells');
});

test('an unknown page still resolves to a card worth scanning', () => {
    const card = resolveCard(catalog, 'views/quizz');
    assert.equal(card.registered, false);
    assert.equal(card.title, 'Quizz');
    assert.equal(card.description, '');
    assert.equal(card.url, 'https://domenhribernik.com/views/quizz/');
    assert.match(card.icon, /^fas? fa-/);
    assert.match(card.gradient, /^linear-gradient\(/);
});

test('the homepage resolves to its own card, not to the unknown fallback', () => {
    const card = resolveCard(catalog, '');
    assert.equal(card.registered, true);
    assert.equal(card.title, 'Domen Hribernik');
    assert.equal(card.url, 'https://domenhribernik.com/');
});

test('indexEntries lists every catalog page with its target address', () => {
    const entries = indexEntries(catalog);
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map((e) => e.path), ['', 'views/tells', 'views/rocks']);
    assert.equal(entries[1].title, 'Tells');
    assert.equal(entries[1].url, 'https://domenhribernik.com/views/tells/');
});

//? ------------------------------------------------------------------- colour

test('parseGradientStops pulls both hex stops out of a registry gradient', () => {
    assert.deepEqual(parseGradientStops('linear-gradient(45deg, #1c1a17 0%, #d4451f 100%)'),
        ['#1c1a17', '#d4451f']);
    assert.deepEqual(parseGradientStops('linear-gradient(45deg, #F093FB 0%, #f5576c 100%)'),
        ['#f093fb', '#f5576c']);
});

test('parseGradientStops returns null for anything it cannot read', () => {
    for (const bad of ['', null, undefined, 'red', 'linear-gradient(45deg, red, blue)', '#abc']) {
        assert.equal(parseGradientStops(bad), null, `expected null for ${bad}`);
    }
});

test('mixHex walks from one colour to the other', () => {
    assert.equal(mixHex('#000000', '#ffffff', 0), '#000000');
    assert.equal(mixHex('#000000', '#ffffff', 1), '#ffffff');
    assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
    assert.equal(mixHex('#d4451f', '#d4451f', 0.5), '#d4451f');
});

test('relative luminance and contrast follow the WCAG definition', () => {
    assert.equal(relativeLuminance('#ffffff'), 1);
    assert.equal(relativeLuminance('#000000'), 0);
    assert.equal(Math.round(contrastRatio('#ffffff', '#000000')), 21);
    assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
    assert.equal(Math.round(contrastRatio('#123456', '#123456')), 1);
});

test('subtleGradient pulls both stops most of the way to paper', () => {
    const out = subtleGradient('linear-gradient(45deg, #1c1a17 0%, #d4451f 100%)');
    assert.match(out, /^linear-gradient\(90deg, #[0-9a-f]{6} 0%, #[0-9a-f]{6} 100%\)$/);

    // Both stops end up close to the paper ground, which is what keeps the
    // band a tint of the project's colour rather than a slab of it.
    const [a, b] = parseGradientStops(out.replace('90deg', '45deg'));
    for (const hex of [a, b]) {
        assert.ok(contrastRatio(hex, '#f6f2ea') < 1.9, `${hex} stays close to paper`);
    }
});

test('subtleGradient falls back to a house tint when the gradient is unreadable', () => {
    const out = subtleGradient('nonsense');
    assert.match(out, /^linear-gradient\(90deg, #[0-9a-f]{6} 0%, #[0-9a-f]{6} 100%\)$/);
});

test('readableAccent leaves a colour that already reads on paper alone', () => {
    assert.equal(readableAccent('linear-gradient(45deg, #1c1a17 0%, #d4451f 100%)'), '#d4451f');
    assert.equal(readableAccent('linear-gradient(45deg, #000000 0%, #1f35e0 100%)'), '#1f35e0');
});

test('readableAccent darkens a pale stop until it carries on paper', () => {
    // Several registry gradients end pale; used as-is they vanish as a hairline.
    for (const pale of ['#f093fb', '#a779e9', '#a49a8a', '#f2b705', '#ffffff']) {
        const accent = readableAccent(`linear-gradient(45deg, #111111 0%, ${pale} 100%)`);
        assert.ok(contrastRatio(accent, '#f6f2ea') >= ACCENT_MIN_CONTRAST,
            `${pale} became ${accent}, contrast ${contrastRatio(accent, '#f6f2ea').toFixed(2)}`);
    }
});

test('readableAccent falls back to clay when there is no gradient to read', () => {
    assert.equal(readableAccent(null), '#d4451f');
    assert.equal(readableAccent('nonsense'), '#d4451f');
});

//? ----------------------------------------------------------------- svg path

test('qrSvgPath draws one subpath per horizontal run of dark modules', () => {
    // . # # .
    // # . . #
    const size = 4;
    const modules = Uint8Array.from([
        0, 1, 1, 0,
        1, 0, 0, 1,
        0, 0, 0, 0,
        0, 0, 0, 0,
    ]);
    assert.equal(qrSvgPath(modules, size), 'M1 0h2v1h-2zM0 1h1v1h-1zM3 1h1v1h-1z');
});

test('qrSvgPath closes a run that reaches the right edge', () => {
    const modules = Uint8Array.from([1, 1, 0, 0]);
    assert.equal(qrSvgPath(modules, 2), 'M0 0h2v1h-2z');
});

test('qrSvgPath returns an empty string for a grid with nothing in it', () => {
    assert.equal(qrSvgPath(new Uint8Array(9), 3), '');
});

test('qrSvgPath covers exactly the dark modules of a real code', async () => {
    const { encodeQr } = await import('../views/share/qr.js');
    const qr = encodeQr('https://domenhribernik.com/views/tells/');
    const d = qrSvgPath(qr.modules, qr.size);

    // Every h-step in the path accounts for one module, so the widths must sum
    // to the number of dark modules.
    let covered = 0;
    for (const m of d.matchAll(/h(\d+)v1/g)) covered += Number(m[1]);
    const dark = qr.modules.reduce((a, b) => a + b, 0);
    assert.equal(covered, dark);
});
