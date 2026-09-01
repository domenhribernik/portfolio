import {
    accentFromGradient, shelfNote, shelfAppCount,
    toggleRequest, applyToggle,
    normalizeLayout, moveItem, fileIntoFolder, ejectFromFolder, moveWithinFolder,
    createFolder, renameFolder, dissolveEmptyFolders, layoutToSave, applyCreatedIds,
    folderPreviewIcons, slotIndexFromRects, folderHitTest,
    pressIntent, moveIntent, ownsGesture, releaseIntent, edgeScrollVelocity, escapedPanel,
} from './logic.js';

const API = '../../app/controllers/dashboard-controller.php';

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* non-fatal */ });
}

const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const VIEWS = ['view-loading', 'view-signin', 'view-grid', 'view-empty', 'view-error'];
function show(id) {
    VIEWS.forEach(v => document.getElementById(v).classList.toggle('hidden', v !== id));
}

const grid          = document.getElementById('tile-grid');
const controls      = document.getElementById('controls');
const btnArrange    = document.getElementById('btn-arrange');
const arrangeLabel  = document.getElementById('arrange-label');
const arrangeIcon   = document.getElementById('arrange-icon');
const noteEl        = document.getElementById('shelf-note');
const liveRegion    = document.getElementById('live-region');

let layout    = { order: [], folders: {}, apps: {} };
let arranging = false;
let entranceDone = false;   // after the first render, re-renders skip the rise
let revision  = 0;          // bumps on every local mutation (save reconciliation)
let tempSeq   = 0;          // client-only folder id counter

// ------------------------------------------------------------------
//  Masthead
// ------------------------------------------------------------------

document.getElementById('today').textContent = new Date()
    .toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
    .replace(/,\s*/g, ' · ');

// ------------------------------------------------------------------
//  Boot / load the shelf
// ------------------------------------------------------------------

async function boot() {
    abortDrag();          // the shelf is about to be rebuilt under any live drag
    show('view-loading');
    controls.classList.add('hidden');
    setArranging(false);
    noteEl.textContent = 'opening the shelf…';

    let res;
    try {
        res = await fetch(API, { cache: 'no-store' });
    } catch {
        showError();
        return;
    }

    if (res.status === 401) {
        document.getElementById('signin-link').href =
            '../account/?redirect=' + encodeURIComponent(location.pathname);
        noteEl.textContent = 'signed out';
        show('view-signin');
        return;
    }
    if (!res.ok) { showError(); return; }

    const payload = await res.json().catch(() => null);
    if (!payload || !Array.isArray(payload.apps) || !Array.isArray(payload.folders)) {
        showError();
        return;
    }

    layout = normalizeLayout(payload);
    controls.classList.remove('hidden');

    if (layout.order.length === 0) {
        updateNote();
        show('view-empty');
        return;
    }

    entranceDone = false;
    renderShelf();
    entranceDone = true;
    updateNote();
    show('view-grid');
}

function showError() {
    noteEl.textContent = 'offline';
    show('view-error');
}

// ------------------------------------------------------------------
//  Rendering
// ------------------------------------------------------------------

const siteRoot = new URL('../../', location.href);
function resolveUrl(url) {
    return url.startsWith('/') ? new URL(url.slice(1), siteRoot).href : url;
}

function liKey(li) { return li ? li.dataset.key : null; }

function buildAppTile(appId) {
    const app = layout.apps[appId];
    const a = document.createElement('a');
    a.className = 'tile';
    a.dataset.appId = appId;
    // Anchors are natively draggable on desktop: a mouse press+move would start
    // the browser's link drag and cancel our pointer sequence (this worked on
    // touch, which has no native link drag). Opt out so the arrange drag runs.
    a.draggable = false;
    a.style.setProperty('--accent', accentFromGradient(app.gradient));
    a.href = resolveUrl(app.url);

    const icon = document.createElement('i');
    icon.className = app.icon + ' tile-icon';
    icon.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'tile-name';
    name.textContent = app.name;
    a.append(icon, name);

    a.addEventListener('click', (e) => {
        if (arranging || justDragged) { e.preventDefault(); }
    });
    return a;
}

