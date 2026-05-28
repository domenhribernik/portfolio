(() => {
    'use strict';

    const API = '../../app/controllers/shopping-controller.php';
    const POLL_INTERVAL_MS = 2000;
    const COLLECTIONS_POLL_INTERVAL_MS = 5000;
    const UUID_KEY = 'shopping.uuid';
    const NOTIFY_DISMISSED_KEY = 'shopping.notifyDismissed';

    // ----- audio -----
    let audioCtx = null;
    let audioUnlocked = false;

    function unlockAudio() {
        if (audioUnlocked) return;
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            audioUnlocked = true;
        } catch { /* audio disabled */ }
    }

    function playTone(freqs, { duration = 0.32, gap = 0.09, volume = 0.12 } = {}) {
        if (!audioCtx) return;
        const now = audioCtx.currentTime;
        freqs.forEach((freq, i) => {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            const start = now + i * gap;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
            osc.connect(gain).connect(audioCtx.destination);
            osc.start(start);
            osc.stop(start + duration + 0.05);
        });
    }

    // ----- state -----
    const state = {
        myUuid: '',
        collections: [],
        activeCollection: null,
        itemsByCollection: Object.create(null),
        versionByCollection: Object.create(null),
        pendingAdds: new Map(),
        editingTab: false,
        itemPollTimer: null,
        collectionsPollTimer: null,
    };

    // ----- DOM -----
    const $ = (id) => document.getElementById(id);
    const els = {
        tabsRow: $('tabs-row'),
        tabs: $('tabs'),
        addInput: $('add-input'),
        addButton: $('add-button'),
        addBar: $('add-bar'),
        itemsActive: $('items-active'),
        itemsChecked: $('items-checked'),
        boughtDivider: $('bought-divider'),
        boughtCount: $('bought-count'),
        clearBought: $('clear-bought'),
        emptyItems: $('empty-items'),
        emptyCollections: $('empty-collections'),
        firstListInput: $('first-list-input'),
        firstListCreate: $('first-list-create'),
        notifyBanner: $('notify-banner'),
        notifyEnable: $('notify-enable'),
        notifyDismiss: $('notify-dismiss'),
        toast: $('toast'),
        main: $('main'),
    };

    // ----- utils -----
    function getUuid() {
        let v = localStorage.getItem(UUID_KEY);
        if (!v) {
            v = (crypto.randomUUID && crypto.randomUUID()) ||
                (Date.now().toString(36) + Math.random().toString(36).slice(2));
            localStorage.setItem(UUID_KEY, v);
        }
        return v;
    }

    function tempId() {
        const r = (crypto.randomUUID && crypto.randomUUID()) || (Math.random().toString(36).slice(2));
        return 'tmp-' + r;
    }

    let toastTimer = null;
    function toast(msg) {
        els.toast.textContent = msg;
        els.toast.classList.add('visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => els.toast.classList.remove('visible'), 2400);
    }

    // ----- API -----
    async function api(url, options = {}) {
        const res = await fetch(url, options);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        return data;
    }

    const jsonPost = (body) => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const jsonPatch = (body) => ({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    const ShoppingAPI = {
        collections: () => api(`${API}?collections=1`),
        items: (collection, since) => {
            const url = `${API}?collection=${encodeURIComponent(collection)}` +
                (since ? `&since=${encodeURIComponent(since)}` : '');
            return api(url);
        },
        add: (collection, name, addedBy) =>
            api(API, jsonPost({ collection, name, added_by: addedBy })),
        registerCollection: (name) =>
            api(`${API}?collection_register=1`, jsonPost({ name })),
        setChecked: (id, checked) =>
            api(`${API}?id=${id}`, jsonPatch({ checked: checked ? 1 : 0 })),
        remove: (id) => api(`${API}?id=${id}`, { method: 'DELETE' }),
        clearBought: (collection) =>
            api(`${API}?collection=${encodeURIComponent(collection)}&checked=1`, { method: 'DELETE' }),
    };

    // ----- collection / tab management -----
    function setActiveCollection(name, { updateHash = true } = {}) {
        if (state.activeCollection === name) return;
        state.activeCollection = name;
        if (updateHash) {
            const target = '#' + encodeURIComponent(name);
            if (location.hash !== target) location.hash = target;
        }
        els.addInput.placeholder = `Add item to ${name}…`;
        renderTabs();
        renderItems();
        // immediately refresh items for the new collection
        refreshItems(true).catch(() => { /* silent */ });
    }

    function renderTabs() {
        els.tabsRow.innerHTML = '';
        const names = [...state.collections];
        // ensure active is in tab list even if it's a freshly-created empty one
        if (state.activeCollection && !names.includes(state.activeCollection)) {
            names.push(state.activeCollection);
        }
        for (const name of names) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'tab-chip' + (name === state.activeCollection ? ' active' : '');
            chip.textContent = name;
            chip.addEventListener('click', () => setActiveCollection(name));
            els.tabsRow.appendChild(chip);
        }
        // add-new chip
        const addChip = document.createElement('button');
        addChip.type = 'button';
        addChip.className = 'tab-chip add-tab';
        addChip.innerHTML = '<i class="fas fa-plus"></i> new list';
        addChip.addEventListener('click', startTabEdit);
        els.tabsRow.appendChild(addChip);
    }

    function startTabEdit() {
        if (state.editingTab) return;
        state.editingTab = true;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'tab-input';
        input.placeholder = 'list name';
        input.maxLength = 100;
        input.enterKeyHint = 'done';
        const finish = (commit) => {
            if (!state.editingTab) return;
            state.editingTab = false;
            const name = input.value.trim();
            if (commit && name) {
                if (!state.collections.includes(name)) {
                    state.itemsByCollection[name] = [];
                    state.versionByCollection[name] = '0:0';
                    ShoppingAPI.registerCollection(name).catch(() => { /* silent */ });
                }
                setActiveCollection(name);
                setTimeout(() => els.addInput.focus(), 0);
            } else {
                renderTabs();
            }
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
        els.tabsRow.replaceChild(input, els.tabsRow.lastChild);
        input.focus();
    }

    // ----- rendering items -----
    function activeItems() {
        const list = state.itemsByCollection[state.activeCollection] || [];
        // pending optimistic items live in the same array under a tempId
        return list;
    }

    function renderItems() {
        const hasCollection = !!state.activeCollection;
        const hasAnyCollections = state.collections.length > 0 || hasCollection;

        els.emptyCollections.classList.toggle('hidden', hasAnyCollections);
        els.tabs.classList.toggle('hidden', !hasAnyCollections);
        els.addBar.classList.toggle('hidden', !hasAnyCollections);

        if (!hasCollection) {
            els.itemsActive.innerHTML = '';
            els.itemsChecked.innerHTML = '';
            els.boughtDivider.classList.add('hidden');
            els.emptyItems.classList.add('hidden');
            return;
        }

        const items = activeItems();
        const unchecked = items.filter((i) => !i.checked);
        const checked   = items.filter((i) =>  i.checked);

        els.itemsActive.innerHTML = '';
        els.itemsChecked.innerHTML = '';
        for (const it of unchecked) els.itemsActive.appendChild(renderItem(it));
        for (const it of checked)   els.itemsChecked.appendChild(renderItem(it));

        if (checked.length) {
            els.boughtDivider.classList.remove('hidden');
            els.boughtCount.textContent = `bought (${checked.length})`;
        } else {
            els.boughtDivider.classList.add('hidden');
        }

        els.emptyItems.classList.toggle('hidden', items.length > 0);
    }

    function renderItem(item) {
        const li = document.createElement('li');
        li.className = 'item-row' + (item.checked ? ' checked' : '') + (isPending(item.id) ? ' pending' : '');
        li.dataset.id = String(item.id);
        li.innerHTML = `
            <span class="item-checkbox"><i class="fas fa-check text-sm"></i></span>
            <span class="item-name"></span>
            <button class="item-delete" aria-label="Delete"><i class="fas fa-xmark"></i></button>
        `;
        li.querySelector('.item-name').textContent = item.name;
        li.addEventListener('click', (e) => {
            if (e.target.closest('.item-delete')) return;
            toggleChecked(item);
        });
        li.querySelector('.item-delete').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteItem(item);
        });
        return li;
    }

    function isPending(id) {
        return typeof id === 'string' && id.startsWith('tmp-');
    }

    // ----- mutations (optimistic) -----
    async function addItem(rawName) {
        const name = rawName.trim();
        if (!name) return;
        if (!state.activeCollection) return;
        const collection = state.activeCollection;
        const tid = tempId();
        const temp = {
            id: tid,
            collection,
            name,
            checked: 0,
            added_by: state.myUuid,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        if (!state.itemsByCollection[collection]) state.itemsByCollection[collection] = [];
        state.itemsByCollection[collection].push(temp);
        state.pendingAdds.set(tid, temp);
        renderItems();

        try {
            const res = await ShoppingAPI.add(collection, name, state.myUuid);
            const real = res.item;
            // swap temp for real in the local list
            const list = state.itemsByCollection[collection];
            const idx = list.findIndex((x) => x.id === tid);
            if (idx >= 0) list[idx] = real;
            state.pendingAdds.delete(tid);
            // collection might be newly created on the server
            if (!state.collections.includes(collection)) {
                state.collections.push(collection);
                state.collections.sort();
                renderTabs();
            }
            renderItems();
        } catch (err) {
            // rollback
            state.pendingAdds.delete(tid);
            const list = state.itemsByCollection[collection] || [];
            state.itemsByCollection[collection] = list.filter((x) => x.id !== tid);
            renderItems();
            toast('Failed to add: ' + err.message);
            // restore input so user can retry
            els.addInput.value = name;
        }
    }

    async function toggleChecked(item) {
        if (isPending(item.id)) return; // can't toggle a not-yet-saved item
        const collection = state.activeCollection;
        const list = state.itemsByCollection[collection] || [];
        const target = list.find((x) => x.id === item.id);
        if (!target) return;
        const prev = target.checked;
        target.checked = prev ? 0 : 1;
        if (target.checked) {
            playTone([659.25, 880], { duration: 0.28, gap: 0.09, volume: 0.11 }); // E5 → A5, upbeat check
        } else {
            playTone([523.25, 392], { duration: 0.28, gap: 0.09, volume: 0.07 }); // C5 → G4, gentle uncheck
        }
        renderItems();
        try {
            await ShoppingAPI.setChecked(target.id, target.checked);
        } catch (err) {
            target.checked = prev;
            renderItems();
            toast('Failed to update: ' + err.message);
        }
    }

    async function deleteItem(item) {
        const collection = state.activeCollection;
        const list = state.itemsByCollection[collection] || [];
        const idx = list.findIndex((x) => x.id === item.id);
        if (idx < 0) return;
        const [removed] = list.splice(idx, 1);
        if (isPending(item.id)) {
            state.pendingAdds.delete(item.id);
            renderItems();
            return;
        }
        renderItems();
        try {
            await ShoppingAPI.remove(item.id);
        } catch (err) {
            list.splice(idx, 0, removed);
            renderItems();
            toast('Failed to delete: ' + err.message);
        }
    }

    async function clearBought() {
        const collection = state.activeCollection;
        if (!collection) return;
        const list = state.itemsByCollection[collection] || [];
        const before = list.slice();
        state.itemsByCollection[collection] = list.filter((x) => !x.checked);
        renderItems();
        try {
            await ShoppingAPI.clearBought(collection);
        } catch (err) {
            state.itemsByCollection[collection] = before;
            renderItems();
            toast('Failed to clear: ' + err.message);
        }
    }

    // ----- live sync -----
    function mergeWithPending(serverItems) {
        const out = serverItems.slice();
        for (const temp of state.pendingAdds.values()) {
            if (temp.collection === state.activeCollection) out.push(temp);
        }
        return out;
    }

    function detectAndNotifyAdds(prev, next) {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        const prevIds = new Set((prev || []).map((x) => x.id));
        for (const item of next) {
            if (isPending(item.id)) continue;
            if (prevIds.has(item.id)) continue;
            if (item.added_by && item.added_by === state.myUuid) continue;
            try {
                new Notification(`🛒 Added to ${item.collection}`, {
                    body: item.name,
                    tag: 'shopping-' + item.id,
                    icon: 'icon-192.png',
                });
            } catch { /* ignored */ }
        }
    }

    async function refreshItems(force = false) {
        const collection = state.activeCollection;
        if (!collection) return;
        const since = force ? null : state.versionByCollection[collection];
        let res;
        try {
            res = await ShoppingAPI.items(collection, since);
        } catch {
            return; // silent on network blips
        }
        if (res.changed === false) {
            state.versionByCollection[collection] = res.version;
            return;
        }
        const prev = state.itemsByCollection[collection] || [];
        const merged = mergeWithPending(res.items);
        // notifications only when this collection is the active one
        // (still, the function is safe across collections)
        detectAndNotifyAdds(prev, merged);
        state.versionByCollection[collection] = res.version;
        state.itemsByCollection[collection] = merged;
        if (collection === state.activeCollection) renderItems();
    }

    async function refreshCollections() {
        let res;
        try {
            res = await ShoppingAPI.collections();
        } catch {
            return;
        }
        const next = res.collections || [];
        const prev = state.collections;
        const changed = next.length !== prev.length || next.some((n, i) => n !== prev[i]);
        if (!changed) return;
        state.collections = next;
        // if no active collection yet and server now has some, pick first
        if (!state.activeCollection && next.length) {
            setActiveCollection(next[0]);
            return;
        }
        // if the active collection isn't a known one anymore AND it has no pending items,
        // keep it visible (user might be about to add to it). Just re-render tabs.
        renderTabs();
        // toggle empty-state visibility
        renderItems();
    }

    function startPolling() {
        stopPolling();
        const tick = async () => {
            if (document.visibilityState !== 'visible') return;
            await refreshItems();
        };
        const tickCollections = async () => {
            if (document.visibilityState !== 'visible') return;
            await refreshCollections();
        };
        state.itemPollTimer = setInterval(tick, POLL_INTERVAL_MS);
        state.collectionsPollTimer = setInterval(tickCollections, COLLECTIONS_POLL_INTERVAL_MS);
    }

    function stopPolling() {
        if (state.itemPollTimer) clearInterval(state.itemPollTimer);
        if (state.collectionsPollTimer) clearInterval(state.collectionsPollTimer);
        state.itemPollTimer = null;
        state.collectionsPollTimer = null;
    }

    // ----- notifications banner -----
    function maybeShowNotifyBanner() {
        if (!('Notification' in window)) return;
        if (Notification.permission !== 'default') return;
        if (localStorage.getItem(NOTIFY_DISMISSED_KEY) === '1') return;
        els.notifyBanner.classList.remove('hidden');
    }
    function hideNotifyBanner() { els.notifyBanner.classList.add('hidden'); }

    // ----- wiring -----
    function submitAdd() {
        const v = els.addInput.value;
        if (!v.trim()) return;
        els.addInput.value = '';
        addItem(v);
        els.addInput.focus();
    }

    function wire() {
        els.addButton.addEventListener('click', submitAdd);
        els.addInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); submitAdd(); }
        });
        els.clearBought.addEventListener('click', clearBought);

        els.notifyEnable.addEventListener('click', async () => {
            try {
                await Notification.requestPermission();
            } catch { /* ignored */ }
            hideNotifyBanner();
        });
        els.notifyDismiss.addEventListener('click', () => {
            localStorage.setItem(NOTIFY_DISMISSED_KEY, '1');
            hideNotifyBanner();
        });

        els.firstListCreate.addEventListener('click', () => {
            const name = els.firstListInput.value.trim();
            if (!name) return;
            state.itemsByCollection[name] = [];
            state.versionByCollection[name] = '0:0';
            ShoppingAPI.registerCollection(name).catch(() => { /* silent */ });
            setActiveCollection(name);
            els.firstListInput.value = '';
            setTimeout(() => els.addInput.focus(), 0);
        });
        els.firstListInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); els.firstListCreate.click(); }
        });

        window.addEventListener('hashchange', () => {
            const target = decodeURIComponent(location.hash.slice(1));
            if (!target) return;
            if (target === state.activeCollection) return;
            if (state.collections.includes(target)) {
                setActiveCollection(target, { updateHash: false });
            } else {
                // accept hash even if not in DB yet (freshly created tab)
                state.itemsByCollection[target] = state.itemsByCollection[target] || [];
                state.versionByCollection[target] = state.versionByCollection[target] || '0:0';
                setActiveCollection(target, { updateHash: false });
            }
        });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                refreshItems().catch(() => {});
                refreshCollections().catch(() => {});
            }
        });
    }

    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.register('./sw.js').catch(() => { /* ignored */ });
    }

    // ----- boot -----
    async function boot() {
        state.myUuid = getUuid();
        registerServiceWorker();
        wire();
        maybeShowNotifyBanner();

        // initial load
        try {
            const res = await ShoppingAPI.collections();
            state.collections = res.collections || [];
        } catch {
            state.collections = [];
        }

        // pick active from hash or first collection
        const hash = decodeURIComponent(location.hash.slice(1));
        let active = null;
        if (hash) active = hash;
        else if (state.collections.length) active = state.collections[0];

        if (active) {
            state.itemsByCollection[active] = state.itemsByCollection[active] || [];
            state.versionByCollection[active] = state.versionByCollection[active] || '0:0';
            setActiveCollection(active);
        } else {
            renderTabs();
            renderItems();
            setTimeout(() => els.firstListInput && els.firstListInput.focus(), 0);
        }

        startPolling();
    }

    document.addEventListener('click', unlockAudio, { once: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
