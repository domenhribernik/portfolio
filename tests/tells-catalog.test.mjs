/* Schema validation of the committed catalog for the Tells field guide
   (views/tells/data/catalog.json), plus the coverage the grid depends on.

   The catalog is hand-written prose and it is the whole product, so a bad edit
   has to fail here rather than reach a learner as a drill with two right
   answers or a plate whose near-miss link goes nowhere.

   Run with: node --test tests/ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { validateCatalog, SCENES } from '../views/tells/logic.js';

const catalog = JSON.parse(
    readFileSync(new URL('../views/tells/data/catalog.json', import.meta.url), 'utf8'),
);

test('the committed catalog is valid', () => {
    assert.deepEqual(validateCatalog(catalog), []);
});

test('the catalog fills all four quadrants and the seam', () => {
    // The grid is the front door. A quadrant with nothing in it is a hole in
    // the argument the page is making, not just an empty cell.
    const seen = new Set(catalog.entries.map((e) => `${e.axis.site}/${e.axis.intent}`));
    for (const site of ['argument', 'judgment']) {
        for (const intent of ['accident', 'deliberate']) {
            assert.ok(seen.has(`${site}/${intent}`), `nothing in ${site}/${intent}`);
        }
    }
    assert.ok([...seen].some((k) => k.endsWith('/both')), 'no straddlers, so the seam renders empty');
});

test('every scene the guide offers is actually used', () => {
    // An unused scene is either a scene worth dropping or a gap in the
    // examples. Either way it should not sit in the constant unnoticed.
    const used = new Set(catalog.entries.flatMap((e) => e.examples.map((x) => x.scene)));
    const unused = SCENES.filter((s) => !used.has(s));
    assert.deepEqual(unused, [], `unused scenes: ${unused.join(', ')}`);
});

test('the guide teaches at least one exploit twin and one heuristic parent', () => {
    // These two relations are the thing this catalog has that a list of
    // definitions does not. If content ever drifts to plain entries, say so.
    assert.ok(catalog.entries.some((e) => e.exploitOf), 'no exploit twins');
    assert.ok(catalog.entries.some((e) => e.parent), 'no heuristic parent chain');
});