function buildFolderTile(folder) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'folder-tile';
    btn.dataset.folderId = folder.id;
    if (folder.apps.length === 0) btn.classList.add('is-new');

    const preview = document.createElement('span');
    preview.className = 'folder-preview';
    const icons = folderPreviewIcons(layout, folder.id, 4);
    for (let i = 0; i < 4; i++) {
        const i2 = document.createElement('i');
        if (icons[i]) {
            i2.className = icons[i].icon;
            i2.style.setProperty('--slot-accent', icons[i].accent);
        } else {
            i2.className = 'fa-solid fa-square slot-empty';
        }
        i2.setAttribute('aria-hidden', 'true');
        preview.appendChild(i2);
    }
    btn.appendChild(preview);

    if (arranging && renamingFolderId != null && String(renamingFolderId) === String(folder.id)) {
        const input = document.createElement('input');
        input.className = 'folder-name-input';
        input.type = 'text';
        input.maxLength = 60;
        input.value = folder.name;
        input.placeholder = 'Folder';
        input.setAttribute('aria-label', 'Folder name');
        input.addEventListener('pointerdown', e => e.stopPropagation());
        input.addEventListener('click', e => e.stopPropagation());
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        });
        input.addEventListener('blur', () => commitInlineRename(folder.id, input.value));
        btn.appendChild(input);
        queueMicrotask(() => { input.focus(); input.select(); });
    } else {
        const name = document.createElement('span');
        name.className = 'folder-name';
        name.textContent = folder.name || 'Folder';
        btn.appendChild(name);
    }

    btn.addEventListener('click', (e) => {
        if (justDragged) { e.preventDefault(); return; }
        if (arranging && renamingFolderId != null) return; // let the input keep focus
        openFolder(folder.id);
    });
    return btn;
}

function buildNewFolderTile() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'new-folder-tile';
    btn.innerHTML = '<i class="fa-solid fa-folder-plus" aria-hidden="true"></i><span>New folder</span>';
    btn.addEventListener('click', () => createNewFolder());
    return btn;
}

function renderShelf() {
    grid.classList.toggle('no-entrance', entranceDone);
    grid.replaceChildren();
    layout.order.forEach((ref, i) => {
        const li = document.createElement('li');
        li.dataset.key = ref.type[0] + ':' + ref.id;
        li.style.animationDelay = entranceDone ? '' : (i * 45) + 'ms';
        li.appendChild(ref.type === 'folder' ? buildFolderTile(layout.folders[ref.id]) : buildAppTile(ref.id));
        grid.appendChild(li);
    });
    syncNewFolderTile();
    document.body.classList.toggle('arranging', arranging);
}

// The trailing "New folder" tile, added and removed on its own so arrange mode
// can be entered without rebuilding the shelf.
function syncNewFolderTile() {
    const existing = grid.querySelector(':scope > li[data-key="new-folder"]');
    if (arranging && !existing) {
        const li = document.createElement('li');
        li.dataset.key = 'new-folder';
        li.appendChild(buildNewFolderTile());
        grid.appendChild(li);
    } else if (!arranging && existing) {
        existing.remove();
    }
}

// ------------------------------------------------------------------
//  Reordering the live DOM
// ------------------------------------------------------------------
//
// A drag must never rebuild the tiles. Touch events are dispatched for the
// life of a gesture against the node that was under the finger at touchstart;
// destroy it and the browser stops sending touchmove, our non-passive
// preventDefault never runs, and the compositor claims the gesture and fires
// pointercancel. The drag then dies exactly one slot in, which is what made
// this feel broken on a phone. Only positions change during a drag, so move
// the existing <li> nodes instead: cheaper, and it keeps the gesture alive.

function reorderNodes(container, keys) {
    const have = new Map();
    container.querySelectorAll(':scope > li').forEach(li => have.set(liKey(li), li));
    let cursor = container.firstElementChild;
    for (const key of keys) {
        const li = have.get(key);
        if (!li) continue;
        if (li === cursor) cursor = li.nextElementSibling;
        else container.insertBefore(li, cursor);
    }
}

function reorderShelf() {
    reorderNodes(grid, layout.order.map(ref => ref.type[0] + ':' + ref.id));
    const nf = grid.querySelector(':scope > li[data-key="new-folder"]');
    if (nf) grid.appendChild(nf);   // the New folder tile always trails the shelf
}

function reorderFolderTray() {
    const folder = layout.folders[openFolderId];
    if (folder) reorderNodes(folderTiles, folder.apps.map(id => 'a:' + id));
}

