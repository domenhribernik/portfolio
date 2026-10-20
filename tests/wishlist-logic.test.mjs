// Unit tests for views/wishlist/logic.js, the DOM-free half of the wish list.
//
// Each test is a decision a guest or an editor sees the consequence of: whether
// an item still needs someone, whether "Undo" is offered, what order the list
// reads in, and what an editor is allowed to save. script.js only renders what
// these functions say.
//
// Run: node --test "tests/**/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    itemState,
    groupForDisplay,
    neededCount,
    validateDraft,
    domainLabel,
    shortTitle,
    pruneTokens,
    NAME_MAX,
    NOTE_MAX,
    QTY_MAX,
    URL_MAX,
} from '../views/wishlist/logic.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const item = (over = {}) => ({ id: 1, name: 'Toaster', quantity: 1, claims: [], ...over });

// ------------------------------------------------------------------
//  What an item still needs
// ------------------------------------------------------------------

test('an item with no claims is still needed', () => {
    const s = itemState(item());
    assert.equal(s.open, true);
    assert.equal(s.taken, 0);
    assert.equal(s.remaining, 1);
});

test('one claim on a single item takes it', () => {
    const s = itemState(item({ claims: [7] }));
    assert.equal(s.open, false);
    assert.equal(s.remaining, 0);
});

test('an item wanted twice stays open after one claim', () => {
    const s = itemState(item({ quantity: 2, claims: [7] }));
    assert.equal(s.open, true);
    assert.equal(s.taken, 1);
    assert.equal(s.remaining, 1);
});

// ------------------------------------------------------------------
//  Whose claim it is
// ------------------------------------------------------------------
//
// A claim is anonymous: the server hands the claiming browser a token, and the
// browser keeps { claimId: token }. Holding the token is what "mine" means,
// and it is the only thing that can undo the claim without an editor.

test('a claim this browser holds the token for is mine and can be undone', () => {
    const s = itemState(item({ claims: [7] }), { 7: 'tok' });
    assert.equal(s.mine, 7);
});

test('someone else\'s claim is not mine', () => {
    const s = itemState(item({ claims: [7] }), { 9: 'tok-for-another-item' });
    assert.equal(s.mine, null);
});

test('my claim on an item wanted twice leaves it open for one more person', () => {
    const s = itemState(item({ quantity: 2, claims: [7] }), { 7: 'tok' });
    assert.equal(s.mine, 7);
    assert.equal(s.open, true);
});

// ------------------------------------------------------------------
//  Reading order
// ------------------------------------------------------------------

test('items still needed come first, in list order, and taken ones sink below', () => {
    const items = [
        item({ id: 1, claims: [11] }),
        item({ id: 2 }),
        item({ id: 3, quantity: 2, claims: [12] }),
        item({ id: 4, claims: [13] }),
        item({ id: 5 }),
    ];
    const { needed, taken } = groupForDisplay(items);
    assert.deepEqual(needed.map((i) => i.id), [2, 3, 5]);
    assert.deepEqual(taken.map((i) => i.id), [1, 4]);
});

// ------------------------------------------------------------------
//  What an editor may save
// ------------------------------------------------------------------

test('a draft needs a name, and the name is trimmed', () => {
    assert.equal(validateDraft({ name: '   ' }).ok, false);
    assert.ok(validateDraft({ name: '' }).errors.name);
    const v = validateDraft({ name: '  Toaster  ' });
    assert.equal(v.ok, true);
    assert.equal(v.value.name, 'Toaster');
});

test('a link must be http or https, because it becomes a tappable href', () => {
    assert.ok(validateDraft({ name: 'x', url: 'javascript:alert(1)' }).errors.url);
    assert.ok(validateDraft({ name: 'x', url: 'data:text/html,hi' }).errors.url);
    assert.ok(validateDraft({ name: 'x', url: 'not a link' }).errors.url);
    assert.equal(validateDraft({ name: 'x', url: 'https://www.amazon.de/dp/B07TYMDHCS' }).ok, true);
});

test('a link pasted without a scheme is read as https', () => {
    assert.equal(validateDraft({ name: 'x', url: 'tkmaxx.de/glass' }).value.url, 'https://tkmaxx.de/glass');
});

test('no link at all is fine: some wishes are just a description', () => {
    const v = validateDraft({ name: 'A toolbox', url: '  ' });
    assert.equal(v.ok, true);
    assert.equal(v.value.url, null);
});

test('length caps hold for the name and the note', () => {
    assert.ok(validateDraft({ name: 'n'.repeat(NAME_MAX + 1) }).errors.name);
    assert.ok(validateDraft({ name: 'x', note: 'n'.repeat(NOTE_MAX + 1) }).errors.note);
    assert.equal(validateDraft({ name: 'x', note: 'n'.repeat(NOTE_MAX) }).ok, true);
});

test('an empty note is stored as no note', () => {
    assert.equal(validateDraft({ name: 'x', note: '  \n ' }).value.note, null);
});

test('quantity is a whole number from 1 to the cap, defaulting to 1', () => {
    assert.equal(validateDraft({ name: 'x' }).value.quantity, 1);
    assert.equal(validateDraft({ name: 'x', quantity: '2' }).value.quantity, 2);
    assert.ok(validateDraft({ name: 'x', quantity: 0 }).errors.quantity);
    assert.ok(validateDraft({ name: 'x', quantity: 1.5 }).errors.quantity);
    assert.ok(validateDraft({ name: 'x', quantity: QTY_MAX + 1 }).errors.quantity);
});

