// Decision logic for the hub launcher, kept DOM-free so it can be
// unit-tested with `node --test tests/` (no dependencies, no build step).
// script.js imports this as an ES module.

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