// ------------------------------------------------------------------
//  Arrange mode
// ------------------------------------------------------------------

function setArranging(on) {
    arranging = on;
    btnArrange.setAttribute('aria-pressed', on ? 'true' : 'false');
    arrangeLabel.textContent = on ? 'Done' : 'Arrange';
    // On mobile the label is hidden, so swap the icon to signal the toggled state.
    arrangeIcon.className = on ? 'fa-solid fa-check' : 'fa-solid fa-sliders';
    document.body.classList.toggle('arranging', on);
}

function enterArrange() {
    if (arranging) return;
    setArranging(true);
    // A press in flight is holding a live touch sequence: adding the one new
    // affordance keeps every existing tile node intact (see reorderNodes).
    if (drag) syncNewFolderTile(); else renderShelf();
    updateNote();
}

function exitArrange() {
    if (!arranging) return;
    renamingFolderId = null;
    setArranging(false);
    // Auto-dissolve: drop folders left empty, then persist immediately.
    layout = dissolveEmptyFolders(layout);
    revision++;
    if (layout.order.length === 0) {
        show('view-empty');
    } else {
        renderShelf();
    }
    updateNote();
    flushSave();
}

btnArrange.addEventListener('click', () => (arranging ? exitArrange() : enterArrange()));

// ------------------------------------------------------------------
//  Folders: create / rename / open panel
// ------------------------------------------------------------------

let renamingFolderId = null;

function createNewFolder() {
    const tempId = 'new-' + (++tempSeq);
    layout = createFolder(layout, tempId, 'Folder');
    revision++;
    renamingFolderId = tempId;   // open the inline name field on the fresh tile
    renderShelf();
    announce('New folder added. Name it, then drop apps in.');
    scheduleSave();
}

function commitInlineRename(folderId, value) {
    const name = (value || '').trim() || 'Folder';
    layout = renameFolder(layout, folderId, name);
    revision++;
    renamingFolderId = null;
    renderShelf();
    scheduleSave();
}

// -- Folder panel --------------------------------------------------

const folderPanel   = document.getElementById('folder-panel');
const folderInner   = folderPanel.querySelector('.picker-panel');
const folderTiles   = document.getElementById('folder-tiles');
const folderTitle   = document.getElementById('folder-title');
const folderRename  = document.getElementById('folder-rename');
const folderNote    = document.getElementById('folder-note');
let openFolderId = null;

function openFolder(folderId) {
    openFolderId = folderId;
    folderPanel.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    renderFolderPanel();
    document.getElementById('btn-folder-close').focus();
}

function closeFolder(keepScroll) {
    folderPanel.classList.add('hidden');
    openFolderId = null;
    if (!keepScroll) document.body.style.overflow = '';
}

function renderFolderPanel() {
    const folder = layout.folders[openFolderId];
    if (!folder) { closeFolder(); return; }

    if (arranging) {
        folderTitle.classList.add('hidden');
        folderRename.classList.remove('hidden');
        folderRename.value = folder.name || 'Folder';
        folderNote.textContent = 'drag to reorder · drag a tile out to remove it from the folder';
    } else {
        folderRename.classList.add('hidden');
        folderTitle.classList.remove('hidden');
        folderTitle.textContent = folder.name || 'Folder';
        folderNote.textContent = 'tap an app to open it';
    }
    renderFolderTiles();
}

function renderFolderTiles() {
    const folder = layout.folders[openFolderId];
    if (!folder) return;
    folderTiles.classList.toggle('no-entrance', entranceDone);
    folderTiles.replaceChildren();
    folder.apps.forEach((appId, i) => {
        const li = document.createElement('li');
        li.dataset.key = 'a:' + appId;
        li.style.animationDelay = entranceDone ? '' : (i * 40) + 'ms';
        li.appendChild(buildAppTile(appId));
        folderTiles.appendChild(li);
    });
}

folderRename.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); folderRename.blur(); }
});
folderRename.addEventListener('blur', () => {
    if (openFolderId == null) return;
    const name = folderRename.value.trim() || 'Folder';
    layout = renameFolder(layout, openFolderId, name);
    revision++;
    scheduleSave();
});
document.getElementById('btn-folder-close').addEventListener('click', () => closeFolder());
document.getElementById('folder-backdrop').addEventListener('click', () => closeFolder());

