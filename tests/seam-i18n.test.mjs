// Integrity of SEAM's translation table (views/seam/i18n/ui.json).
//
// The whole design is "one row per string, one column per language", read by
// the browser and by seam-controller.php from the same file. That shape only
// stays honest if every declared language is actually filled in, so this is
// the test that keeps a half-added language from reaching a plate.
//
// Run: node --test tests/     (Windows: node --test "tests/**/*.test.mjs")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ui = JSON.parse(readFileSync(new URL('../views/seam/i18n/ui.json', import.meta.url), 'utf8'));

test('the table declares its languages, with English among them', () => {
    assert.ok(Array.isArray(ui.languages) && ui.languages.length > 0);
    assert.ok(ui.languages.includes('en'), 'English is the fallback and must exist');
    assert.equal(ui.languages[0], 'en', 'English leads, so a new table never renders blank');
});

test('every interface string is filled in for every language', () => {
    const gaps = [];
    for (const [key, row] of Object.entries(ui.strings)) {
        for (const lang of ui.languages) {
            if (typeof row[lang] !== 'string' || row[lang].trim() === '') gaps.push(`${key}:${lang}`);
        }
    }
    assert.deepEqual(gaps, [], `untranslated strings: ${gaps.join(', ')}`);
});

test('placeholders match across languages, so no substitution goes missing', () => {
    // "{n} PERMITS LEFT" translated without its braces would render a count
    // that never fills in, which reads as a broken plate.
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

test('every reason code the controller can refuse a cut with has a string', () => {
    // seam-controller.php answers 400 with a bare reason code and the plate
    // has to say something human. A missing row here is a blank toast.
    for (const reason of ['badShaft', 'noPermit', 'cooling', 'notYourTurn', 'over']) {
        assert.ok(ui.strings[`refuse.${reason}`], `no refuse.${reason} row`);
    }
});