// ------------------------------------------------------------------
//  Links and auto-filled names
// ------------------------------------------------------------------

test('a link is labelled by its shop, not its whole address', () => {
    assert.equal(domainLabel('https://www.amazon.de/dp/B07TYMDHCS?ref=x'), 'amazon.de');
    assert.equal(domainLabel('https://m.tkmaxx.com/de/glass'), 'tkmaxx.com');
    assert.equal(domainLabel('https://shop.example.co.uk/a'), 'shop.example.co.uk');
    assert.equal(domainLabel('nonsense'), '');
    assert.equal(domainLabel(null), '');
});

// Real titles off the registry. A shop title is a keyword list; the name a
// guest needs is the part before the first separator.
test('an auto-filled shop title is cut to its first phrase', () => {
    assert.equal(
        shortTitle('4smile Nudelsieb - Nudelsieb Edelstahl als Abgiesshilfe für Töpfe bis Ø 26 cm - Flaches Abtropfsieb'),
        '4smile Nudelsieb',
    );
    assert.equal(
        shortTitle('SONGMICS Mülleimer Küche, Mülltrennsystem 2 Fächer, 2 x 15 Liter | Treteimer'),
        'SONGMICS Mülleimer Küche',
    );
    assert.equal(
        shortTitle('Vileda 2in1 Bodenwischer Komplett Set | Schwarz/Rot | Vinyl Holz Keramik'),
        'Vileda 2in1 Bodenwischer Komplett Set',
    );
    assert.equal(shortTitle('Messbecher 29160'), 'Messbecher 29160');
});

test('a hyphenated word is not mistaken for a separator', () => {
    assert.equal(
        shortTitle('ROMMELSBACHER Kontakt- und Flächengrill KG 2025, getrennt regelbar'),
        'ROMMELSBACHER Kontakt- und Flächengrill KG 2025',
    );
});

test('the shop name around a page title is dropped', () => {
    assert.equal(shortTitle('Amazon.de: WMF Kartoffelstampfer : Küche, Haushalt & Wohnen'), 'WMF Kartoffelstampfer');
    assert.equal(shortTitle('Glass jar with lid - IKEA'), 'Glass jar with lid');
});

test('an overlong single phrase is cut at a word under the name cap', () => {
    const long = ('word ').repeat(60).trim();
    const s = shortTitle(long);
    assert.ok(s.length <= NAME_MAX);
    assert.ok(!s.endsWith(' '));
    assert.ok(long.startsWith(s));
});

// ------------------------------------------------------------------
//  Remembered claims
// ------------------------------------------------------------------

test('a remembered claim an editor has since reset is forgotten', () => {
    const items = [item({ id: 1, claims: [7] }), item({ id: 2, claims: [] })];
    const kept = pruneTokens({ 7: 'a', 8: 'b' }, items);
    assert.deepEqual(kept, { 7: 'a' });
});

test('pruning keeps every claim that still exists and does not mutate the input', () => {
    const tokens = { 7: 'a', 9: 'c' };
    const items = [item({ id: 1, quantity: 2, claims: [7, 9] })];
    assert.deepEqual(pruneTokens(tokens, items), { 7: 'a', 9: 'c' });
    assert.deepEqual(tokens, { 7: 'a', 9: 'c' });
});

test('an item you just claimed stays where it was, so it does not jump out from under your thumb', () => {
    const items = [item({ id: 1 }), item({ id: 2, claims: [7] }), item({ id: 3 })];
    const { needed, taken } = groupForDisplay(items, { 7: 'tok' }, new Set([2]));
    assert.deepEqual(needed.map((i) => i.id), [1, 2, 3]);
    assert.deepEqual(taken, []);
});

test('among taken items, the ones you are bringing come first', () => {
    const items = [
        item({ id: 1, claims: [11] }),
        item({ id: 2, claims: [12] }),
        item({ id: 3, claims: [13] }),
    ];
    const { taken } = groupForDisplay(items, { 13: 'tok' });
    assert.deepEqual(taken.map((i) => i.id), [3, 1, 2]);
});

test('the header counts items still needed, not units', () => {
    const items = [
        item({ id: 1, claims: [11] }),
        item({ id: 2, quantity: 2 }),
        item({ id: 3 }),
    ];
    assert.deepEqual(neededCount(items), { needed: 2, total: 3 });
});

// ------------------------------------------------------------------
//  The rules that exist in both languages
// ------------------------------------------------------------------

test('the field caps match the controller that enforces them', () => {
    // The editor's form checks these before saving; wishlist-controller.php is
    // what actually refuses. If the two drift, a note the form accepts comes
    // back as a 422 the editor cannot explain.
    const php = readFileSync(join(ROOT, 'app/controllers/wishlist-controller.php'), 'utf8');
    const phpConst = (name) => Number(php.match(new RegExp(String.raw`const ${name}\s*=\s*(\d+);`))?.[1]);
    assert.equal(phpConst('NAME_MAX'), NAME_MAX);
    assert.equal(phpConst('NOTE_MAX'), NOTE_MAX);
    assert.equal(phpConst('URL_MAX'), URL_MAX);
    assert.equal(phpConst('QTY_MAX'), QTY_MAX);
});