// ------------------------------------------------------------------
//  Drag engine (pointer events; hand-rolled for reliable touch)
// ------------------------------------------------------------------
//
// The phase machine and every threshold live in logic.js; this half only
// touches the DOM. Phases: 'pressing' (finger down, tile still seated) ->
// 'holding' (hold fired, tile lifted) -> 'dragging'. See the note above
// pressIntent() for why iOS forces the gesture to be won at pickup.

let drag = null;          // active press session (see startPress)
let justDragged = false;  // suppresses the click that follows a drag
let holdTimer = null;

function startPress(e, el, container) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const isApp = el.classList.contains('tile');
    const isFolder = el.classList.contains('folder-tile');
    if (!isApp && !isFolder) return;

    const intent = pressIntent({ pointerType: e.pointerType, arranging });

    justDragged = false;
    const li = el.closest('li');
    const inFolder = container === 'folder';
    const ref = isFolder
        ? { type: 'folder', id: el.dataset.folderId }
        : { type: 'app', id: numId(el.dataset.appId) };

    drag = {
        el, li, ref, container, inFolder,
        phase: 'pressing',
        dragOnMove: intent.dragOnMove,
        pointerId: e.pointerId,
        startX: e.clientX, startY: e.clientY,
        ghost: null, capturedBy: null,
        grabX: 0, grabY: 0,
        folderId: inFolder ? openFolderId : null,
        originKey: liKey(li),
        hoverFolder: null,
        lastX: e.clientX, lastY: e.clientY,
    };

    if (intent.holdMs != null) {
        holdTimer = setTimeout(() => { holdTimer = null; pickUp(); }, intent.holdMs);
    }

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
}

// The hold fired: enter arrange mode if we are not in it, then lift the tile.
function pickUp() {
    if (!drag || drag.phase !== 'pressing') return;
    capturePointer();
    if (!arranging) enterArrange();   // leaves every existing tile node in place
    beginDrag();
    if (navigator.vibrate) navigator.vibrate(8);
}

function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;

    switch (moveIntent(drag.phase, { dragOnMove: drag.dragOnMove, dx, dy })) {
        case 'release':
            // A swipe that beat the hold: this touch belongs to the page.
            // Letting go now is what keeps the scroll smooth and stops Safari
            // firing pointercancel at us.
            if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
            teardownPress();
            return;
        case 'wait':
            return;
        case 'drag':
            if (drag.phase === 'pressing') beginDrag();  // mouse path
            updateDrag(e);
    }
}

// Re-point the pointer at a node that outlives the drag. A touch pointer is
// implicitly captured by the element under the finger, and that element gets
// moved around the grid (and, on an eject, into a different container
// entirely) while the drag runs. Capturing the container instead keeps pointer
// delivery stable through all of it. Note this is only half the story: touch
// events keep their own target, which is why nothing may be rebuilt mid-drag.
function capturePointer() {
    if (!drag || drag.capturedBy) return;
    const anchor = drag.inFolder ? folderTiles : grid;
    try {
        anchor.setPointerCapture(drag.pointerId);
        drag.capturedBy = anchor;
    } catch { /* nothing to capture (a synthetic or already-released pointer) */ }
}

function beginDrag() {
    capturePointer();
    const rect = drag.el.getBoundingClientRect();
    drag.grabX = drag.startX - rect.left;
    drag.grabY = drag.startY - rect.top;

    const ghost = drag.el.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.removeAttribute('id');
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    document.body.appendChild(ghost);

    drag.ghost = ghost;
    drag.phase = 'holding';
    justDragged = true;
    drag.li.classList.add('tile-origin');
    drag.context = drag.inFolder ? 'folder' : 'root';
    document.body.classList.add('dragging');
    startEdgeScroll();
}

function updateDrag(e) {
    // Belt to the touchmove suspenders: on a mouse this stops text selection,
    // on a pen it stops the scroll. iOS ignores it, which is why ownsGesture()
    // also drives a non-passive touchmove handler below.
    e.preventDefault();
    drag.phase = 'dragging';
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    placeGhost();
    reflow();
}

function placeGhost() {
    drag.ghost.style.left = (drag.lastX - drag.grabX) + 'px';
    drag.ghost.style.top = (drag.lastY - drag.grabY) + 'px';
}

