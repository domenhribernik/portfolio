// Unit tests for the Dashboard launcher's decision logic
// (views/dashboard/logic.js). Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    accentFromGradient, shelfNote, shelfAppCount,
    toggleRequest, applyToggle,
    normalizeLayout, moveItem, fileIntoFolder, ejectFromFolder, moveWithinFolder,
    createFolder, renameFolder, dissolveEmptyFolders, layoutToSave, applyCreatedIds,
    folderPreviewIcons, slotIndexFromRects, folderHitTest,
} from '../views/dashboard/logic.js';

// ------------------------------------------------------------------
//  Carried-over shelf/picker helpers
// ------------------------------------------------------------------

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
    assert.deepEqual(toggleRequest(7, false), { method: 'POST', query: '?shelf=1', body: { app_id: 7 } });
});

test('toggleRequest builds the remove call for a tile already on the shelf', () => {
    assert.deepEqual(toggleRequest(7, true), { method: 'DELETE', query: '?shelf=1&app_id=7', body: null });
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

// ------------------------------------------------------------------
//  Layout brain
// ------------------------------------------------------------------

const A = id => ({ id, name: 'App' + id, icon: 'fa-solid fa-cube', gradient: '#111111 0%, #222222', folder_id: null, position: 0 });

function payload(apps, folders = []) {
    return { apps, folders };
}

test('normalizeLayout orders a never-arranged shelf by position then server order', () => {
    // all positions 0 -> falls back to the incoming (catalog) order, stable
    const p = payload([
        { ...A(1), position: 0 },
        { ...A(2), position: 0 },
        { ...A(3), position: 0 },
    ]);
    const layout = normalizeLayout(p);
    assert.deepEqual(layout.order, [
        { type: 'app', id: 1 }, { type: 'app', id: 2 }, { type: 'app', id: 3 },
    ]);
    assert.equal(Object.keys(layout.folders).length, 0);
});

test('normalizeLayout interleaves folders and root apps by position, groups folder members', () => {
    const p = payload(
        [
            { ...A(10), folder_id: null, position: 0 },
            { ...A(11), folder_id: 5, position: 1 },
            { ...A(12), folder_id: 5, position: 0 },
            { ...A(13), folder_id: null, position: 2 },
        ],
        [{ id: 5, name: 'Games', position: 1 }],
    );
    const layout = normalizeLayout(p);
    assert.deepEqual(layout.order, [
        { type: 'app', id: 10 },
        { type: 'folder', id: 5 },
        { type: 'app', id: 13 },
    ]);
    // folder members sorted by their own position (12 before 11)
    assert.deepEqual(layout.folders[5].apps, [12, 11]);
});

test('normalizeLayout drops an app pointing at an unknown folder onto the root', () => {
    const p = payload([{ ...A(1), folder_id: 999, position: 0 }]);
    const layout = normalizeLayout(p);
    assert.deepEqual(layout.order, [{ type: 'app', id: 1 }]);
});

test('moveItem reorders the root without mutating the input', () => {
    const layout = normalizeLayout(payload([A(1), A(2), A(3)].map((a, i) => ({ ...a, position: i }))));
    const moved = moveItem(layout, { type: 'app', id: 1 }, 2);
    assert.deepEqual(moved.order.map(o => o.id), [2, 3, 1]);
    assert.deepEqual(layout.order.map(o => o.id), [1, 2, 3]); // original untouched
});

test('fileIntoFolder removes the app from the root and appends it to the folder', () => {
    const layout = normalizeLayout(payload(
        [{ ...A(1), position: 0 }, { ...A(2), position: 2 }],
        [{ id: 9, name: 'F', position: 1 }],
    ));
    const filed = fileIntoFolder(layout, 1, 9);
    assert.deepEqual(filed.order.map(o => o.type + o.id), ['folder9', 'app2']);
    assert.deepEqual(filed.folders[9].apps, [1]);
});

test('ejectFromFolder pops an app back to a root slot', () => {
    const layout = normalizeLayout(payload(
        [{ ...A(1), folder_id: 9, position: 0 }, { ...A(2), folder_id: null, position: 0 }],
        [{ id: 9, name: 'F', position: 1 }],
    ));
    const out = ejectFromFolder(layout, 1, 0);
    assert.equal(out.folders[9].apps.length, 0);
    assert.equal(out.order[0].type, 'app');
    assert.equal(out.order[0].id, 1);
});

test('moveWithinFolder reorders a folder tray', () => {
    const layout = normalizeLayout(payload(
        [
            { ...A(1), folder_id: 9, position: 0 },
            { ...A(2), folder_id: 9, position: 1 },
            { ...A(3), folder_id: 9, position: 2 },
        ],
        [{ id: 9, name: 'F', position: 0 }],
    ));
    const moved = moveWithinFolder(layout, 9, 3, 0);
    assert.deepEqual(moved.folders[9].apps, [3, 1, 2]);
});

test('createFolder appends an empty folder with the temp id', () => {
    const layout = normalizeLayout(payload([{ ...A(1), position: 0 }]));
    const withF = createFolder(layout, 'new-1', 'Fresh');
    assert.equal(withF.folders['new-1'].name, 'Fresh');
    assert.deepEqual(withF.folders['new-1'].apps, []);
    assert.deepEqual(withF.order[withF.order.length - 1], { type: 'folder', id: 'new-1' });
});

test('renameFolder changes only the named folder', () => {
    const layout = createFolder(normalizeLayout(payload([])), 'new-1', 'Old');
    assert.equal(renameFolder(layout, 'new-1', 'New').folders['new-1'].name, 'New');
});

test('dissolveEmptyFolders removes empty folders but keeps populated ones', () => {
    let layout = normalizeLayout(payload(
        [{ ...A(1), folder_id: 8, position: 0 }],
        [{ id: 8, name: 'Keep', position: 0 }, { id: 9, name: 'Drop', position: 1 }],
    ));
    layout = dissolveEmptyFolders(layout);
    assert.ok(layout.folders[8]);
    assert.equal(layout.folders[9], undefined);
    assert.deepEqual(layout.order.map(o => o.type + o.id), ['folder8']);
});

test('layoutToSave emits interleaved root positions and per-folder positions', () => {
    const layout = normalizeLayout(payload(
        [
            { ...A(1), folder_id: null, position: 0 },
            { ...A(2), folder_id: 7, position: 0 },
            { ...A(3), folder_id: 7, position: 1 },
            { ...A(4), folder_id: null, position: 2 },
        ],
        [{ id: 7, name: 'F', position: 1 }],
    ));
    const body = layoutToSave(layout);
    assert.deepEqual(body.folders, [{ id: 7, name: 'F', position: 1 }]);
    // root app 1 at position 0, folder at position 1, root app 4 at position 2
    assert.deepEqual(body.apps.find(a => a.app_id === 1), { app_id: 1, folder_id: null, position: 0 });
    assert.deepEqual(body.apps.find(a => a.app_id === 4), { app_id: 4, folder_id: null, position: 2 });
    // folder members carry the folder id and their tray index
    assert.deepEqual(body.apps.find(a => a.app_id === 2), { app_id: 2, folder_id: 7, position: 0 });
    assert.deepEqual(body.apps.find(a => a.app_id === 3), { app_id: 3, folder_id: 7, position: 1 });
});

test('layoutToSave sends new folders with their temp string id', () => {
    let layout = normalizeLayout(payload([{ ...A(1), position: 0 }]));
    layout = createFolder(layout, 'new-1', 'Temp');
    layout = fileIntoFolder(layout, 1, 'new-1');
    const body = layoutToSave(layout);
    assert.equal(body.folders[0].id, 'new-1');
    assert.equal(body.apps[0].folder_id, 'new-1');
});

test('applyCreatedIds rewrites temp folder ids to the real ones in place', () => {
    let layout = normalizeLayout(payload([{ ...A(1), position: 0 }]));
    layout = createFolder(layout, 'new-1', 'Temp');
    layout = fileIntoFolder(layout, 1, 'new-1');
    const reconciled = applyCreatedIds(layout, { 'new-1': 42 });
    assert.ok(reconciled.folders[42]);
    assert.equal(reconciled.folders['new-1'], undefined);
    assert.deepEqual(reconciled.order.find(o => o.type === 'folder'), { type: 'folder', id: 42 });
    assert.deepEqual(reconciled.folders[42].apps, [1]);
    // no-op when there is nothing to reconcile
    assert.equal(applyCreatedIds(layout, {}), layout);
});

test('shelfAppCount totals root and foldered apps', () => {
    const layout = normalizeLayout(payload(
        [
            { ...A(1), folder_id: null, position: 0 },
            { ...A(2), folder_id: 5, position: 0 },
            { ...A(3), folder_id: 5, position: 1 },
        ],
        [{ id: 5, name: 'F', position: 1 }],
    ));
    assert.equal(shelfAppCount(layout), 3);
});

test('folderPreviewIcons returns up to four member icons with accents', () => {
    const apps = [1, 2, 3, 4, 5].map(id => ({
        id, name: 'A' + id, icon: 'fa-solid fa-star', gradient: '#abcdef 0%', folder_id: 6, position: id,
    }));
    const layout = normalizeLayout(payload(apps, [{ id: 6, name: 'F', position: 0 }]));
    const preview = folderPreviewIcons(layout, 6);
    assert.equal(preview.length, 4);
    assert.deepEqual(preview[0], { icon: 'fa-solid fa-star', accent: '#abcdef' });
    assert.deepEqual(folderPreviewIcons(layout, 'nope'), []);
});

// ------------------------------------------------------------------
//  Drag geometry
// ------------------------------------------------------------------

// Two rows of three 100x100 tiles at x=0,110,220 and y=0,110.
const rects = [
    { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 },
    { left: 110, top: 0, right: 210, bottom: 100, width: 100, height: 100 },
    { left: 220, top: 0, right: 320, bottom: 100, width: 100, height: 100 },
    { left: 0, top: 110, right: 100, bottom: 210, width: 100, height: 100 },
];

test('slotIndexFromRects inserts before the tile whose midpoint the pointer precedes', () => {
    assert.equal(slotIndexFromRects(rects, 10, 10), 0);   // left of first midpoint
    assert.equal(slotIndexFromRects(rects, 60, 10), 1);   // past first midpoint
    assert.equal(slotIndexFromRects(rects, 170, 10), 2);  // past second midpoint
    assert.equal(slotIndexFromRects(rects, 300, 10), 3);  // past third midpoint -> end of row
    assert.equal(slotIndexFromRects(rects, 10, 160), 3);  // second row, before its midpoint
    assert.equal(slotIndexFromRects(rects, 300, 300), 4); // below everything -> append
});

test('folderHitTest returns the folder under the pointer, honoring the inset', () => {
    const folderRects = [
        { id: 5, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 },
        { id: 9, left: 110, top: 0, right: 210, bottom: 100, width: 100, height: 100 },
    ];
    assert.equal(folderHitTest(folderRects, 50, 50, 20), 5);   // dead center of folder 5
    assert.equal(folderHitTest(folderRects, 160, 50, 20), 9);  // center of folder 9
    assert.equal(folderHitTest(folderRects, 5, 5, 20), null);  // inside the inset band -> miss
    assert.equal(folderHitTest(folderRects, 500, 500, 0), null);
});

test('folderHitTest with inset 0 files anywhere over the folder (filing priority)', () => {
    // The launcher passes inset 0 so the whole folder tile is a drop target;
    // a point near the very edge still files rather than reorders.
    const folderRects = [{ id: 5, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }];
    assert.equal(folderHitTest(folderRects, 2, 2, 0), 5);    // top-left corner
    assert.equal(folderHitTest(folderRects, 98, 98, 0), 5);  // bottom-right corner
    assert.equal(folderHitTest(folderRects, 101, 50, 0), null); // just outside -> reorder
});
