// Integrity of the Spy game's translation tables (views/spy/i18n).
//
// The whole design is "one row per concept, one column per language", read by
// the browser and by spy-controller.php from the same files. That shape only
// stays honest if every declared language is actually filled in, so this is
// the test that keeps a half-added language from reaching a table.
//
// Run: node --test tests/     (Windows: node --test "tests/**/*.test.mjs")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) =>
    JSON.parse(readFileSync(new URL(`../views/spy/i18n/${name}.json`, import.meta.url), 'utf8'));

const ui = read('ui');
const locations = read('locations');

test('both tables declare the same languages', () => {
    // The room language is validated against ui.json alone, so a language
    // present there but missing from locations.json would deal blank cards.
    assert.deepEqual(locations.languages, ui.languages);
    assert.ok(ui.languages.includes('en'), 'English is the fallback and must exist');
});

test('every interface string is filled in for every language', () => {
    const gaps = [];
    for (const [key, row] of Object.entries(ui.strings)) {
        for (const lang of ui.languages) {
            if (typeof row[lang] !== 'string' || row[lang].trim() === '') gaps.push(`${key}:${lang}`);
        }
    }
    assert.deepEqual(gaps, [], `untranslated interface strings: ${gaps.join(', ')}`);
});

test('every location is filled in for every language, and keyed uniquely', () => {
    const gaps = [];
    const keys = new Set();
    for (const row of locations.locations) {
        assert.ok(typeof row.key === 'string' && row.key !== '', 'every location needs a key');
        assert.ok(!keys.has(row.key), `duplicate location key: ${row.key}`);
        keys.add(row.key);
        for (const lang of locations.languages) {
            if (typeof row[lang] !== 'string' || row[lang].trim() === '') gaps.push(`${row.key}:${lang}`);
        }
    }
    assert.deepEqual(gaps, [], `untranslated locations: ${gaps.join(', ')}`);
});

test('every plural set is complete, so no count can fall through to a key', () => {
    // Slovene needs four forms where English needs two, and the page asks for
    // one of them by name (`word.spy.two`). A set missing a form is a count
    // that renders wrong grammar, or in a fresh table nothing at all.
    const CATEGORIES = ['one', 'two', 'few', 'other'];
    const bases = new Set();
    for (const key of Object.keys(ui.strings)) {
        const cut = key.lastIndexOf('.');
        if (cut > 0 && CATEGORIES.includes(key.slice(cut + 1))) bases.add(key.slice(0, cut));
    }
    assert.ok(bases.size > 0, 'the plural sets have gone missing entirely');

    const gaps = [];
    for (const base of bases) {
        for (const cat of CATEGORIES) {
            if (!ui.strings[`${base}.${cat}`]) gaps.push(`${base}.${cat}`);
        }
    }
    assert.deepEqual(gaps, [], `incomplete plural sets: ${gaps.join(', ')}`);
});

test('every key the markup asks for exists in the table', () => {
    // data-i18n is the page's own list of what needs translating, so a typo in
    // one is a control that renders its key at a player. The markup ships
    // English, which is exactly why nobody would notice.
    const html = readFileSync(new URL('../views/spy/index.html', import.meta.url), 'utf8');
    const asked = new Set(
        [...html.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)].map((m) => m[1])
    );
    const missing = [...asked].filter((key) => !ui.strings[key]);
    assert.deepEqual(missing, [], `markup asks for strings the table lacks: ${missing.join(', ')}`);
});

test('every key the script asks for exists in the table', () => {
    // The half the markup check cannot see, and the worse half: a string the
    // page assembles has no English in the DOM to fall back on, so a typo in a
    // t() key ships as that key printed at a player. Plural bases are checked
    // through their `one` form, which the completeness test then extends to
    // all four.
    const js = readFileSync(new URL('../views/spy/script.js', import.meta.url), 'utf8');
    const missing = [];

    for (const [, key] of js.matchAll(/\bt\(\s*'([\w.]+)'/g)) {
        if (!ui.strings[key]) missing.push(`t('${key}')`);
    }
    for (const [, key] of js.matchAll(/\bhasString\(\s*uiTable\s*,\s*'([\w.]+)'/g)) {
        if (!ui.strings[key]) missing.push(`hasString('${key}')`);
    }
    for (const [, base] of js.matchAll(/\bplural\(\s*'([\w.]+)'/g)) {
        if (!ui.strings[`${base}.one`]) missing.push(`plural('${base}')`);
    }

    assert.ok(js.includes("t('"), 'the extraction stopped matching, so this test proves nothing');
    assert.deepEqual(missing, [], `script asks for strings the table lacks: ${missing.join(', ')}`);
});

test('every row in the table is one the page can actually reach', () => {
    // The other direction, and the one that rots quietly: a row nothing asks
    // for is a row that goes stale, gets translated again on the next pass, and
    // costs a reviewer time for nothing. Plural sets count as reached when the
    // base is, since the page names the base and the helper appends the form.
    const src = ['../views/spy/script.js', '../views/spy/index.html']
        .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8'))
        .join('\n');
    const named = (key) => src.includes(`'${key}'`) || src.includes(`"${key}"`);

    const unused = Object.keys(ui.strings).filter((key) => {
        if (named(key)) return false;
        const base = key.replace(/\.(one|two|few|other)$/, '');
        return base === key || !named(base);
    });
    assert.deepEqual(unused, [], `rows nothing on the page asks for: ${unused.join(', ')}`);
});

test('the location deck is big enough to keep repeating rounds interesting', () => {
    assert.ok(locations.locations.length >= 40, `only ${locations.locations.length} locations`);
});

test('placeholders match across languages, so no substitution goes missing', () => {
    // "{n} / {total} BRIEFED" translated without its braces would render a
    // count that never fills in, which reads as a broken screen.
    const marks = (text) => (text.match(/\{\w+\}/g) ?? []).sort().join(',');
    const mismatched = [];
    for (const [key, row] of Object.entries(ui.strings)) {
        const want = marks(row.en);
        for (const lang of ui.languages) {
            if (marks(row[lang]) !== want) mismatched.push(`${key}:${lang}`);
        }
    }
    assert.deepEqual(mismatched, [], `placeholder mismatch: ${mismatched.join(', ')}`);
});