// Re-evaluate the drop target for the pointer's current position. Split out of
// updateDrag so the auto-scroll loop can re-run it while the finger is still.
function reflow() {
    const x = drag.lastX, y = drag.lastY;
    if (drag.context === 'folder') { updateDragInFolder(x, y); return; }

    // Root context: filing wins. If the pointer is anywhere over a folder tile
    // (inset 0 = its full bounds), that folder is the drop target and we do NOT
    // reorder; reordering only happens when the pointer is clear of every folder.
    let hit = null;
    if (drag.ref.type === 'app') {
        const fr = folderRectList(drag.originKey);
        hit = folderHitTest(fr, x, y, 0);
    }
    setFolderHighlight(hit);
    drag.hoverFolder = hit;
    if (hit != null) return;

    const rects = rootSlotRects(drag.originKey);
    const idx = slotIndexFromRects(rects, x, y);
    const next = moveItem(layout, drag.ref, idx);
    if (!orderEquals(next.order, layout.order)) liveReorder(next, grid, drag.originKey, reorderShelf);
}

function updateDragInFolder(x, y) {
    if (escapedPanel(rectOf(folderInner), x, y)) {
        // Drag-out: eject to the end of the root grid and continue on the shelf.
        layout = ejectFromFolder(layout, drag.ref.id, layout.order.length);
        revision++;
        drag.context = 'root';
        drag.inFolder = false;
        drag.folderId = null;
        closeFolder(true);           // keep body scroll locked; drag is still live
        // Carry the very same <li> over rather than building a fresh one in the
        // grid: it is the node the touch sequence is bound to.
        grid.appendChild(drag.li);
        reorderShelf();
        markOrigin(grid, drag.originKey);
        return;
    }
    const rects = folderSlotRects(drag.originKey);
    const idx = slotIndexFromRects(rects, x, y);
    const next = moveWithinFolder(layout, drag.folderId, drag.ref.id, idx);
    if (!folderAppsEqual(next, layout, drag.folderId)) {
        liveReorder(next, folderTiles, drag.originKey, reorderFolderTray);
    }
}

function onPointerUp(e)     { finishPress(e, false); }
function onPointerCancel(e) { finishPress(e, true); }

function finishPress(e, cancelled) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }

    const { commit, file, suppressClick } = releaseIntent({
        phase: drag.phase,
        cancelled,
        folderHit: drag.context === 'root' && drag.ref.type === 'app' ? drag.hoverFolder : null,
    });

    if (!commit) { teardownPress(); return; }

    if (file != null) {
        layout = fileIntoFolder(layout, drag.ref.id, file);
        revision++;
        announce('Filed into folder.');
    }
    endDrag(suppressClick);
    afterEdit();
}

// Drop the session and its ghost without committing anything. Also the way out
// when the shelf is reloaded under a live drag (a save coming back 401).
function abortDrag() {
    if (!drag) return;
    if (drag.ghost) drag.ghost.remove();
    setFolderHighlight(null);
    teardownPress();
}

function endDrag(suppressClick) {
    abortDrag();
    if (openFolderId != null) renderFolderPanel();
    renderShelf();
    // The click that fires right after the drag must be swallowed once.
    if (suppressClick) setTimeout(() => { justDragged = false; }, 0);
    else justDragged = false;
}

function teardownPress() {
    if (drag && drag.capturedBy) {
        try { drag.capturedBy.releasePointerCapture(drag.pointerId); } catch { /* already gone */ }
    }
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    stopEdgeScroll();
    document.body.classList.remove('dragging');
    if (drag && drag.li) drag.li.classList.remove('tile-origin');
    drag = null;
}

// ------------------------------------------------------------------
//  Edge auto-scroll: a held tile owns the gesture, so the page can no
//  longer be scrolled by hand. Park the tile near an edge instead.
// ------------------------------------------------------------------

let edgeRaf = null;

