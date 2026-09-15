/* The compliance work is mostly invisible: a font served from the right
   place, a script that does not run until asked, a link in a footer. All
   three are one careless copy-paste from being undone, and none of them
   fails loudly when they are. So they are welded down here instead.

   What this suite protects:

     1. No page hot-links Google Fonts. Sending every visitor's IP to
        Google before they have agreed to anything is the arrangement
        LG Munchen I ruled against in 2022; the fonts live in
        assets/fonts/ now and must stay there.
     2. Nothing loads a tracker except through its consent-aware loader,
        and no page loads a gated loader without consent.js in front of
        it. Both loaders fail closed, so a page that forgets the consent
        tag silently stops tracking rather than silently tracking without
        consent, and this test is what catches it.
     3. Every crawlable page can reach the privacy policy.
     4. The two legal pages exist and are findable. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set(['node_modules', '.git', 'assets', 'tools']);

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

const allFiles = walk(ROOT);
const htmlFiles = allFiles.filter((f) => f.endsWith('.html'));
const styleFiles = allFiles.filter((f) => f.endsWith('.css'));
const rel = (f) => relative(ROOT, f);
const read = (f) => readFileSync(f, 'utf8');

/* app/admin/ holds internal tools that are never served to a visitor. */
const isPublicish = (f) => !rel(f).startsWith('app/admin/');

// ---------------------------------------------------------------- fonts

test('no page hot-links Google Fonts', () => {
    const offenders = [...htmlFiles, ...styleFiles]
        .filter((f) => /fonts\.googleapis\.com|fonts\.gstatic\.com/.test(read(f)))
        .map(rel);

    assert.deepEqual(
        offenders,
        [],
        'These files reach out to Google for fonts. Add the face to SOURCES in ' +
            'tools/fonts/fetch.mjs, re-run it, and link assets/fonts/fonts.css instead.',
    );
});

test('the self-hosted font stylesheet and its files exist', () => {
    const cssPath = join(ROOT, 'assets/fonts/fonts.css');
    assert.ok(existsSync(cssPath), 'assets/fonts/fonts.css is missing; run node tools/fonts/fetch.mjs');

    const css = readFileSync(cssPath, 'utf8');
    const faces = [...css.matchAll(/url\(files\/([^)]+)\)/g)].map((m) => m[1]);
    assert.ok(faces.length > 0, 'fonts.css declares no @font-face rules');

    const missing = [...new Set(faces)].filter(
        (name) => !existsSync(join(ROOT, 'assets/fonts/files', name)),
    );
    assert.deepEqual(missing, [], 'fonts.css points at font files that are not in the repo');
});

// -------------------------------------------------------------- consent

test('trackers are only ever loaded through their consent-aware loader', () => {
    const offenders = htmlFiles
        .filter(isPublicish)
        .filter((f) => /googletagmanager\.com|embed\.tawk\.to/.test(read(f)))
        .map(rel);

    assert.deepEqual(
        offenders,
        [],
        'These pages embed a tracker directly, which bypasses the consent gate. ' +
            'Load components/google-analytics.js or components/tawk-chat.js instead.',
    );
});

test('every page with a gated loader loads consent.js first', () => {
    const problems = [];

    for (const file of htmlFiles.filter(isPublicish)) {
        const src = read(file);
        const gated = /<script[^>]+components\/(?:google-analytics|tawk-chat)\.js/.exec(src);
        if (!gated) continue;

        const consent = /<script[^>]+components\/consent\/consent\.js/.exec(src);
        if (!consent) {
            problems.push(`${rel(file)}: loads a gated tracker but never loads consent.js`);
            continue;
        }
        /* consent.js defines the API the loaders register against, and both
           are classic scripts, so document order is execution order. */
        if (consent.index > gated.index) {
            problems.push(`${rel(file)}: consent.js must come before the tracker it gates`);
        }
    }

    assert.deepEqual(problems, []);
});

test('the consent API and the loaders that depend on it agree', () => {
    const consent = read(join(ROOT, 'components/consent/consent.js'));
    for (const method of ['require:', 'whenGranted:', 'granted:', 'open:', 'decided:']) {
        assert.ok(consent.includes(method), `consent.js must expose ${method.slice(0, -1)}()`);
    }

    for (const name of ['google-analytics', 'tawk-chat']) {
        const src = read(join(ROOT, `components/${name}.js`));
        assert.match(
            src,
            /if \(!consent\) return;/,
            `${name}.js must fail closed when consent.js is absent`,
        );
        assert.match(src, /consent\.require\(/, `${name}.js must declare its purpose`);
        assert.match(src, /consent\.whenGranted\(/, `${name}.js must wait for consent`);
    }
});

// ----------------------------------------------------------- reachability

test('the legal pages exist, are indexable, and carry a canonical', () => {
    for (const page of ['privacy', 'terms']) {
        const file = join(ROOT, `views/${page}/index.html`);
        assert.ok(existsSync(file), `views/${page}/index.html is missing`);

        const src = readFileSync(file, 'utf8');
        assert.match(src, /<title>[^<]+<\/title>/, `views/${page} needs a title`);
        assert.match(
            src,
            new RegExp(`<link rel="canonical" href="https://domenhribernik\\.com/${page}/">`),
            `views/${page} needs an absolute trailing-slash canonical`,
        );
        assert.doesNotMatch(
            src,
            /name="robots"[^>]*noindex/,
            `views/${page} must stay indexable: a policy nobody can find is not a policy`,
        );
    }
});

test('every crawlable page can reach the privacy policy', () => {
    const sitemap = readFileSync(join(ROOT, 'sitemap.xml'), 'utf8');
    const paths = [...sitemap.matchAll(/<loc>https:\/\/domenhribernik\.com\/([^<]*)<\/loc>/g)]
        .map((m) => m[1].replace(/\/$/, ''));

    const unreachable = [];
    for (const path of paths) {
        const file = join(ROOT, path, 'index.html');
        if (!existsSync(file)) continue;
        const src = readFileSync(file, 'utf8');

        /* <site-footer> renders the link on most pages. Two pages link it by
           hand instead: the homepage, whose footer rides inside the book's
           contact leaf rather than at the end of the document, and trails,
           a full-screen cockpit with nowhere to put a footer. The depth of
           the href varies with the page, so only its tail is matched. */
        const reachable =
            src.includes('<site-footer') || /href="[^"]*\bprivacy\/"/.test(src);
        if (!reachable) unreachable.push(path || '/');
    }

    assert.deepEqual(
        unreachable,
        [],
        'These crawlable pages have no route to the privacy policy. End them on ' +
            '<site-footer>, which carries the legal links.',
    );
});

test('the footer carries the legal links', () => {
    const src = read(join(ROOT, 'components/site-footer.js'));
    assert.match(src, /views\/privacy\//, 'site-footer must link the privacy policy');
    assert.match(src, /views\/terms\//, 'site-footer must link the terms');
    assert.match(src, /portfolioConsent/, 'site-footer must offer a way back to the cookie settings');
});
