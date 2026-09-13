// Structural guards for views/share. Run with: node --test tests/
//
// This suite holds the two rules that make the share page work at all, both of
// which are invisible at the language level and both of which have already been
// broken once by a change that looked like tidying.
//
//   1. Every id script.js reaches for must exist in index.html. The page ends
//      on <site-footer> now; it used to end on a hand-written <footer> carrying
//      id="foot-addr", and script.js still wrote to it. document.getElementById
//      returned null, the assignment threw, and everything after it in boot()
//      stopped running, which is how the whole project index quietly vanished
//      while the card above it kept rendering perfectly.
//
//   2. Nothing in this directory may climb out of it with ../../. The share
//      subdomain's document root IS this directory, so a relative path that
//      leaves it resolves to nothing there while working fine at
//      /views/share/ on the main domain. It works locally and 404s only in
//      production, which is the worst failure mode available.
//
// Neither needs a DOM. Both read the shipped source, which is the point: a
// browser test would only catch these on the page it happened to load.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARE = join(ROOT, 'views/share');

const read = (name) => readFileSync(join(SHARE, name), 'utf8');

const html = read('index.html');
const script = read('script.js');

//? --------------------------------------------------------------- dom contract

// Every id the page declares, so a lookup can be checked against the real file
// rather than against a list someone has to remember to update.
function idsIn(source) {
    return new Set([...source.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
}

// Both spellings script.js uses: the el() helper, and getElementById directly.
function idsLookedUpBy(source) {
    return [
        ...source.matchAll(/\bel\(\s*'([^']+)'\s*\)/g),
        ...source.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g),
    ].map((m) => m[1]);
}

test('every id script.js looks up exists in index.html', () => {
    const declared = idsIn(html);
    const missing = [...new Set(idsLookedUpBy(script))]
        .filter((id) => !declared.has(id))
        .sort();

    assert.deepEqual(missing, [],
        'script.js reads ids that index.html does not declare. getElementById ' +
        'returns null, the first write to one throws, and every line of boot() ' +
        'after it silently stops running.');
});

test('script.js looks up at least the ids the plate and the rack are made of', () => {
    // Guards the guard: a regex that quietly stopped matching would make the
    // test above pass by finding nothing to check.
    const found = idsLookedUpBy(script);
    assert.ok(found.length >= 10, `only ${found.length} id lookups found in script.js`);
    for (const id of ['plate', 'plate-title', 'qr-path', 'rack-grid']) {
        assert.ok(found.includes(id), `expected script.js to look up "${id}"`);
    }
});

//? ------------------------------------------------------------ self-contained

const OWN_FILES = readdirSync(SHARE)
    .filter((name) => ['.html', '.css', '.js', '.json'].includes(extname(name)));

// Only real references count. The prose in these files says "no ../../ imports"
// on purpose, and a test that cannot tell a comment from an import would have
// to be silenced rather than fixed.
const REFERENCE_PATTERNS = [
    /\b(?:src|href)\s*=\s*"([^"]+)"/g,        // html attributes
    /\bfrom\s*'([^']+)'/g,                     // static imports
    /\bimport\s*\(\s*'([^']+)'\s*\)/g,        // dynamic imports
    /\bfetch\s*\(\s*'([^']+)'/g,              // runtime loads
    /\burl\(\s*['"]?([^'")]+)/g,              // css url()
];

function referencesIn(source) {
    return REFERENCE_PATTERNS.flatMap((re) => [...source.matchAll(re)].map((m) => m[1]));
}

test('no file in views/share references anything outside its own directory', () => {
    const offenders = OWN_FILES.flatMap((name) =>
        referencesIn(read(name))
            .filter((ref) => ref.startsWith('../') || ref.startsWith('/'))
            .map((ref) => `${name}: ${ref}`));

    assert.deepEqual(offenders, [],
        'views/share is served from its own document root on share.<site>, so a ' +
        '../ or root-relative path resolves to nothing there. Link the site copy ' +
        'absolutely (https://domenhribernik.com/...) the way the favicon does.');
});

test('the reference scanner actually finds the references it is scanning for', () => {
    // Guards the guard. If a pattern stopped matching, the test above would
    // pass by inspecting an empty list.
    const refs = referencesIn(html);
    assert.ok(refs.includes('style.css'), 'expected the page to reference style.css');
    assert.ok(refs.includes('script.js'), 'expected the page to reference script.js');
    assert.ok(referencesIn(read('script.js')).includes('./logic.js'),
        'expected script.js to import ./logic.js');
});

test('the shared things the page does load are absolute, not relative', () => {
    // The page still ends on <site-footer> (tests/legal.test.mjs requires a
    // route to the privacy policy from every crawlable page) and still loads
    // consent before analytics. Both have to come from the main domain by
    // absolute URL, because neither exists under this document root.
    assert.match(html, /<site-footer/, 'the page must still end on <site-footer>');

    const shared = [...html.matchAll(/(?:src|href)="([^"]*(?:components|assets)\/[^"]*)"/g)]
        .map((m) => m[1]);
    assert.ok(shared.length > 0, 'no shared component or asset links found to check');

    const relative = shared.filter((url) => !/^https:\/\//.test(url));
    assert.deepEqual(relative, [],
        'these point at components/ or assets/ with a relative path, which only ' +
        'resolves on the main domain.');
});

test('consent is loaded before analytics, so analytics cannot fire unconsented', () => {
    // Matched on the tags, not on the text: the comment above them names both
    // files, and a substring search reads that as the wrong order.
    const loaded = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    const consent = loaded.findIndex((url) => url.endsWith('consent/consent.js'));
    const analytics = loaded.findIndex((url) => url.endsWith('google-analytics.js'));

    assert.notEqual(consent, -1, 'the page must load components/consent/consent.js');
    assert.notEqual(analytics, -1, 'the page must load components/google-analytics.js');
    assert.ok(consent < analytics,
        'consent.js must be loaded before google-analytics.js; analytics registers ' +
        'against consent and does nothing if it is not there yet.');
});