function startEdgeScroll() {
    if (edgeRaf != null) return;
    const step = () => {
        edgeRaf = requestAnimationFrame(step);
        if (!drag || !ownsGesture(drag.phase)) return;

        // Inside an open folder the tray scrolls; on the shelf, the window.
        const tray = drag.context === 'folder' ? folderTiles : null;
        const box = tray ? rectOf(tray) : { top: 0, bottom: window.innerHeight };
        const v = edgeScrollVelocity(drag.lastY, box);
        if (!v) return;

        const before = tray ? tray.scrollTop : window.scrollY;
        if (tray) tray.scrollTop += v; else window.scrollBy(0, v);
        const after = tray ? tray.scrollTop : window.scrollY;
        if (after === before) return;          // hit the end of the scroll range

        // The pointer has not moved, but everything under it has, so the ghost
        // stays put on screen while the slot it targets changes.
        placeGhost();
        reflow();
    };
    edgeRaf = requestAnimationFrame(step);
}

function stopEdgeScroll() {
    if (edgeRaf != null) { cancelAnimationFrame(edgeRaf); edgeRaf = null; }
}

// Delegated press start on both the root grid and the open folder tray.
grid.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.tile, .folder-tile');
    if (el) startPress(e, el, 'root');
});
folderTiles.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.tile');
    if (el) startPress(e, el, 'folder');
});

// The one lever that reliably stops iOS scrolling a held tile out from under
// the finger. Pointer events cannot do this: Safari decides the gesture is a
// scroll at the first move and ignores preventDefault() on pointermove, and it
// latches touch-action at touchstart so no CSS flip mid-press can help. A
// non-passive touchmove, registered up front and refused only once the tile is
// actually held, is what wins the gesture back. Keep it non-passive.
document.addEventListener('touchmove', (e) => {
    if (drag && ownsGesture(drag.phase) && e.cancelable) e.preventDefault();
}, { passive: false });

// Long-press on a tile must never raise the platform's own menu: iOS shows the
// link callout for an <a>, desktop and Android the context menu, and either one
// steals the pointer and kills the drag. CSS -webkit-touch-callout covers iOS;
// this covers the rest.
function killContextMenu(e) {
    if (arranging || (drag && ownsGesture(drag.phase))) e.preventDefault();
}
grid.addEventListener('contextmenu', killContextMenu);
folderTiles.addEventListener('contextmenu', killContextMenu);

// Belt and suspenders for the anchor-drag issue above: kill any native drag
// that a desktop browser still tries to begin on a tile mid-arrange.
grid.addEventListener('dragstart', e => e.preventDefault());
folderTiles.addEventListener('dragstart', e => e.preventDefault());
grid.addEventListener('selectstart', e => { if (drag) e.preventDefault(); });
folderTiles.addEventListener('selectstart', e => { if (drag) e.preventDefault(); });

// ------------------------------------------------------------------
//  Drag helpers (DOM measurement; pure math lives in logic.js)
// ------------------------------------------------------------------

function numId(v) { const n = Number(v); return Number.isNaN(n) ? v : n; }

function orderEquals(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].type !== b[i].type || String(a[i].id) !== String(b[i].id)) return false;
    }
    return true;
}

function folderAppsEqual(a, b, folderId) {
    const x = a.folders[folderId] ? a.folders[folderId].apps : [];
    const y = b.folders[folderId] ? b.folders[folderId].apps : [];
    if (x.length !== y.length) return false;
    return x.every((v, i) => v === y[i]);
}

function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}

function rootSlotRects(excludeKey) {
    const rects = [];
    grid.querySelectorAll(':scope > li').forEach(li => {
        if (liKey(li) === excludeKey || li.dataset.key === 'new-folder') return;
        rects.push(rectOf(li));
    });
    return rects;
}

function folderSlotRects(excludeKey) {
    const rects = [];
    folderTiles.querySelectorAll(':scope > li').forEach(li => {
        if (liKey(li) === excludeKey) return;
        rects.push(rectOf(li));
    });
    return rects;
}

function folderRectList(excludeKey) {
    const rects = [];
    grid.querySelectorAll('.folder-tile').forEach(el => {
        const li = el.closest('li');
        if (liKey(li) === excludeKey) return;
        const r = rectOf(el);
        r.id = el.dataset.folderId;
        rects.push(r);
    });
    return rects;
}

function setFolderHighlight(id) {
    grid.querySelectorAll('.folder-tile.drop-target').forEach(el => {
        if (id == null || el.dataset.folderId !== String(id)) el.classList.remove('drop-target');
    });
    if (id != null) {
        const el = grid.querySelector('.folder-tile[data-folder-id="' + CSS.escape(String(id)) + '"]');
        if (el) el.classList.add('drop-target');
    }
}

