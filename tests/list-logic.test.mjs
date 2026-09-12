// Unit tests for views/list/logic.js, the DOM-free half of the shared list.
//
// Everything here is a decision the user can see the consequence of: which
// items a filter leaves on screen in the middle of a shop, what order the list
// walks in, what a typed "#mle" resolves to, and how a purchase is dated. The
// DOM code around it is not tested; it only renders what these functions say.
//
// Run: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    nameKey,
    fold,
    matchLabels,
    parseAddInput,
    resolveNewItemLabels,
    applyFilter,
    sortItems,
    usedLabels,
    initials,
    isMine,
    formatDaySl,
    formatTimeSl,
    groupByDay,
    filterStorageKey,
    pruneFilter,
    DEFAULT_LABELS,
} from '../views/list/logic.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// A collection's vocabulary, shaped exactly as the controller sends it.
const LABELS = [
    { id: 1, kind: 'section', name: 'sadje', sort_order: 0 },
    { id: 2, kind: 'section', name: 'zelenjava', sort_order: 1 },
    { id: 3, kind: 'section', name: 'pekarna', sort_order: 2 },
    { id: 4, kind: 'section', name: 'mlečni izdelki', sort_order: 3 },
    { id: 5, kind: 'section', name: 'meso in ribe', sort_order: 4 },
    { id: 10, kind: 'shop', name: 'Hofer', sort_order: 0 },
    { id: 11, kind: 'shop', name: 'Lidl', sort_order: 1 },
    { id: 12, kind: 'shop', name: 'Špar', sort_order: 2 },
];

const section = (id) => {
    const l = LABELS.find((x) => x.id === id);
    return { id: l.id, name: l.name, sort_order: l.sort_order };
};
const shop = section;

/** An item as the controller sends it. */
function item(name, { id = Math.floor(Math.random() * 1e6), sectionId = null, shopIds = [], checked = 0, addedBy = 1, createdAt = '2026-09-11 10:00:00.000' } = {}) {
    return {
        id,
        name,
        checked,
        section: sectionId === null ? null : section(sectionId),
        shops: shopIds.map(shop),
        added_by: 'Domen',
        added_by_user_id: addedBy,
        created_at: createdAt,
    };
}

// ------------------------------------------------------------------
//  nameKey: the identity of a written name
// ------------------------------------------------------------------

test('nameKey folds case and spacing but never diacritics', () => {
    assert.equal(nameKey('  Mleko '), 'mleko');
    assert.equal(nameKey('MLEKO\t\t POLNO'), 'mleko polno');
    // mleko and mléko are different words; keeping the accent is the point.
    assert.equal(nameKey('Mlečni izdelki'), 'mlečni izdelki');
    assert.notEqual(nameKey('mlečni'), nameKey('mlecni'));
});

