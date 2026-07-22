// Decision logic for the Dashboard launcher, kept DOM-free so it can be
// unit-tested with `node --test tests/` (no dependencies, no build step).
// script.js imports this as an ES module.
//
// The layout is the pure model of a personal shelf. Shape:
//   {
//     order:   [ {type:'folder', id}, {type:'app', id}, ... ],  // root sequence
//     folders: { <id>: {id, name, apps:[appId, ...]} },          // one level deep
//     apps:    { <id>: {id, name, icon, gradient, url} },        // tile metadata
//   }
// Folder ids are either a real integer (from the DB) or a temporary string
// like "new-1" for a folder created in the browser but not yet saved. Every
// mutator returns a NEW layout (immutable style, like applyToggle) so the
// render can diff cheaply and the functions stay trivially testable.

// The stored gradient collapses to a flat accent: its first hex color, or ink
// if it has none. Mirrors accentFromGradient() in views/admin/logic.js.
export function accentFromGradient(gradient) {
    const m = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/.exec(gradient || '');
    return m ? m[0] : '#1c1a17';
}

export function shelfNote(count) {
    if (count === 0) return 'nothing on the shelf';
    return count + (count === 1 ? ' app on this shelf' : ' apps on this shelf');
}

// The picker saves one toggle per tap: POST ?shelf=1 {app_id} to add,
// DELETE ?shelf=1&app_id=N to remove. `query` is appended to the API url.
export function toggleRequest(appId, onShelf) {
    if (onShelf) {
        return { method: 'DELETE', query: '?shelf=1&app_id=' + appId, body: null };
    }
    return { method: 'POST', query: '?shelf=1', body: { app_id: appId } };
}

// Returns a new manage list with one tile's on_shelf flipped to `on`.
export function applyToggle(apps, appId, on) {
    return apps.map(t => (t.id === appId ? { ...t, on_shelf: on } : t));
}

// ------------------------------------------------------------------
//  Layout brain
// ------------------------------------------------------------------

function cloneLayout(layout) {
    const folders = {};
    for (const key of Object.keys(layout.folders)) {
        const f = layout.folders[key];
        folders[key] = { id: f.id, name: f.name, apps: f.apps.slice() };
    }
    return {
        order: layout.order.map(r => ({ type: r.type, id: r.id })),
        folders,
        apps: layout.apps, // metadata is treated as immutable
    };
}

function removeAppEverywhere(layout, appId) {
    layout.order = layout.order.filter(o => !(o.type === 'app' && o.id === appId));
    for (const key of Object.keys(layout.folders)) {
        layout.folders[key].apps = layout.folders[key].apps.filter(id => id !== appId);
    }
}

// Server shelf payload -> normalized layout. Root apps (folder_id null) and
// folders interleave in one position sequence; in-folder apps order within
// their folder. Sorts are stable with an index tiebreak, so a never-arranged
// shelf (every position 0) preserves the server's catalog order.
export function normalizeLayout(payload) {
    const foldersIn = Array.isArray(payload && payload.folders) ? payload.folders : [];
    const appsIn    = Array.isArray(payload && payload.apps) ? payload.apps : [];

    const apps = {};
    for (const a of appsIn) {
        apps[a.id] = { id: a.id, name: a.name, icon: a.icon, gradient: a.gradient, url: a.url };
    }

    const folders = {};
    const rootItems = []; // {type, id, position}
    for (const f of foldersIn) {
        folders[f.id] = { id: f.id, name: f.name, apps: [] };
        rootItems.push({ type: 'folder', id: f.id, position: f.position });
    }

    const folderApps = {}; // folderId -> [{id, position}]
    for (const a of appsIn) {
        if (a.folder_id === null || a.folder_id === undefined || !folders[a.folder_id]) {
            // Root app, or an app pointing at a folder we did not receive
            // (defensive: it degrades to the root grid rather than vanishing).
            rootItems.push({ type: 'app', id: a.id, position: a.position });
        } else {
            (folderApps[a.folder_id] ||= []).push({ id: a.id, position: a.position });
        }
    }

    for (const fid of Object.keys(folderApps)) {
        folders[fid].apps = folderApps[fid]
            .map((x, i) => ({ x, i }))
            .sort((p, q) => (p.x.position - q.x.position) || (p.i - q.i))
            .map(p => p.x.id);
    }

    const order = rootItems
        .map((r, i) => ({ r, i }))
        .sort((p, q) => (p.r.position - q.r.position) || (p.i - q.i))
        .map(p => ({ type: p.r.type, id: p.r.id }));

    return { order, folders, apps };
}

// Move a root item (folder or app) to targetIndex, measured against the root
// array WITHOUT the moved item (which is how the drag engine measures: the
// dragged tile renders as a lifted ghost, excluded from the slot rects).
export function moveItem(layout, ref, targetIndex) {
    const next = cloneLayout(layout);
    const from = next.order.findIndex(o => o.type === ref.type && o.id === ref.id);
    if (from === -1) return next;
    const [item] = next.order.splice(from, 1);
    const idx = Math.max(0, Math.min(targetIndex, next.order.length));
    next.order.splice(idx, 0, item);
    return next;
}

// Pull an app out of wherever it lives (root or a folder) and drop it into a
// folder at the end of that folder's tray.
export function fileIntoFolder(layout, appId, folderId) {
    const next = cloneLayout(layout);
    if (!next.folders[folderId]) return next;
    removeAppEverywhere(next, appId);
    next.folders[folderId].apps.push(appId);
    return next;
}