// FLIP: swap to the new layout, re-render the container, animate the shift.
function liveReorder(next, container, originKey, renderFn) {
    const prev = captureRects(container);
    layout = next; revision++;
    if (renderFn) renderFn(); else renderShelf();
    playFlip(container, prev);
    markOrigin(container, originKey);
}

function captureRects(container) {
    const map = new Map();
    container.querySelectorAll(':scope > li').forEach(li => {
        const k = liKey(li);
        if (k) map.set(k, li.getBoundingClientRect());
    });
    return map;
}

function playFlip(container, prev) {
    if (prefersReduced) return;
    container.querySelectorAll(':scope > li').forEach(li => {
        const k = liKey(li);
        const old = k && prev.get(k);
        if (!old) return;
        const now = li.getBoundingClientRect();
        const dx = old.left - now.left, dy = old.top - now.top;
        if (!dx && !dy) return;
        li.classList.remove('flip');
        li.style.transform = `translate(${dx}px, ${dy}px)`;
        requestAnimationFrame(() => {
            li.classList.add('flip');
            li.style.transform = '';
        });
    });
}

function markOrigin(container, originKey) {
    container.querySelectorAll('.tile-origin').forEach(el => el.classList.remove('tile-origin'));
    const li = [...container.querySelectorAll(':scope > li')].find(l => liKey(l) === originKey);
    if (li) { li.classList.add('tile-origin'); drag.li = li; }
}

// ------------------------------------------------------------------
//  Saving (debounced PUT of the whole layout, serialized)
// ------------------------------------------------------------------

let saveTimer = null;
let saving = false;
let resaveWanted = false;
let saveFailed = false;

function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 600);
}

function flushSave() {
    clearTimeout(saveTimer);
    doSave();
}

async function doSave() {
    if (saving) { resaveWanted = true; return; }
    saving = true;
    const body = layoutToSave(layout);

    let ok = false, data = null, unauthorized = false;
    try {
        const res = await fetch(API + '?layout=1', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            keepalive: true,
        });
        unauthorized = res.status === 401;
        ok = res.ok;
        if (ok) data = await res.json().catch(() => null);
    } catch { ok = false; }

    saving = false;

    if (unauthorized) { boot(); return; }

    if (ok) {
        saveFailed = false;
        if (data && data.created) {
            layout = applyCreatedIds(layout, data.created);
            adoptCreatedIds(data.created);
        }
    } else {
        saveFailed = true;
        scheduleSave();      // one retry on the debounce
    }
    updateNote();

    if (resaveWanted) { resaveWanted = false; doSave(); }
}

// applyCreatedIds() renames a temp folder id in the layout once the server has
// assigned a real one, but the rendered tile still carries the temp id in
// data-folder-id, and folderHitTest reads it straight off the DOM. Left stale,
// a drop resolves to a folder that no longer exists and fileIntoFolder()
// silently returns the layout unchanged: filing into a folder you had just
// made did nothing. Patch the attributes in place rather than re-rendering,
// because a save can land mid-drag and rebuilding tiles would kill the gesture.
function adoptCreatedIds(created) {
    for (const [tempId, realId] of Object.entries(created)) {
        grid.querySelectorAll('.folder-tile').forEach(el => {
            if (el.dataset.folderId === String(tempId)) el.dataset.folderId = String(realId);
        });
        grid.querySelectorAll(':scope > li').forEach(li => {
            if (li.dataset.key === 'f:' + tempId) li.dataset.key = 'f:' + realId;
        });
        if (openFolderId != null && String(openFolderId) === String(tempId)) openFolderId = realId;
        if (drag) {
            if (String(drag.folderId) === String(tempId)) drag.folderId = realId;
            if (drag.originKey === 'f:' + tempId) drag.originKey = 'f:' + realId;
            if (drag.ref.type === 'folder' && String(drag.ref.id) === String(tempId)) drag.ref.id = realId;
        }
    }
}

function afterEdit() {
    updateNote();
    scheduleSave();
}

// Best-effort flush if the app is backgrounded mid-arrange.
window.addEventListener('pagehide', () => { if (saveTimer || saving) flushSave(); });

// ------------------------------------------------------------------
//  Notes / announcements
// ------------------------------------------------------------------

