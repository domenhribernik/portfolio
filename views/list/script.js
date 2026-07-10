(() => {
    'use strict';

    const API = '../../app/controllers/list-controller.php';
    const AUTH_API = '../../app/controllers/auth-controller.php';
    const POLL_INTERVAL_MS = 2000;
    const COLLECTIONS_POLL_INTERVAL_MS = 5000;

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
        user: null,
        isAdmin: false,
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
        doneDivider: $('done-divider'),
        doneCount: $('done-count'),
        clearDone: $('clear-done'),
        emptyItems: $('empty-items'),
        emptyCollections: $('empty-collections'),
        firstListInput: $('first-list-input'),
        firstListCreate: $('first-list-create'),
        gate: $('gate'),
        gateIcon: $('gate-icon'),
        gateMessage: $('gate-message'),
        gateLink: $('gate-link'),
        manageAccess: $('manage-access'),
        accessBackdrop: $('access-backdrop'),
        accessSheet: $('access-sheet'),
        accessClose: $('access-close'),
        accessCollection: $('access-collection'),
        accessUsers: $('access-users'),
        accessDelete: $('access-delete'),
        toast: $('toast'),
        main: $('main'),
    };

    // ----- utils -----
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
        if (!res.ok) {
            const err = new Error(data.error || `Request failed (${res.status})`);
            err.status = res.status;
            throw err;
        }
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

    const ListAPI = {
        collections: () => api(`${API}?collections=1`),
        items: (collection, since) => {
            const url = `${API}?collection=${encodeURIComponent(collection)}` +
                (since ? `&since=${encodeURIComponent(since)}` : '');
            return api(url);
        },
        add: (collection, name) =>
            api(API, jsonPost({ collection, name })),
        registerCollection: (name) =>
            api(`${API}?collection_register=1`, jsonPost({ name })),
        setChecked: (id, checked) =>
            api(`${API}?id=${id}`, jsonPatch({ checked: checked ? 1 : 0 })),
        remove: (id) => api(`${API}?id=${id}`, { method: 'DELETE' }),
        clearDone: (collection) =>
            api(`${API}?collection=${encodeURIComponent(collection)}&checked=1`, { method: 'DELETE' }),
        me: () => api(`${AUTH_API}?action=me`),
        accessList: (collection) =>
            api(`${API}?access=1&collection=${encodeURIComponent(collection)}`),
        accessGrant: (collection, userId) =>
            api(`${API}?access=1`, jsonPost({ collection, user_id: userId })),
        accessRevoke: (collection, userId) =>
            api(`${API}?access=1&collection=${encodeURIComponent(collection)}&user_id=${userId}`, { method: 'DELETE' }),
        deleteCollection: (collection) =>
            api(`${API}?collection_delete=1&collection=${encodeURIComponent(collection)}`, { method: 'DELETE' }),
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
                    ListAPI.registerCollection(name).catch(() => { /* silent */ });
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
            els.doneDivider.classList.add('hidden');
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
            els.doneDivider.classList.remove('hidden');
            els.doneCount.textContent = `done (${checked.length})`;
        } else {
            els.doneDivider.classList.add('hidden');
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
            added_by: state.user && (state.user.display_name || state.user.email),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        if (!state.itemsByCollection[collection]) state.itemsByCollection[collection] = [];
        state.itemsByCollection[collection].push(temp);
        state.pendingAdds.set(tid, temp);
        renderItems();

        try {
            const res = await ListAPI.add(collection, name);
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
            await ListAPI.setChecked(target.id, target.checked);
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
            await ListAPI.remove(item.id);
        } catch (err) {
            list.splice(idx, 0, removed);
            renderItems();
            toast('Failed to delete: ' + err.message);
        }
    }

    async function clearDone() {
        const collection = state.activeCollection;
        if (!collection) return;
        const list = state.itemsByCollection[collection] || [];
        const before = list.slice();
        state.itemsByCollection[collection] = list.filter((x) => !x.checked);
        renderItems();
        try {
            await ListAPI.clearDone(collection);
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

    async function refreshItems(force = false) {
        const collection = state.activeCollection;
        if (!collection) return;
        const since = force ? null : state.versionByCollection[collection];
        let res;
        try {
            res = await ListAPI.items(collection, since);
        } catch (err) {
            if (err.status === 401) showGate('signed-out');
            return; // silent on network blips
        }
        if (res.changed === false) {
            state.versionByCollection[collection] = res.version;
            return;
        }
        const merged = mergeWithPending(res.items);
        state.versionByCollection[collection] = res.version;
        state.itemsByCollection[collection] = merged;
        if (collection === state.activeCollection) renderItems();
    }

    async function refreshCollections() {
        let res;
        try {
            res = await ListAPI.collections();
        } catch (err) {
            if (err.status === 401) showGate('signed-out');
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

    // ----- auth gate -----
    // Full-screen stop state: 'signed-out' (no session) or 'no-access'
    // (signed in, but no role in the list project yet).
    function showGate(kind) {
        stopPolling();
        state.activeCollection = null;
        els.tabs.classList.add('hidden');
        els.addBar.classList.add('hidden');
        els.emptyCollections.classList.add('hidden');
        els.emptyItems.classList.add('hidden');
        els.doneDivider.classList.add('hidden');
        els.itemsActive.innerHTML = '';
        els.itemsChecked.innerHTML = '';
        if (kind === 'signed-out') {
            els.gateIcon.className = 'fas fa-user-lock text-4xl text-muted';
            els.gateMessage.textContent = 'Sign in to see your lists.';
            els.gateLink.href = '../account/?redirect=' + encodeURIComponent(location.pathname);
            els.gateLink.classList.remove('hidden');
        } else {
            els.gateIcon.className = 'fas fa-lock text-4xl text-muted';
            els.gateMessage.textContent = 'This account has no access to the lists yet. Ask Domen to let you in.';
            els.gateLink.classList.add('hidden');
        }
        els.gate.classList.remove('hidden');
    }

    // ----- access management (admin only) -----
    function openAccessSheet() {
        const names = [...state.collections];
        if (state.activeCollection && !names.includes(state.activeCollection)) {
            names.push(state.activeCollection);
        }
        if (!names.length) {
            toast('Create a list first');
            return;
        }
        els.accessCollection.innerHTML = '';
        for (const name of names) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            els.accessCollection.appendChild(opt);
        }
        if (state.activeCollection) els.accessCollection.value = state.activeCollection;
        els.accessBackdrop.classList.remove('hidden');
        els.accessSheet.classList.remove('hidden');
        loadAccessUsers();
    }

    function closeAccessSheet() {
        els.accessBackdrop.classList.add('hidden');
        els.accessSheet.classList.add('hidden');
    }

    async function loadAccessUsers() {
        const collection = els.accessCollection.value;
        els.accessUsers.innerHTML = '<li class="py-4 text-sm text-muted">Loading…</li>';
        let res;
        try {
            res = await ListAPI.accessList(collection);
        } catch (err) {
            els.accessUsers.innerHTML = '<li class="py-4 text-sm text-muted">Could not load users.</li>';
            toast('Failed to load access: ' + err.message);
            return;
        }
        // ignore stale responses if the select changed meanwhile
        if (els.accessCollection.value !== collection) return;
        els.accessUsers.innerHTML = '';
        for (const user of res.users) {
            els.accessUsers.appendChild(renderAccessUser(user, collection));
        }
    }

    async function deleteCollectionFromSheet() {
        const collection = els.accessCollection.value;
        if (!collection) return;
        if (!window.confirm(`Delete "${collection}" and all its items? This cannot be undone.`)) return;

        els.accessDelete.disabled = true;
        try {
            await ListAPI.deleteCollection(collection);
        } catch (err) {
            toast('Failed to delete: ' + err.message);
            return;
        } finally {
            els.accessDelete.disabled = false;
        }
        toast(`Deleted "${collection}"`);

        // purge local state
        state.collections = state.collections.filter((n) => n !== collection);
        delete state.itemsByCollection[collection];
        delete state.versionByCollection[collection];
        for (const [tid, temp] of state.pendingAdds) {
            if (temp.collection === collection) state.pendingAdds.delete(tid);
        }

        if (state.activeCollection === collection) {
            state.activeCollection = null;
            if (state.collections.length) {
                setActiveCollection(state.collections[0]);
            } else {
                history.replaceState(null, '', location.pathname + location.search);
                els.addInput.placeholder = 'Add item…';
                renderTabs();
                renderItems();
            }
        } else {
            renderTabs();
        }

        // refresh the sheet against the surviving lists, or close it
        if (state.collections.length || state.activeCollection) {
            openAccessSheet();
        } else {
            closeAccessSheet();
        }
    }

    function renderAccessUser(user, collection) {
        const li = document.createElement('li');
        li.className = 'flex items-center gap-3 py-3';

        const avatar = document.createElement('span');
        avatar.className = 'w-9 h-9 rounded-full bg-line text-muted flex items-center justify-center shrink-0 overflow-hidden font-medium';
        if (user.avatar_url) {
            const img = document.createElement('img');
            img.src = user.avatar_url;
            img.alt = '';
            img.referrerPolicy = 'no-referrer';
            img.className = 'w-full h-full object-cover';
            avatar.appendChild(img);
        } else {
            avatar.textContent = (user.display_name || user.email).charAt(0).toUpperCase();
        }

        const info = document.createElement('span');
        info.className = 'flex-1 min-w-0';
        const name = document.createElement('span');
        name.className = 'block truncate font-medium';
        name.textContent = user.display_name || user.email;
        const email = document.createElement('span');
        email.className = 'block truncate text-xs text-muted';
        email.textContent = user.email;
        info.append(name, email);

        li.append(avatar, info);

        if (user.is_admin) {
            const badge = document.createElement('span');
            badge.className = 'text-xs text-muted uppercase tracking-wide shrink-0';
            badge.textContent = 'admin';
            li.appendChild(badge);
            return li;
        }

        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = user.granted;
        toggle.className = 'w-5 h-5 accent-accent shrink-0 cursor-pointer';
        toggle.setAttribute('aria-label', `Access for ${user.display_name || user.email}`);
        toggle.addEventListener('change', async () => {
            const granted = toggle.checked;
            toggle.disabled = true;
            try {
                if (granted) await ListAPI.accessGrant(collection, user.id);
                else await ListAPI.accessRevoke(collection, user.id);
            } catch (err) {
                toggle.checked = !granted;
                toast('Failed to update access: ' + err.message);
            } finally {
                toggle.disabled = false;
            }
        });
        li.appendChild(toggle);
        return li;
    }

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
        els.clearDone.addEventListener('click', clearDone);

        els.manageAccess.addEventListener('click', openAccessSheet);
        els.accessClose.addEventListener('click', closeAccessSheet);
        els.accessBackdrop.addEventListener('click', closeAccessSheet);
        els.accessCollection.addEventListener('change', loadAccessUsers);
        els.accessDelete.addEventListener('click', deleteCollectionFromSheet);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !els.accessSheet.classList.contains('hidden')) {
                closeAccessSheet();
            }
        });

        els.firstListCreate.addEventListener('click', () => {
            const name = els.firstListInput.value.trim();
            if (!name) return;
            state.itemsByCollection[name] = [];
            state.versionByCollection[name] = '0:0';
            ListAPI.registerCollection(name).catch(() => { /* silent */ });
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
        registerServiceWorker();
        wire();

        // who is asking? gates everything else
        let me = null;
        try {
            me = await ListAPI.me();
        } catch { /* treated as signed out below */ }
        if (!me || !me.user) {
            showGate('signed-out');
            return;
        }
        state.user = me.user;
        state.isAdmin = !!me.user.is_admin;
        if (state.isAdmin) els.manageAccess.classList.remove('invisible');

        // initial load
        try {
            const res = await ListAPI.collections();
            state.collections = res.collections || [];
        } catch (err) {
            if (err.status === 401) { showGate('signed-out'); return; }
            if (err.status === 403) { showGate('no-access'); return; }
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