// Pull an app out of its folder and drop it into the root grid at rootIndex.
export function ejectFromFolder(layout, appId, rootIndex) {
    const next = cloneLayout(layout);
    removeAppEverywhere(next, appId);
    const idx = Math.max(0, Math.min(rootIndex, next.order.length));
    next.order.splice(idx, 0, { type: 'app', id: appId });
    return next;
}

// Reorder an app within its own folder tray.
export function moveWithinFolder(layout, folderId, appId, targetIndex) {
    const next = cloneLayout(layout);
    const folder = next.folders[folderId];
    if (!folder) return next;
    const from = folder.apps.indexOf(appId);
    if (from === -1) return next;
    folder.apps.splice(from, 1);
    const idx = Math.max(0, Math.min(targetIndex, folder.apps.length));
    folder.apps.splice(idx, 0, appId);
    return next;
}

// Append a new, empty folder to the root grid. tempId is a client-only string
// ("new-1"); the server assigns the real id and the save response reconciles it.
export function createFolder(layout, tempId, name) {
    const next = cloneLayout(layout);
    next.folders[tempId] = { id: tempId, name, apps: [] };
    next.order.push({ type: 'folder', id: tempId });
    return next;
}

export function renameFolder(layout, folderId, name) {
    const next = cloneLayout(layout);
    if (next.folders[folderId]) next.folders[folderId].name = name;
    return next;
}

// Drop every folder that has no (visible) member app: removed from the root
// order and the folders map. This is the client half of auto-dissolve; the
// server keeps folders that still hold dormant rows the client never saw.
export function dissolveEmptyFolders(layout) {
    const next = cloneLayout(layout);
    next.order = next.order.filter(
        o => o.type !== 'folder' || (next.folders[o.id] && next.folders[o.id].apps.length > 0)
    );
    for (const key of Object.keys(next.folders)) {
        if (next.folders[key].apps.length === 0) delete next.folders[key];
    }
    return next;
}

// Build the PUT ?layout=1 body. Root items take their order index as position
// (folders and root apps share one sequence); a folder's apps take their tray
// index. folder_id carries the folder's id (temp string or real int) so the
// server can resolve new folders created this save.
export function layoutToSave(layout) {
    const folders = [];
    const apps = [];
    layout.order.forEach((ref, position) => {
        if (ref.type === 'folder') {
            const f = layout.folders[ref.id];
            if (!f) return;
            folders.push({ id: f.id, name: f.name, position });
            f.apps.forEach((appId, j) => apps.push({ app_id: appId, folder_id: f.id, position: j }));
        } else {
            apps.push({ app_id: ref.id, folder_id: null, position });
        }
    });
    return { folders, apps };
}

// Reconcile temporary folder ids after a save. The server echoes a map of
// { "new-1": 42 } for the folders it created; this rewrites those keys in the
// live layout to the real ids WITHOUT replacing the whole layout, so edits the
// user made while the save was in flight survive and the next save sends the
// real id (never re-creating the folder).
export function applyCreatedIds(layout, created) {
    if (!created || Object.keys(created).length === 0) return layout;
    const next = cloneLayout(layout);
    for (const tempId of Object.keys(created)) {
        if (!next.folders[tempId]) continue;
        const realId = created[tempId];
        const f = next.folders[tempId];
        f.id = realId;
        next.folders[realId] = f;
        delete next.folders[tempId];
        next.order = next.order.map(o =>
            (o.type === 'folder' && String(o.id) === String(tempId)) ? { type: 'folder', id: realId } : o
        );
    }
    return next;
}

// Up to `limit` {icon, accent} for a folder tile's mini preview grid.
export function folderPreviewIcons(layout, folderId, limit = 4) {
    const folder = layout.folders[folderId];
    if (!folder) return [];
    return folder.apps
        .slice(0, limit)
        .map(id => layout.apps[id])
        .filter(Boolean)
        .map(a => ({ icon: a.icon, accent: accentFromGradient(a.gradient) }));
}

// Total tiles on the shelf (root + all folders), for the masthead note.
export function shelfAppCount(layout) {
    let n = layout.order.filter(o => o.type === 'app').length;
    for (const key of Object.keys(layout.folders)) n += layout.folders[key].apps.length;
    return n;
}

// ------------------------------------------------------------------
//  Drag geometry (pure: rects in, index/hit out)
// ------------------------------------------------------------------

// Insertion index (0..n) for a pointer at (x, y) over a run of item rects in
// reading order. Reads like a grid: past an item's row inserts after it; on an
// item's row, the horizontal midpoint decides before/after.
export function slotIndexFromRects(rects, x, y) {
    for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (y < r.top) return i;              // pointer is above this row
        if (y <= r.bottom) {                  // pointer is on this row
            const cx = r.left + r.width / 2;
            if (x < cx) return i;
        }
    }
    return rects.length;
}

// Folder id whose rect contains (x, y), or null. The inset shrinks the hit
// zone so a tile has to land clearly ON a folder to be filed, leaving the
// outer band for reordering past it.
export function folderHitTest(folderRects, x, y, inset = 0) {
    for (const r of folderRects) {
        if (x >= r.left + inset && x <= r.right - inset
            && y >= r.top + inset && y <= r.bottom - inset) {
            return r.id;
        }
    }
    return null;
}