function updateNote() {
    if (saveFailed) { noteEl.textContent = 'could not save arrangement, retrying…'; return; }
    if (arranging) { noteEl.textContent = 'drag to arrange · drop a tile on a folder to file it'; return; }
    noteEl.textContent = shelfNote(shelfAppCount(layout));
}

function announce(msg) { liveRegion.textContent = msg; }

// ------------------------------------------------------------------
//  Shelf picker (add/remove tiles; each toggle saves instantly)
// ------------------------------------------------------------------

const picker = document.getElementById('picker');
const pickerList = document.getElementById('picker-list');
const pickerNote = document.getElementById('picker-note');
const NOTE_DEFAULT = 'tap an app to add or remove it';

let manageList = null;
const inflight = new Set();

function openPicker() {
    picker.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    loadPicker();
    document.getElementById('btn-picker-close').focus();
}

function closePicker() {
    picker.classList.add('hidden');
    document.body.style.overflow = '';
    manageList = null;
    boot(); // the shelf may have changed
}

async function loadPicker() {
    pickerList.replaceChildren();
    pickerNote.textContent = 'loading…';

    let res;
    try {
        res = await fetch(API + '?manage=1', { cache: 'no-store' });
    } catch {
        pickerNote.textContent = 'could not load, check the connection';
        return;
    }
    if (res.status === 401) { closePicker(); return; }
    const apps = res.ok ? await res.json().catch(() => null) : null;
    if (!Array.isArray(apps)) {
        pickerNote.textContent = 'could not load, try again';
        return;
    }

    manageList = apps;
    pickerNote.textContent = NOTE_DEFAULT;
    renderPicker();
}

function renderPicker() {
    pickerList.replaceChildren();

    if (manageList.length === 0) {
        const li = document.createElement('li');
        li.className = 'py-6 text-sm text-stone';
        li.textContent = 'No apps are available to your account yet. Ask the admin.';
        pickerList.appendChild(li);
        return;
    }

    manageList.forEach(app => {
        const li = document.createElement('li');
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'picker-row';
        row.style.setProperty('--accent', accentFromGradient(app.gradient));
        row.setAttribute('aria-pressed', app.on_shelf ? 'true' : 'false');
        if (inflight.has(app.id)) row.setAttribute('data-busy', '');
        row.addEventListener('click', () => onToggle(app.id));

        const icon = document.createElement('i');
        icon.className = app.icon + ' picker-icon';
        icon.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span');
        name.className = 'picker-name';
        name.textContent = app.name;
        const box = document.createElement('span');
        box.className = 'picker-box' + (app.on_shelf ? ' on' : '');
        box.innerHTML = app.on_shelf ? '<i class="fa-solid fa-check" aria-hidden="true"></i>' : '';

        row.append(icon, name, box);
        li.appendChild(row);
        pickerList.appendChild(li);
    });
}

async function onToggle(appId) {
    if (inflight.has(appId) || !manageList) return;
    const tile = manageList.find(t => t.id === appId);
    if (!tile) return;

    const req = toggleRequest(appId, tile.on_shelf);
    inflight.add(appId);
    manageList = applyToggle(manageList, appId, !tile.on_shelf); // optimistic
    pickerNote.textContent = NOTE_DEFAULT;
    renderPicker();

    let ok = false;
    try {
        const res = await fetch(API + req.query, {
            method: req.method,
            headers: req.body ? { 'Content-Type': 'application/json' } : undefined,
            body: req.body ? JSON.stringify(req.body) : undefined,
        });
        ok = res.ok || (req.method === 'DELETE' && res.status === 404);
    } catch { ok = false; }

    inflight.delete(appId);
    if (!ok) {
        manageList = applyToggle(manageList, appId, tile.on_shelf); // revert
        pickerNote.textContent = 'could not save, try again';
    }
    renderPicker();
}

document.getElementById('btn-apps').addEventListener('click', openPicker);
document.getElementById('btn-choose').addEventListener('click', openPicker);
document.getElementById('btn-picker-close').addEventListener('click', closePicker);
document.getElementById('picker-backdrop').addEventListener('click', closePicker);

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!picker.classList.contains('hidden')) closePicker();
    else if (!folderPanel.classList.contains('hidden')) closeFolder();
    else if (arranging) exitArrange();
});

document.getElementById('btn-retry').addEventListener('click', boot);

boot();
