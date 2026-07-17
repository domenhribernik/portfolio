// Unit tests for the hub launcher's decision logic (views/hub/logic.js).
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accentFromGradient, shelfNote, toggleRequest, applyToggle } from '../views/hub/logic.js';

test('accentFromGradient extracts the first hex color, falling back to ink', () => {
    assert.equal(accentFromGradient('linear-gradient(45deg, #2d6a4f 0%, #74c69d 100%)'), '#2d6a4f');
    assert.equal(accentFromGradient('#abc'), '#abc');
    assert.equal(accentFromGradient('linear-gradient(45deg, red, blue)'), '#1c1a17');
    assert.equal(accentFromGradient(''), '#1c1a17');
    assert.equal(accentFromGradient(null), '#1c1a17');
});

test('shelfNote counts apps in the masthead voice', () => {
    assert.equal(shelfNote(0), 'nothing on the shelf');
    assert.equal(shelfNote(1), '1 app on this shelf');
    assert.equal(shelfNote(4), '4 apps on this shelf');
});

test('toggleRequest builds the add call for a tile not on the shelf', () => {
    assert.deepEqual(toggleRequest(7, false), {
        method: 'POST',
        query: '?shelf=1',
        body: { app_id: 7 },
    });
});

test('toggleRequest builds the remove call for a tile already on the shelf', () => {
    assert.deepEqual(toggleRequest(7, true), {
        method: 'DELETE',
        query: '?shelf=1&app_id=7',
        body: null,
    });
});

test('applyToggle flips one tile without mutating the source list', () => {
    const list = [
        { id: 1, name: 'A', on_shelf: false },
        { id: 2, name: 'B', on_shelf: true },
    ];
    const next = applyToggle(list, 1, true);
    assert.deepEqual(next.map(t => t.on_shelf), [true, true]);
    assert.deepEqual(list.map(t => t.on_shelf), [false, true]);
    assert.deepEqual(applyToggle(list, 2, false)[1].on_shelf, false);
    assert.deepEqual(applyToggle(list, 99, true), list);
});