test('nameKey matches the PHP implementation it is mirrored from', () => {
    // The controller writes list_purchases.name_key with its own copy of this
    // rule. If the two drift, "Mleko" and "mleko" stop being the same entry in
    // the history and the frequent list silently splits in two.
    const php = readFileSync(join(ROOT, 'app/controllers/list-controller.php'), 'utf8');
    const fn = php.match(/function nameKey\(string \$value\): string\s*\{([\s\S]*?)\n\}/);
    assert.ok(fn, 'nameKey() not found in list-controller.php');
    const body = fn[1];
    assert.match(body, /mb_strtolower/, 'PHP nameKey must lowercase');
    assert.match(body, /preg_replace\('\/\\s\+\/u', ' '/, 'PHP nameKey must collapse whitespace');
    assert.match(body, /trim\(/, 'PHP nameKey must trim');
    assert.doesNotMatch(body, /iconv|transliterate|ASCII/i, 'PHP nameKey must NOT strip diacritics');
});

// ------------------------------------------------------------------
//  Matching what someone typed against the vocabulary
// ------------------------------------------------------------------

test('fold strips diacritics so a plain keyboard can reach every label', () => {
    assert.equal(fold('Špar'), 'spar');
    assert.equal(fold('mlečni izdelki'), 'mlecni izdelki');
    assert.equal(fold('Tuš'), 'tus');
});

test('a label is reachable by prefix, without its accents', () => {
    assert.equal(matchLabels('mle', LABELS, 'section')?.id, 4);
    assert.equal(matchLabels('mlecni', LABELS, 'section')?.id, 4);
    assert.equal(matchLabels('spar', LABELS, 'shop')?.id, 12);
    assert.equal(matchLabels('HOFER', LABELS, 'shop')?.id, 10);
});

test('an unmatched query resolves to nothing rather than to a guess', () => {
    assert.equal(matchLabels('zzz', LABELS, 'section'), null);
    // A section query must not fall through to a shop of the same name.
    assert.equal(matchLabels('hofer', LABELS, 'section'), null);
});

test('a shorter exact name wins over a longer one that merely starts the same', () => {
    const labels = [
        { id: 1, kind: 'shop', name: 'Mercator', sort_order: 0 },
        { id: 2, kind: 'shop', name: 'Mer', sort_order: 1 },
    ];
    assert.equal(matchLabels('mer', labels, 'shop').id, 2);
});

// ------------------------------------------------------------------
//  Typing an item with labels in one line
// ------------------------------------------------------------------

test('# tokens label an item and leave the name clean', () => {
    const out = parseAddInput('mleko #mle #lidl', LABELS);
    assert.equal(out.name, 'mleko');
    assert.equal(out.sectionId, 4);
    assert.deepEqual(out.shopIds, [11]);
});

test('a # token that matches nothing stays part of the name', () => {
    // Losing text the user typed is worse than failing to label: "#2" is a
    // quantity, not a label.
    const out = parseAddInput('jajca #2 #hofer', LABELS);
    assert.equal(out.name, 'jajca #2');
    assert.deepEqual(out.shopIds, [10]);
    assert.deepEqual(out.unmatched, ['2']);
});

test('several shops can be named at once, one section cannot', () => {
    const out = parseAddInput('mleko #hofer #lidl #mle #pek', LABELS);
    assert.deepEqual(out.shopIds, [10, 11]);
    // The last section named wins rather than the item carrying two aisles.
    assert.equal(out.sectionId, 3);
});

test('a bare name parses to a bare item', () => {
    const out = parseAddInput('  kruh  ', LABELS);
    assert.equal(out.name, 'kruh');
    assert.equal(out.sectionId, null);
    assert.deepEqual(out.shopIds, []);
});

test('a hash inside a word is not a label token', () => {
    // "no5#lidl" is a product code somebody pasted, not a request to file the
    // item under Lidl.
    const out = parseAddInput('krema no5#lidl', LABELS);
    assert.equal(out.name, 'krema no5#lidl');
    assert.deepEqual(out.shopIds, []);
});

// ------------------------------------------------------------------
//  Where a new item's labels come from
// ------------------------------------------------------------------

test('what the person typed beats everything else', () => {
    const out = resolveNewItemLabels({
        typed: { sectionId: 4, shopIds: [11] },
        memory: { sectionId: 1, shopIds: [10] },
        filter: { sectionId: 2, shopId: 12 },
    });
    assert.equal(out.sectionId, 4);
    assert.deepEqual(out.shopIds, [11]);
});

test('what this list bought last time fills in what was not typed', () => {
    const out = resolveNewItemLabels({
        typed: { sectionId: null, shopIds: [] },
        memory: { sectionId: 4, shopIds: [11] },
        filter: {},
    });
    assert.equal(out.sectionId, 4);
    assert.deepEqual(out.shopIds, [11]);
});

test('standing in a filtered aisle labels what you add there', () => {
    // Typed nothing, never bought before: the screen you are looking at is the
    // best evidence of where this belongs.
    const out = resolveNewItemLabels({
        typed: { sectionId: null, shopIds: [] },
        memory: null,
        filter: { sectionId: 2, shopId: 10 },
    });
    assert.equal(out.sectionId, 2);
    assert.deepEqual(out.shopIds, [10]);
});

test('an item with no evidence at all stays unlabelled', () => {
    const out = resolveNewItemLabels({ typed: { sectionId: null, shopIds: [] }, memory: null, filter: {} });
    assert.equal(out.sectionId, null);
    assert.deepEqual(out.shopIds, []);
});

// ------------------------------------------------------------------
//  The filter, as used standing in a shop
// ------------------------------------------------------------------

test('a shop filter also shows items that name no shop', () => {
    // THE RULE THE WHOLE FILTER RESTS ON. An item with no shop means "anywhere",
    // so hiding it while you are in Hofer is how you get home without it.
    const items = [
        item('mleko', { id: 1, shopIds: [11] }),
        item('kruh', { id: 2, shopIds: [10] }),
        item('jajca', { id: 3, shopIds: [] }),
    ];
    const shown = applyFilter(items, { shopId: 10 }).map((i) => i.name);
    assert.deepEqual(shown, ['kruh', 'jajca']);
});

test('a section filter is exact, because an unplaced item has no aisle', () => {
    const items = [
        item('mleko', { id: 1, sectionId: 4 }),
        item('jabolka', { id: 2, sectionId: 1 }),
        item('baterije', { id: 3, sectionId: null }),
    ];
    assert.deepEqual(applyFilter(items, { sectionId: 4 }).map((i) => i.name), ['mleko']);
});

test('a shop and a section narrow together', () => {
    const items = [
        item('mleko', { id: 1, sectionId: 4, shopIds: [10] }),
        item('sir', { id: 2, sectionId: 4, shopIds: [11] }),
        item('kruh', { id: 3, sectionId: 3, shopIds: [10] }),
    ];
    assert.deepEqual(applyFilter(items, { shopId: 10, sectionId: 4 }).map((i) => i.name), ['mleko']);
});

test('no filter shows everything', () => {
    const items = [item('a', { id: 1 }), item('b', { id: 2, sectionId: 4 })];
    assert.equal(applyFilter(items, {}).length, 2);
    assert.equal(applyFilter(items, { shopId: null, sectionId: null }).length, 2);
});

test('an item carrying several shops matches any one of them', () => {
    const items = [item('mleko', { id: 1, shopIds: [10, 11] })];
    assert.equal(applyFilter(items, { shopId: 11 }).length, 1);
    assert.equal(applyFilter(items, { shopId: 12 }).length, 0);
});

// ------------------------------------------------------------------
//  The order the list is walked in
// ------------------------------------------------------------------

test('items follow the aisles in store order, not the order they were typed', () => {
    const items = [
        item('mleko', { id: 1, sectionId: 4, createdAt: '2026-09-11 10:00:00.000' }),
        item('jabolka', { id: 2, sectionId: 1, createdAt: '2026-09-11 11:00:00.000' }),
        item('kruh', { id: 3, sectionId: 3, createdAt: '2026-09-11 12:00:00.000' }),
    ];
    assert.deepEqual(sortItems(items).map((i) => i.name), ['jabolka', 'kruh', 'mleko']);
});

test('unplaced items sink to the bottom instead of leading the walk', () => {
    const items = [
        item('baterije', { id: 1, sectionId: null, createdAt: '2026-09-11 09:00:00.000' }),
        item('mleko', { id: 2, sectionId: 4, createdAt: '2026-09-11 10:00:00.000' }),
    ];
    assert.deepEqual(sortItems(items).map((i) => i.name), ['mleko', 'baterije']);
});

test('within one aisle the oldest entry leads', () => {
    const items = [
        item('drugo', { id: 2, sectionId: 4, createdAt: '2026-09-11 12:00:00.000' }),
        item('prvo', { id: 1, sectionId: 4, createdAt: '2026-09-11 10:00:00.000' }),
    ];
    assert.deepEqual(sortItems(items).map((i) => i.name), ['prvo', 'drugo']);
});

// ------------------------------------------------------------------
//  Only labels in play become filter chips
// ------------------------------------------------------------------

test('the filter row offers only labels the open list actually uses', () => {
    // Thirteen sections and six shops as permanent chips is the overstimulating
    // version. The row is as short as the list is simple.
    const items = [
        item('mleko', { id: 1, sectionId: 4, shopIds: [11] }),
        item('kruh', { id: 2, sectionId: 3, shopIds: [] }),
    ];
    const used = usedLabels(items, LABELS);
    assert.deepEqual(used.sections.map((l) => l.name), ['pekarna', 'mlečni izdelki']);
    assert.deepEqual(used.shops.map((l) => l.name), ['Lidl']);
});

test('a bought item stops offering its label as a filter', () => {
    const items = [
        item('mleko', { id: 1, sectionId: 4, checked: 1 }),
        item('kruh', { id: 2, sectionId: 3 }),
    ];
    const used = usedLabels(items, LABELS);
    assert.deepEqual(used.sections.map((l) => l.name), ['pekarna']);
});

test('a list with no labels offers no filter row at all', () => {
    const used = usedLabels([item('mleko', { id: 1 })], LABELS);
    assert.deepEqual(used.sections, []);
    assert.deepEqual(used.shops, []);
});

// ------------------------------------------------------------------
//  Who added it
// ------------------------------------------------------------------

test('initials come from a display name, and fall back to the email', () => {
    assert.equal(initials({ display_name: 'Domen Hribernik' }), 'DH');
    assert.equal(initials({ display_name: 'Iliana' }), 'I');
    assert.equal(initials({ display_name: '', email: 'domen@example.com' }), 'D');
    assert.equal(initials(null), '');
});

test('a long name gives first and last initials, never a run of them', () => {
    assert.equal(initials({ display_name: 'Ana Marija Novak Kovač' }), 'AK');
});

test('your own items are not tagged with your own initials', () => {
    // You know what you added. The information is who ELSE did.
    const me = { id: 1 };
    assert.equal(isMine(item('mleko', { addedBy: 1 }), me), true);
    assert.equal(isMine(item('kruh', { addedBy: 2 }), me), false);
    assert.equal(isMine(item('kruh', { addedBy: 2 }), null), false);
});

// ------------------------------------------------------------------
//  Dates, day-first and Slovenian
// ------------------------------------------------------------------

test('a purchase from today reads as today', () => {
    assert.equal(formatDaySl('2026-09-11 18:32:00.000', '2026-09-11'), 'danes');
});

test('a purchase from yesterday reads as yesterday', () => {
    assert.equal(formatDaySl('2026-09-10 18:32:00.000', '2026-09-11'), 'včeraj');
});

test('an older purchase is day-first, never month-first', () => {
    // The whole reason this repo bans <input type="date">: 9. 11. would be read
    // as 9 November by half of Europe and 11 September by the other half.
    assert.equal(formatDaySl('2026-09-09 08:00:00.000', '2026-09-11'), '9. 9.');
    assert.equal(formatDaySl('2026-03-01 08:00:00.000', '2026-09-11'), '1. 3.');
});

test('a purchase from another year carries the year', () => {
    assert.equal(formatDaySl('2025-12-24 08:00:00.000', '2026-09-11'), '24. 12. 2025');
});

test('times are 24 hour with a leading zero on the minutes', () => {
    assert.equal(formatTimeSl('2026-09-11 18:05:00.000'), '18:05');
    assert.equal(formatTimeSl('2026-09-11 08:00:00.000'), '8:00');
});

test('a SQL timestamp is read as local time, not as UTC', () => {
    // new Date('2026-09-11 23:30:00') is parsed inconsistently across browsers
    // and as UTC in some, which lands a late-evening shop on the wrong day.
    assert.equal(formatDaySl('2026-09-11 23:30:00.000', '2026-09-11'), 'danes');
    assert.equal(formatDaySl('2026-09-11 00:30:00.000', '2026-09-11'), 'danes');
});

test('history is grouped into trips, newest day first', () => {
    const purchases = [
        { id: 5, name: 'mleko', bought_at: '2026-09-11 18:32:00.000' },
        { id: 4, name: 'kruh', bought_at: '2026-09-11 18:31:00.000' },
        { id: 3, name: 'jajca', bought_at: '2026-09-09 12:00:00.000' },
    ];
    const days = groupByDay(purchases, '2026-09-11');
    assert.equal(days.length, 2);
    assert.equal(days[0].label, 'danes');
    assert.deepEqual(days[0].purchases.map((p) => p.name), ['mleko', 'kruh']);
    assert.equal(days[1].label, '9. 9.');
    assert.equal(days[1].purchases.length, 1);
});

test('an empty history groups into nothing', () => {
    assert.deepEqual(groupByDay([], '2026-09-11'), []);
});

// ------------------------------------------------------------------
//  Odds and ends the UI depends on
// ------------------------------------------------------------------

test('a remembered filter survives a reload that has not loaded its items yet', () => {
    // The bug this pins: the prune ran on the first paint, when the list was
    // still empty, decided every label was unused, and wiped the filter the
    // person had left running before every single reload.
    const filter = { shopId: 10, sectionId: 4 };
    const out = pruneFilter(filter, { sections: [], shops: [] }, { loaded: false });
    assert.deepEqual(out, { shopId: 10, sectionId: 4 });
});

test('a filter pointing at a label nobody uses any more is dropped', () => {
    // Otherwise the list looks empty and the reason is off the side of a
    // scrolling chip row.
    const used = { sections: [{ id: 4 }], shops: [] };
    const out = pruneFilter({ shopId: 10, sectionId: 4 }, used, { loaded: true });
    assert.deepEqual(out, { shopId: null, sectionId: 4 });
});

test('a filter still in play is left alone', () => {
    const used = { sections: [{ id: 4 }], shops: [{ id: 10 }] };
    const out = pruneFilter({ shopId: 10, sectionId: 4 }, used, { loaded: true });
    assert.deepEqual(out, { shopId: 10, sectionId: 4 });
});

test('a remembered filter belongs to one list, not to the app', () => {
    assert.notEqual(filterStorageKey('trgovina'), filterStorageKey('darila'));
    assert.match(filterStorageKey('trgovina'), /trgovina/);
});

test('the default vocabulary matches the one the server applies', () => {
    // The client offers these as the starting point; the server writes them.
    // A drift here means the button offers a vocabulary the list never gets.
    const php = readFileSync(join(ROOT, 'app/controllers/list-controller.php'), 'utf8');
    const block = php.match(/const DEFAULT_LABELS = \[([\s\S]*?)\n\];/);
    assert.ok(block, 'DEFAULT_LABELS not found in list-controller.php');
    for (const name of DEFAULT_LABELS.section) {
        assert.ok(block[1].includes(`'${name}'`), `PHP defaults are missing the section ${name}`);
    }
    for (const name of DEFAULT_LABELS.shop) {
        assert.ok(block[1].includes(`'${name}'`), `PHP defaults are missing the shop ${name}`);
    }
});

test('the sections are ordered as a walk through a shop', () => {
    // Produce first, household last: the order is the route, and it is also the
    // order the list is drawn in.
    const s = DEFAULT_LABELS.section;
    assert.ok(s.indexOf('zelenjava') < s.indexOf('mlečni izdelki'));
    assert.ok(s.indexOf('mlečni izdelki') < s.indexOf('gospodinjstvo'));
    assert.equal(s[s.length - 1], 'higiena');
});
