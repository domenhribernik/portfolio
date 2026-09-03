// The Battleship strings table (views/battleship/i18n/ui.json), which the
// page reads and which every refusal the controller can send has to answer.
// Run: node --test tests/     (Windows: node --test "tests/**/*.test.mjs")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const url = (p) => new URL(p, import.meta.url);
const ui = JSON.parse(readFileSync(url('../views/battleship/i18n/ui.json'), 'utf8'));
const LANGS = ['en', 'sl'];

test('no string is half filled in', () => {
    // A missing column falls back to English at runtime, so a half translated
    // table is invisible in one language and silently wrong in the other.
    for (const [key, row] of Object.entries(ui)) {
        for (const lang of LANGS) {
            assert.equal(typeof row[lang], 'string', `${key} has no ${lang}`);
            assert.ok(row[lang].trim().length > 0, `${key} is empty in ${lang}`);
        }
        assert.deepEqual(Object.keys(row).sort(), [...LANGS].sort(), `${key} has a stray column`);
    }
});

test('a placeholder present in one language is present in all of them', () => {
    // {who} vanishing from the Slovenian leaves a sentence with a hole in it.
    const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, row] of Object.entries(ui)) {
        const wanted = holes(row.en);
        for (const lang of LANGS) {
            assert.deepEqual(holes(row[lang]), wanted, `${key} placeholders differ in ${lang}`);
        }
    }
});

test('every refusal the controller can send has a row', () => {
    // The client shows a refusal by its code. A code only the server speaks
    // renders as the raw key, which tells the player nothing they can act on.
    const php = readFileSync(url('../app/controllers/battleship-controller.php'), 'utf8');
    const codes = new Set([...php.matchAll(/'reason'\s*=>\s*'(\w+)'/g)].map((m) => m[1]));
    // actionError's codes reach sendError through a variable, so read them
    // out of the rules module instead. Scoped to the two judging functions:
    // strike() also returns bare strings, and those are results, not refusals.
    const logic = readFileSync(url('../views/battleship/logic.js'), 'utf8');
    for (const name of ['actionError', 'abilityError']) {
        const body = logic.match(new RegExp(`export function ${name}\\([\\s\\S]*?\\n\\}`));
        assert.ok(body, `logic.js no longer exports ${name}`);
        for (const m of body[0].matchAll(/return '(\w+)';/g)) codes.add(m[1]);
    }

    for (const code of codes) {
        assert.ok(ui[`refuse.${code}`], `the server can refuse with '${code}' and nothing translates it`);
    }
});

test('every ship, tool and hint the rules know about is named', () => {
    const logic = readFileSync(url('../views/battleship/logic.js'), 'utf8');
    const ships = [...logic.matchAll(/\{ key: '(\w+)', len: \d+ \}/g)].map((m) => m[1]);
    assert.equal(ships.length, 5);
    for (const key of ships) assert.ok(ui[`ship.${key}`], `ship.${key} is not named`);

    const costs = logic.match(/export const COST = \{([^}]+)\}/)[1];
    const tools = [...costs.matchAll(/(\w+):/g)].map((m) => m[1]);
    for (const kind of [...tools, 'fire']) {
        assert.ok(ui[`tool.${kind}`], `tool.${kind} has no label`);
        assert.ok(ui[`hint.${kind}`], `tool.${kind} has no hint`);
        if (kind !== 'fire') assert.ok(ui[`rules.${kind}`], `tool.${kind} is missing from How it works`);
    }
});

test('nothing in the table uses an em dash', () => {
    // A house rule for the whole repo, and easy to reintroduce by hand.
    for (const [key, row] of Object.entries(ui)) {
        for (const lang of LANGS) {
            assert.ok(!row[lang].includes('—'), `${key} (${lang}) carries an em dash`);
        }
    }
});
