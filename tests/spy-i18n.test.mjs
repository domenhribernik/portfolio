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
