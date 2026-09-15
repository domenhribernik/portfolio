// views/list: the DOM half. Every decision it makes lives in logic.js, which
// is where the tests are; this file talks to the controller and paints.

import {
    nameKey, parseAddInput, resolveNewItemLabels, applyFilter, sortItems,
    usedLabels, initials, attribution, formatDaySl, formatTimeSl, groupByDay,
    filterStorageKey, pruneFilter, todayIso,
} from './logic.js';

const API = '../../app/controllers/list-controller.php';
const AUTH_API = '../../app/controllers/auth-controller.php';
const POLL_INTERVAL_MS = 2000;
const COLLECTIONS_POLL_INTERVAL_MS = 5000;

// ----- zvok -----
let audioCtx = null;

function unlockAudio() {
    if (audioCtx) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch { /* brez zvoka */ }
}

function playTone(freqs, { duration = 0.28, gap = 0.09, volume = 0.11 } = {}) {
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

// ----- stanje -----
const state = {
    user: null,
    isAdmin: false,
    collections: [],
    active: null,
    itemsBy: Object.create(null),
    labelsBy: Object.create(null),
    versionBy: Object.create(null),
    historyBy: Object.create(null),
    frequentBy: Object.create(null),
    pendingAdds: new Map(),
    filter: { shopId: null, sectionId: null },
    traySel: { sectionId: null, shopIds: [] },
    historyOpen: false,
    editing: null,
    sheets: [],
    itemPollTimer: null,
    collectionsPollTimer: null,
    seenIds: new Set(),
};

const $ = (id) => document.getElementById(id);
const els = {
    currentList: $('current-list'), count: $('count'),
    pickerOpen: $('picker-open'), menuOpen: $('menu-open'),
    addInput: $('add-input'), addButton: $('add-button'), addBar: $('add-bar'),
    tray: $('tray'), trayRow: $('tray-row'),
    filters: $('filters'), filterRow: $('filter-row'),
    main: $('main'), itemsActive: $('items-active'), itemsChecked: $('items-checked'),
    doneDivider: $('done-divider'), doneCount: $('done-count'), clearDone: $('clear-done'),
    history: $('history'), historyToggle: $('history-toggle'), historyCaret: $('history-caret'),
    historyBody: $('history-body'), historyHint: $('history-hint'),
    emptyItems: $('empty-items'), quickAdd: $('quick-add'), quickAddRow: $('quick-add-row'),
    emptyCollections: $('empty-collections'),
    firstListInput: $('first-list-input'), firstListCreate: $('first-list-create'),
    gate: $('gate'), gateIcon: $('gate-icon'), gateMessage: $('gate-message'), gateLink: $('gate-link'),
    backdrop: $('backdrop'),
    pickerSheet: $('picker-sheet'), pickerList: $('picker-list'),
    newListInput: $('new-list-input'), newListCreate: $('new-list-create'),
    itemSheet: $('item-sheet'), itemName: $('item-name'), itemSections: $('item-sections'),
    itemShops: $('item-shops'), itemMeta: $('item-meta'), itemDelete: $('item-delete'),
    labelsSheet: $('labels-sheet'), labelsEmpty: $('labels-empty'), labelsDefaults: $('labels-defaults'),
    labelsSections: $('labels-sections'), labelsShops: $('labels-shops'),
    newSection: $('new-section'), newShop: $('new-shop'), accessOpen: $('access-open'),
    accessSheet: $('access-sheet'), accessCollection: $('access-collection'),
    accessUsers: $('access-users'), accessDelete: $('access-delete'),
    toast: $('toast'),
};

// ----- pripomočki -----
const tempId = () => 'tmp-' + ((crypto.randomUUID && crypto.randomUUID()) || Math.random().toString(36).slice(2));
const isPending = (id) => typeof id === 'string' && id.startsWith('tmp-');
const items = () => state.itemsBy[state.active] || [];
const labels = () => state.labelsBy[state.active] || [];

let toastTimer = null;
function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('visible'), 2600);
}

function show(el, on) { el.classList.toggle('hidden', !on); }

// ----- API -----
async function api(url, options = {}) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.error || `Zahteva ni uspela (${res.status})`);
        err.status = res.status;
        throw err;
    }
    return data;
}

const body = (method) => (payload) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
});
const jsonPost = body('POST');
const jsonPatch = body('PATCH');

const ListAPI = {
    me: () => api(`${AUTH_API}?action=me`),
    collections: () => api(`${API}?collections=1`),
    items: (collection, since) =>
        api(`${API}?collection=${encodeURIComponent(collection)}` + (since ? `&since=${encodeURIComponent(since)}` : '')),
    add: (collection, name, sectionId, shopIds) =>
        api(API, jsonPost({ collection, name, section_id: sectionId, shop_ids: shopIds })),
    patch: (id, patch) => api(`${API}?id=${id}`, jsonPatch(patch)),
    remove: (id) => api(`${API}?id=${id}`, { method: 'DELETE' }),
    clearDone: (collection) =>
        api(`${API}?collection=${encodeURIComponent(collection)}&checked=1`, { method: 'DELETE' }),
    registerCollection: (name) => api(`${API}?collection_register=1`, jsonPost({ name })),
    history: (collection, before) =>
        api(`${API}?history=1&collection=${encodeURIComponent(collection)}` + (before ? `&before=${before}` : '')),
    labelsOf: (collection) => api(`${API}?labels=1&collection=${encodeURIComponent(collection)}`),
    addLabel: (collection, kind, name) => api(`${API}?labels=1`, jsonPost({ collection, kind, name })),
    addDefaults: (collection) => api(`${API}?labels=1&defaults=1`, jsonPost({ collection })),
    renameLabel: (id, name) => api(`${API}?labels=1&id=${id}`, jsonPatch({ name })),
    deleteLabel: (id) => api(`${API}?labels=1&id=${id}`, { method: 'DELETE' }),
    accessList: (collection) => api(`${API}?access=1&collection=${encodeURIComponent(collection)}`),
    accessGrant: (collection, userId) => api(`${API}?access=1`, jsonPost({ collection, user_id: userId })),
    accessRevoke: (collection, userId) =>
        api(`${API}?access=1&collection=${encodeURIComponent(collection)}&user_id=${userId}`, { method: 'DELETE' }),
    deleteCollection: (collection) =>
        api(`${API}?collection_delete=1&collection=${encodeURIComponent(collection)}`, { method: 'DELETE' }),
};

// ----- pokrovi (sheets) -----
// Odprt pokrov je vpis v zgodovini, zato ga gumb nazaj na telefonu zapre,
// namesto da bi zapustil stran.
function openSheet(el, onOpen) {
    if (state.sheets.includes(el)) return;
    state.sheets.push(el);
    show(els.backdrop, true);
    show(el, true);
    try { history.pushState({ listSheet: state.sheets.length }, ''); } catch { /* ignore */ }
    if (onOpen) onOpen();
    const focusable = el.querySelector('input, select, button');
    if (focusable && !('ontouchstart' in window)) focusable.focus();
}

/**
 * Resolves once the sheet's history entry has actually been popped.
 * history.back() is asynchronous: anything that touches the URL before the pop
 * lands (switching lists does) gets rolled back by it, which is how picking a
 * list used to leave you on the one you were already on.
 */
function closeTopSheet({ fromPop = false } = {}) {
    const el = state.sheets[state.sheets.length - 1];
    if (!el) return Promise.resolve();
    // The item sheet has no save button: closing it is the save, by whichever
    // route it closes (button, backdrop, Escape, or the phone's back gesture).
    if (el === els.itemSheet && state.editing) saveItemSheet();
    state.sheets.pop();
    show(el, false);
    if (!state.sheets.length) show(els.backdrop, false);
    if (fromPop) return Promise.resolve();

    return new Promise((resolve) => {
        const done = () => {
            window.removeEventListener('popstate', done);
            clearTimeout(fallback);
            resolve();
        };
        const fallback = setTimeout(done, 400);
        window.addEventListener('popstate', done);
        try { history.back(); } catch { done(); }
    });
}

function closeAllSheets() {
    while (state.sheets.length) {
        const el = state.sheets.pop();
        show(el, false);
    }
    show(els.backdrop, false);
}

// ----- zbirke -----
function setActive(name, { updateHash = true } = {}) {
    if (state.active === name) return;
    state.active = name;
    state.traySel = { sectionId: null, shopIds: [] };
    state.historyOpen = false;
    state.filter = loadFilter(name);
    if (updateHash) {
        // Replaced, not pushed: a list is not a screen to walk back through,
        // and a pushed hash fires the hashchange listener below at itself.
        // history.state is carried over because back-link.js keeps its depth there.
        const target = '#' + encodeURIComponent(name);
        if (location.hash !== target) {
            try { history.replaceState(history.state, '', target); } catch { location.hash = target; }
        }
    }
    els.addInput.placeholder = 'Dodaj…';
    if (!state.itemsBy[name]) state.itemsBy[name] = [];
    render();
    refreshItems(true).catch(() => {});
    refreshHistory().catch(() => {});
}

function loadFilter(collection) {
    try {
        const raw = localStorage.getItem(filterStorageKey(collection));
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object') {
            return { shopId: parsed.shopId ?? null, sectionId: parsed.sectionId ?? null };
        }
    } catch { /* zasebno okno ali izklopljen pomnilnik */ }
    return { shopId: null, sectionId: null };
}

function saveFilter() {
    try {
        localStorage.setItem(filterStorageKey(state.active), JSON.stringify(state.filter));
    } catch { /* nič hudega */ }
}

// ----- izris -----
function render() {
    const hasCollections = state.collections.length > 0 || !!state.active;
    show(els.emptyCollections, !hasCollections);
    els.emptyCollections.classList.toggle('flex', !hasCollections);
    show(els.addBar, hasCollections);
    els.pickerOpen.style.visibility = hasCollections ? '' : 'hidden';
    els.menuOpen.classList.toggle('invisible', !state.active);

    els.currentList.textContent = state.active || 'Seznami';

    if (!state.active) {
        els.itemsActive.innerHTML = '';
        els.itemsChecked.innerHTML = '';
        show(els.doneDivider, false);
        show(els.emptyItems, false);
        show(els.filters, false);
        show(els.history, false);
        els.count.textContent = '';
        return;
    }

    renderFilters();
    renderItems();
    renderHistory();
    renderTray();
}

function renderFilters() {
    const used = usedLabels(items(), labels());
    // Only prune once this list's items have actually arrived. On the first
    // paint after a reload everything looks unused, and pruning there would
    // throw away the filter the person left running.
    const loaded = !!state.versionBy[state.active];
    const next = pruneFilter(state.filter, used, { loaded });
    if (next.shopId !== state.filter.shopId || next.sectionId !== state.filter.sectionId) {
        state.filter = next;
        saveFilter();
    }

    const any = used.sections.length || used.shops.length;
    show(els.filters, !!any);
    if (!any) return;

    els.filterRow.innerHTML = '';
    const active = state.filter.shopId || state.filter.sectionId;

    els.filterRow.appendChild(chip('Vse', !active, () => {
        state.filter = { shopId: null, sectionId: null };
        saveFilter();
        render();
    }));

    if (used.shops.length) {
        els.filterRow.appendChild(sep());
        for (const shop of used.shops) {
            els.filterRow.appendChild(chip(shop.name, state.filter.shopId === shop.id, () => {
                state.filter.shopId = state.filter.shopId === shop.id ? null : shop.id;
                saveFilter();
                render();
            }));
        }
    }
    if (used.sections.length) {
        els.filterRow.appendChild(sep());
        for (const section of used.sections) {
            els.filterRow.appendChild(chip(section.name, state.filter.sectionId === section.id, () => {
                state.filter.sectionId = state.filter.sectionId === section.id ? null : section.id;
                saveFilter();
                render();
            }, 'chip--section'));
        }
    }
}

function chip(text, on, onClick, extra = '') {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'chip' + (on ? ' chip--on' : '') + (extra ? ' ' + extra : '');
    el.textContent = text;
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.addEventListener('click', onClick);
    return el;
}

function sep() {
    const el = document.createElement('span');
    el.className = 'chip-sep';
    el.setAttribute('aria-hidden', 'true');
    return el;
}

function renderItems() {
    const all = items();
    const open = all.filter((i) => !i.checked);
    const done = all.filter((i) => i.checked);
    // Kupljeno se nikoli ne filtrira: filter je orodje za nakup, ne za arhiv.
    const shown = sortItems(applyFilter(open, state.filter));

    els.count.textContent = shown.length === open.length
        ? String(open.length)
        : `${shown.length} / ${open.length}`;

    els.itemsActive.innerHTML = '';
    for (const item of shown) els.itemsActive.appendChild(renderItem(item));

    els.itemsChecked.innerHTML = '';
    for (const item of done) els.itemsChecked.appendChild(renderItem(item));

    show(els.doneDivider, done.length > 0);
    els.doneDivider.classList.toggle('flex', done.length > 0);
    els.doneCount.textContent = `Kupljeno · ${done.length}`;

    const filtering = !!(state.filter.shopId || state.filter.sectionId);
    show(els.emptyItems, open.length === 0 || shown.length === 0);
    els.emptyItems.querySelector('p').textContent = open.length === 0
        ? 'Seznam je prazen.'
        : 'Pod tem filtrom ni ničesar.';
    renderQuickAdd(open.length === 0 && !filtering);
}

function renderItem(item) {
    const li = document.createElement('li');
    const pending = isPending(item.id);
    li.className = 'item-row'
        + (item.checked ? ' item-row--done' : '')
        + (pending ? ' item-row--pending' : '');
    if (!state.seenIds.has(item.id)) {
        li.classList.add('item-row--new');
        state.seenIds.add(item.id);
    }

    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'item-check relative';
    check.setAttribute('aria-pressed', item.checked ? 'true' : 'false');
    check.setAttribute('aria-label', item.checked ? `Odkljukaj ${item.name}` : `Kupljeno: ${item.name}`);
    check.innerHTML = '<i class="fas fa-check"></i>';
    check.addEventListener('click', () => toggleChecked(item));

    const bodyBtn = document.createElement('button');
    bodyBtn.type = 'button';
    bodyBtn.className = 'item-body';
    bodyBtn.setAttribute('aria-label', `Uredi ${item.name}`);

    const name = document.createElement('span');
    name.className = 'item-name';
    name.textContent = item.name;
    bodyBtn.appendChild(name);

    const bits = [];
    if (item.section) bits.push(item.section.name);
    for (const shop of item.shops || []) bits.push(shop.name);
    const signed = attribution(item);

    if (bits.length || signed) {
        const meta = document.createElement('span');
        meta.className = 'item-meta';
        if (bits.length) {
            const text = document.createElement('span');
            text.className = 'item-meta__labels';
            text.textContent = bits.join(' · ');
            meta.appendChild(text);
        }
        if (signed) {
            const who = document.createElement('span');
            who.className = 'item-meta__who';
            who.textContent = signed.who;
            who.title = signed.title;
            meta.appendChild(who);
        }
        bodyBtn.appendChild(meta);
    }

    bodyBtn.addEventListener('click', () => {
        if (pending) return;
        openItemSheet(item);
    });

    li.append(check, bodyBtn);
    return li;
}

function renderQuickAdd(on) {
    const frequent = state.frequentBy[state.active] || [];
    show(els.quickAdd, on && frequent.length > 0);
    if (!on || !frequent.length) return;
    els.quickAddRow.innerHTML = '';
    for (const entry of frequent.slice(0, 8)) {
        els.quickAddRow.appendChild(chip(entry.name, false, () => {
            addItem(entry.name, labelIdsFromNames(entry.section, entry.shops));
        }, 'chip--muted'));
    }
}

/** Zgodovina hrani imena oznak kot besedilo; tu jih spet povežemo z oznakami. */
function labelIdsFromNames(sectionName, shopNames) {
    const pool = labels();
    const find = (kind, name) => pool.find((l) => l.kind === kind && nameKey(l.name) === nameKey(name || ''));
    const section = sectionName ? find('section', sectionName) : null;
    const shops = (shopNames || []).map((n) => find('shop', n)).filter(Boolean);
    return { sectionId: section ? section.id : null, shopIds: shops.map((s) => s.id) };
}

// ----- pladenj z oznakami -----
function renderTray() {
    const pool = labels();
    const typing = document.activeElement === els.addInput || els.addInput.value.trim() !== '';
    const on = typing && pool.length > 0;
    els.tray.classList.toggle('tray--open', on);
    if (!on) return;

    const eff = effectiveNewLabels();
    els.trayRow.innerHTML = '';

    // SELECTED CHIPS LEAD. The row scrolls, and with thirteen sections behind
    // six shops the label this item is actually getting sat off the right edge
    // where nobody could see or unset it.
    const chosen = (l) => (l.kind === 'shop' ? eff.shopIds.includes(l.id) : eff.sectionId === l.id);
    const order = (a, b) => (chosen(b) ? 1 : 0) - (chosen(a) ? 1 : 0);

    const shops = pool.filter((l) => l.kind === 'shop').sort(order);
    const sections = pool.filter((l) => l.kind === 'section').sort(order);

    for (const shop of shops) {
        els.trayRow.appendChild(chip(shop.name, eff.shopIds.includes(shop.id), () => {
            const has = state.traySel.shopIds.includes(shop.id);
            const base = state.traySel.shopIds.length ? state.traySel.shopIds : eff.shopIds;
            state.traySel.shopIds = has ? base.filter((id) => id !== shop.id) : [...new Set([...base, shop.id])];
            renderTray();
        }));
    }
    if (sections.length && shops.length) els.trayRow.appendChild(sep());
    for (const section of sections) {
        els.trayRow.appendChild(chip(section.name, eff.sectionId === section.id, () => {
            state.traySel.sectionId = eff.sectionId === section.id ? 0 : section.id;
            renderTray();
        }, 'chip--section'));
    }
}

/** Kaj bo dobil nov vnos: natipkano, kar je bilo nazadnje, ali odprti filter. */
function effectiveNewLabels() {
    const parsed = parseAddInput(els.addInput.value, labels());
    const typed = {
        sectionId: state.traySel.sectionId !== null ? (state.traySel.sectionId || null) : parsed.sectionId,
        shopIds: state.traySel.shopIds.length ? state.traySel.shopIds : parsed.shopIds,
    };
    return resolveNewItemLabels({ typed, memory: memoryFor(parsed.name), filter: state.filter });
}

/** Kar je ta seznam nazadnje kupil pod tem imenom. */
function memoryFor(name) {
    const key = nameKey(name);
    if (!key) return null;

    const open = items().find((i) => nameKey(i.name) === key && !isPending(i.id));
    if (open) {
        return {
            sectionId: open.section ? open.section.id : null,
            shopIds: (open.shops || []).map((s) => s.id),
        };
    }
    const past = (state.historyBy[state.active] || []).find((p) => nameKey(p.name) === key);
    if (past) return labelIdsFromNames(past.section, past.shops);
    return null;
}

// ----- spremembe -----
async function addItem(rawName, forced = null) {
    const collection = state.active;
    if (!collection) return;

    const parsed = parseAddInput(rawName, labels());
    const name = forced ? String(rawName).trim() : parsed.name;
    if (!name) return;

    const chosen = forced || effectiveNewLabels();
    const pool = labels();
    const byId = (id) => pool.find((l) => l.id === id) || null;

    const tid = tempId();
    const temp = {
        id: tid,
        name,
        checked: 0,
        section: chosen.sectionId ? byId(chosen.sectionId) : null,
        shops: chosen.shopIds.map(byId).filter(Boolean),
        added_by: state.user && (state.user.display_name || state.user.email),
        added_by_user_id: state.user ? state.user.id : null,
        created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    };
    if (!state.itemsBy[collection]) state.itemsBy[collection] = [];
    state.itemsBy[collection].push(temp);
    state.pendingAdds.set(tid, { ...temp, collection });
    state.traySel = { sectionId: null, shopIds: [] };
    render();

    try {
        const res = await ListAPI.add(collection, name, chosen.sectionId, chosen.shopIds);
        const list = state.itemsBy[collection];
        const idx = list.findIndex((x) => x.id === tid);
        if (idx >= 0) list[idx] = res.item;
        state.pendingAdds.delete(tid);
        state.seenIds.add(res.item.id);
        if (!state.collections.includes(collection)) {
            state.collections.push(collection);
            state.collections.sort();
        }
        render();
    } catch (err) {
        state.pendingAdds.delete(tid);
        state.itemsBy[collection] = (state.itemsBy[collection] || []).filter((x) => x.id !== tid);
        render();
        toast('Ni bilo mogoče dodati: ' + err.message);
        els.addInput.value = rawName;
    }
}

async function toggleChecked(item) {
    if (isPending(item.id)) return;
    const collection = state.active;
    const target = (state.itemsBy[collection] || []).find((x) => x.id === item.id);
    if (!target) return;

    const prev = { checked: target.checked, checked_by: target.checked_by };
    target.checked = prev.checked ? 0 : 1;
    target.checked_by = target.checked ? (state.user && (state.user.display_name || state.user.email)) : null;
    playTone(target.checked ? [659.25, 880] : [523.25, 392], { volume: target.checked ? 0.11 : 0.07 });
    render();

    try {
        const res = await ListAPI.patch(target.id, { checked: target.checked });
        Object.assign(target, res.item);
        render();
    } catch (err) {
        Object.assign(target, prev);
        render();
        toast('Ni bilo mogoče posodobiti: ' + err.message);
    }
}

async function deleteItem(item) {
    const collection = state.active;
    const list = state.itemsBy[collection] || [];
    const idx = list.findIndex((x) => x.id === item.id);
    if (idx < 0) return;
    const [removed] = list.splice(idx, 1);
    if (isPending(item.id)) {
        state.pendingAdds.delete(item.id);
        render();
        return;
    }
    render();
    try {
        await ListAPI.remove(item.id);
    } catch (err) {
        list.splice(idx, 0, removed);
        render();
        toast('Ni bilo mogoče izbrisati: ' + err.message);
    }
}

async function clearDone() {
    const collection = state.active;
    if (!collection) return;
    const list = state.itemsBy[collection] || [];
    const before = list.slice();
    const count = before.filter((x) => x.checked).length;
    if (!count) return;
    state.itemsBy[collection] = list.filter((x) => !x.checked);
    render();
    try {
        await ListAPI.clearDone(collection);
        toast(count === 1 ? 'Shranjeno v zgodovino' : `${count} shranjenih v zgodovino`);
        await refreshHistory();
        render();
    } catch (err) {
        state.itemsBy[collection] = before;
        render();
        toast('Ni bilo mogoče počistiti: ' + err.message);
    }
}

// ----- živa sinhronizacija -----
function mergeWithPending(serverItems) {
    const out = serverItems.slice();
    for (const temp of state.pendingAdds.values()) {
        if (temp.collection === state.active) out.push(temp);
    }
    return out;
}

async function refreshItems(force = false) {
    const collection = state.active;
    if (!collection) return;
    const since = force ? null : state.versionBy[collection];
    let res;
    try {
        res = await ListAPI.items(collection, since);
    } catch (err) {
        if (err.status === 401) showGate('signed-out');
        if (err.status === 403) showGate('no-access');
        return;
    }
    const firstLoad = !state.versionBy[collection];
    state.versionBy[collection] = res.version;
    if (res.changed === false) return;
    if (firstLoad) for (const item of res.items) state.seenIds.add(item.id);
    state.itemsBy[collection] = mergeWithPending(res.items);
    state.labelsBy[collection] = res.labels || [];
    if (collection === state.active) render();
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
    if (next.length === prev.length && next.every((n, i) => n === prev[i])) return;
    state.collections = next;
    if (!state.active && next.length) {
        setActive(next[0]);
        return;
    }
    render();
}

async function refreshHistory(before = null) {
    const collection = state.active;
    if (!collection) return;
    let res;
    try {
        res = await ListAPI.history(collection, before);
    } catch {
        return;
    }
    if (collection !== state.active) return;
    const existing = before ? (state.historyBy[collection] || []) : [];
    state.historyBy[collection] = existing.concat(res.purchases || []);
    state.frequentBy[collection] = res.frequent || [];
    state.historyBy[collection].hasMore = !!res.has_more;
    renderHistory();
    renderQuickAdd((items().filter((i) => !i.checked).length === 0)
        && !state.filter.shopId && !state.filter.sectionId);
}

function renderHistory() {
    const purchases = state.historyBy[state.active] || [];
    show(els.history, purchases.length > 0);
    if (!purchases.length) return;

    els.historyHint.textContent = state.historyOpen ? '' : `${purchases.length}${purchases.hasMore ? '+' : ''}`;
    els.historyCaret.style.transform = state.historyOpen ? 'rotate(90deg)' : '';
    els.historyToggle.setAttribute('aria-expanded', state.historyOpen ? 'true' : 'false');
    show(els.historyBody, state.historyOpen);
    if (!state.historyOpen) return;

    const today = todayIso();
    els.historyBody.innerHTML = '';
    for (const day of groupByDay(purchases, today)) {
        const head = document.createElement('p');
        head.className = 'hist-day';
        head.textContent = day.label;
        els.historyBody.appendChild(head);

        for (const purchase of day.purchases) {
            const row = document.createElement('div');
            row.className = 'hist-row';

            const name = document.createElement('span');
            name.className = 'hist-name';
            name.textContent = purchase.name;

            const meta = document.createElement('span');
            meta.className = 'hist-meta';
            const who = purchase.bought_by ? initials({ display_name: purchase.bought_by }) : '';
            meta.textContent = [formatTimeSl(purchase.bought_at), who].filter(Boolean).join(' · ');
            if (purchase.bought_by) meta.title = `Kupil/a ${purchase.bought_by}`;

            const again = document.createElement('button');
            again.type = 'button';
            again.className = 'hist-again';
            again.setAttribute('aria-label', `Dodaj ${purchase.name} nazaj na seznam`);
            again.innerHTML = '<i class="fas fa-rotate-left text-[0.72rem]"></i>';
            again.addEventListener('click', () => {
                addItem(purchase.name, labelIdsFromNames(purchase.section, purchase.shops));
                toast(`Dodano: ${purchase.name}`);
            });

            row.append(name, meta, again);
            els.historyBody.appendChild(row);
        }
    }

    if (purchases.hasMore) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'mt-3 text-[0.78rem] text-muted hover:text-ink underline underline-offset-4 decoration-line';
        more.textContent = 'več';
        more.addEventListener('click', () => refreshHistory(purchases[purchases.length - 1].id));
        els.historyBody.appendChild(more);
    }
}

function startPolling() {
    stopPolling();
    state.itemPollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') refreshItems();
    }, POLL_INTERVAL_MS);
    state.collectionsPollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') refreshCollections();
    }, COLLECTIONS_POLL_INTERVAL_MS);
}

function stopPolling() {
    clearInterval(state.itemPollTimer);
    clearInterval(state.collectionsPollTimer);
    state.itemPollTimer = null;
    state.collectionsPollTimer = null;
}

// ----- vrata -----
function showGate(kind) {
    stopPolling();
    closeAllSheets();
    state.active = null;
    show(els.addBar, false);
    show(els.filters, false);
    show(els.emptyCollections, false);
    show(els.emptyItems, false);
    show(els.doneDivider, false);
    show(els.history, false);
    els.itemsActive.innerHTML = '';
    els.itemsChecked.innerHTML = '';
    els.pickerOpen.style.visibility = 'hidden';
    els.menuOpen.classList.add('invisible');
    if (kind === 'signed-out') {
        els.gateIcon.className = 'fas fa-user-lock text-3xl text-muted';
        els.gateMessage.textContent = 'Prijavi se, da vidiš svoje sezname.';
        els.gateLink.href = '../account/?redirect=' + encodeURIComponent(location.pathname);
        show(els.gateLink, true);
    } else {
        els.gateIcon.className = 'fas fa-lock text-3xl text-muted';
        els.gateMessage.textContent = 'Ta račun še nima dostopa do seznamov. Vprašaj Domna.';
        show(els.gateLink, false);
    }
    show(els.gate, true);
    els.gate.classList.add('flex');
}

// ----- pokrov: izbira seznama -----
function openPicker() {
    openSheet(els.pickerSheet, () => {
        els.pickerList.innerHTML = '';
        const names = [...state.collections];
        if (state.active && !names.includes(state.active)) names.push(state.active);
        for (const name of names) {
            const li = document.createElement('li');
            li.className = 'sheet-row' + (name === state.active ? ' sheet-row--on' : '');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sheet-row__name';
            btn.textContent = name;
            btn.addEventListener('click', async () => {
                await closeTopSheet();
                setActive(name);
            });
            li.appendChild(btn);
            if (name === state.active) {
                const mark = document.createElement('i');
                mark.className = 'fas fa-check text-[0.75rem] text-amberInk shrink-0 pr-1';
                mark.setAttribute('aria-hidden', 'true');
                li.appendChild(mark);
            }
            els.pickerList.appendChild(li);
        }
        els.newListInput.value = '';
    });
}

async function createCollection(name) {
    const clean = String(name || '').trim();
    if (!clean) return;
    if (!state.collections.includes(clean)) {
        state.itemsBy[clean] = [];
        state.labelsBy[clean] = [];
        try {
            await ListAPI.registerCollection(clean);
            if (!state.collections.includes(clean)) {
                state.collections.push(clean);
                state.collections.sort();
            }
        } catch (err) {
            toast('Ni bilo mogoče ustvariti: ' + err.message);
            return;
        }
    }
    setActive(clean);
    setTimeout(() => els.addInput.focus(), 0);
}

// ----- pokrov: postavka -----
function openItemSheet(item) {
    state.editing = {
        id: item.id,
        name: item.name,
        sectionId: item.section ? item.section.id : null,
        shopIds: (item.shops || []).map((s) => s.id),
        original: {
            name: item.name,
            sectionId: item.section ? item.section.id : null,
            shopIds: (item.shops || []).map((s) => s.id).join(','),
        },
    };
    openSheet(els.itemSheet, () => {
        els.itemName.value = item.name;
        renderItemSheetChips();

        const lines = [];
        if (item.added_by) {
            lines.push(`Dodal/a ${item.added_by}` +
                (item.created_at ? `, ${formatDaySl(item.created_at, todayIso())} ob ${formatTimeSl(item.created_at)}` : ''));
        }
        if (item.checked && item.checked_by) {
            lines.push(`Kupil/a ${item.checked_by}` +
                (item.checked_at ? `, ${formatDaySl(item.checked_at, todayIso())} ob ${formatTimeSl(item.checked_at)}` : ''));
        }
        els.itemMeta.textContent = lines.join('\n');
        els.itemMeta.style.whiteSpace = 'pre-line';
    });
}

function renderItemSheetChips() {
    const pool = labels();
    const edit = state.editing;
    els.itemSections.innerHTML = '';
    els.itemShops.innerHTML = '';

    const sections = pool.filter((l) => l.kind === 'section');
    const shops = pool.filter((l) => l.kind === 'shop');

    if (!sections.length && !shops.length) {
        const hint = document.createElement('p');
        hint.className = 'text-[0.82rem] text-muted';
        hint.textContent = 'Ta seznam še nima oznak.';
        els.itemSections.appendChild(hint);
        return;
    }

    for (const section of sections) {
        els.itemSections.appendChild(chip(section.name, edit.sectionId === section.id, () => {
            edit.sectionId = edit.sectionId === section.id ? null : section.id;
            renderItemSheetChips();
        }, 'chip--section'));
    }
    for (const shop of shops) {
        els.itemShops.appendChild(chip(shop.name, edit.shopIds.includes(shop.id), () => {
            edit.shopIds = edit.shopIds.includes(shop.id)
                ? edit.shopIds.filter((id) => id !== shop.id)
                : [...edit.shopIds, shop.id];
            renderItemSheetChips();
        }));
    }
}

async function saveItemSheet() {
    const edit = state.editing;
    state.editing = null;
    if (!edit) return;

    const name = els.itemName.value.trim();
    const patch = {};
    if (name && name !== edit.original.name) patch.name = name;
    if (edit.sectionId !== edit.original.sectionId) patch.section_id = edit.sectionId;
    if (edit.shopIds.join(',') !== edit.original.shopIds) patch.shop_ids = edit.shopIds;
    if (!Object.keys(patch).length) return;

    const target = (state.itemsBy[state.active] || []).find((x) => x.id === edit.id);
    if (!target) return;
    const before = { ...target };

    // Optimistično: pokrov se zapre takoj, vrstica se posodobi zdaj.
    const pool = labels();
    if ('name' in patch) target.name = patch.name;
    if ('section_id' in patch) target.section = patch.section_id ? pool.find((l) => l.id === patch.section_id) || null : null;
    if ('shop_ids' in patch) target.shops = patch.shop_ids.map((id) => pool.find((l) => l.id === id)).filter(Boolean);
    render();

    try {
        const res = await ListAPI.patch(edit.id, patch);
        Object.assign(target, res.item);
        render();
    } catch (err) {
        Object.assign(target, before);
        render();
        toast('Ni bilo mogoče shraniti: ' + err.message);
    }
}

// ----- pokrov: oznake -----
function openLabelsSheet() {
    openSheet(els.labelsSheet, renderLabelsSheet);
}

function renderLabelsSheet() {
    const pool = labels();
    show(els.labelsEmpty, pool.length === 0);
    show(els.accessOpen, state.isAdmin);

    const fill = (ul, kind) => {
        ul.innerHTML = '';
        const group = pool.filter((l) => l.kind === kind);
        if (!group.length) {
            const li = document.createElement('li');
            li.className = 'text-[0.82rem] text-muted py-1';
            li.textContent = kind === 'section' ? 'Ni oddelkov.' : 'Ni trgovin.';
            ul.appendChild(li);
            return;
        }
        for (const label of group) {
            const li = document.createElement('li');
            li.className = 'sheet-row';

            const name = document.createElement('button');
            name.type = 'button';
            name.className = 'sheet-row__name';
            name.textContent = label.name;
            name.title = 'Preimenuj';
            name.addEventListener('click', () => startRename(li, label));

            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'sheet-row__act sheet-row__act--danger';
            del.setAttribute('aria-label', `Izbriši oznako ${label.name}`);
            del.innerHTML = '<i class="fas fa-trash-can text-[0.75rem]"></i>';
            del.addEventListener('click', () => removeLabel(label));

            li.append(name, del);
            ul.appendChild(li);
        }
    };
    fill(els.labelsSections, 'section');
    fill(els.labelsShops, 'shop');
}

function startRename(li, label) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'field sheet-row__name px-2 py-1';
    input.value = label.name;
    input.maxLength = 40;
    let done = false;
    const finish = async (commit) => {
        if (done) return;
        done = true;
        const value = input.value.trim();
        if (commit && value && value !== label.name) {
            try {
                await ListAPI.renameLabel(label.id, value);
                await reloadLabels();
            } catch (err) {
                toast('Ni bilo mogoče preimenovati: ' + err.message);
            }
        }
        renderLabelsSheet();
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    li.replaceChild(input, li.firstChild);
    input.focus();
    input.select();
}

async function removeLabel(label) {
    if (!window.confirm(`Izbrišem oznako "${label.name}"? Postavke ostanejo, le oznaka pade z njih.`)) return;
    try {
        await ListAPI.deleteLabel(label.id);
        await reloadLabels();
        await refreshItems(true);
        renderLabelsSheet();
    } catch (err) {
        toast('Ni bilo mogoče izbrisati: ' + err.message);
    }
}

async function reloadLabels() {
    const collection = state.active;
    try {
        const res = await ListAPI.labelsOf(collection);
        state.labelsBy[collection] = res.labels || [];
        render();
    } catch { /* naslednji poll popravi */ }
}

async function addLabel(kind) {
    const input = kind === 'section' ? els.newSection : els.newShop;
    const name = input.value.trim();
    if (!name) return;
    input.value = '';
    try {
        await ListAPI.addLabel(state.active, kind, name);
        await reloadLabels();
        renderLabelsSheet();
    } catch (err) {
        toast('Ni bilo mogoče dodati: ' + err.message);
        input.value = name;
    }
}

// ----- pokrov: dostop (admin) -----
function openAccessSheet() {
    const names = [...state.collections];
    if (state.active && !names.includes(state.active)) names.push(state.active);
    if (!names.length) {
        toast('Najprej ustvari seznam');
        return;
    }
    openSheet(els.accessSheet, () => {
        els.accessCollection.innerHTML = '';
        for (const name of names) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            els.accessCollection.appendChild(opt);
        }
        if (state.active) els.accessCollection.value = state.active;
        loadAccessUsers();
    });
}

async function loadAccessUsers() {
    const collection = els.accessCollection.value;
    els.accessUsers.innerHTML = '<li class="py-4 text-[0.85rem] text-muted">Nalagam…</li>';
    let res;
    try {
        res = await ListAPI.accessList(collection);
    } catch (err) {
        els.accessUsers.innerHTML = '<li class="py-4 text-[0.85rem] text-muted">Uporabnikov ni bilo mogoče naložiti.</li>';
        toast('Napaka: ' + err.message);
        return;
    }
    if (els.accessCollection.value !== collection) return;
    els.accessUsers.innerHTML = '';
    for (const user of res.users) els.accessUsers.appendChild(renderAccessUser(user, collection));
}

function renderAccessUser(user, collection) {
    const li = document.createElement('li');
    li.className = 'flex items-center gap-3 py-2.5';

    const avatar = document.createElement('span');
    avatar.className = 'w-9 h-9 rounded-full bg-line text-muted flex items-center justify-center shrink-0 overflow-hidden text-[0.8rem] font-medium';
    if (user.avatar_url) {
        const img = document.createElement('img');
        img.src = user.avatar_url;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.className = 'w-full h-full object-cover';
        avatar.appendChild(img);
    } else {
        avatar.textContent = initials(user);
    }

    const info = document.createElement('span');
    info.className = 'flex-1 min-w-0';
    const name = document.createElement('span');
    name.className = 'block truncate text-[0.9rem]';
    name.textContent = user.display_name || user.email;
    const email = document.createElement('span');
    email.className = 'block truncate text-[0.75rem] text-muted';
    email.textContent = user.email;
    info.append(name, email);
    li.append(avatar, info);

    if (user.is_admin) {
        const badge = document.createElement('span');
        badge.className = 'text-[0.7rem] uppercase tracking-[0.12em] text-muted shrink-0';
        badge.textContent = 'admin';
        li.appendChild(badge);
        return li;
    }

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = user.granted;
    toggle.className = 'w-5 h-5 accent-accent shrink-0 cursor-pointer';
    toggle.setAttribute('aria-label', `Dostop za ${user.display_name || user.email}`);
    toggle.addEventListener('change', async () => {
        const granted = toggle.checked;
        toggle.disabled = true;
        try {
            if (granted) await ListAPI.accessGrant(collection, user.id);
            else await ListAPI.accessRevoke(collection, user.id);
        } catch (err) {
            toggle.checked = !granted;
            toast('Napaka: ' + err.message);
        } finally {
            toggle.disabled = false;
        }
    });
    li.appendChild(toggle);
    return li;
}

async function deleteCollectionFromSheet() {
    const collection = els.accessCollection.value;
    if (!collection) return;
    if (!window.confirm(`Izbrišem "${collection}" z vsemi postavkami in zgodovino? Tega ni mogoče razveljaviti.`)) return;

    els.accessDelete.disabled = true;
    try {
        await ListAPI.deleteCollection(collection);
    } catch (err) {
        toast('Ni bilo mogoče izbrisati: ' + err.message);
        return;
    } finally {
        els.accessDelete.disabled = false;
    }
    toast(`Izbrisano: ${collection}`);

    state.collections = state.collections.filter((n) => n !== collection);
    delete state.itemsBy[collection];
    delete state.labelsBy[collection];
    delete state.versionBy[collection];
    delete state.historyBy[collection];
    for (const [tid, temp] of state.pendingAdds) {
        if (temp.collection === collection) state.pendingAdds.delete(tid);
    }

    closeAllSheets();
    if (state.active === collection) {
        state.active = null;
        if (state.collections.length) {
            setActive(state.collections[0]);
        } else {
            history.replaceState(null, '', location.pathname + location.search);
            els.addInput.placeholder = 'Dodaj…';
            render();
        }
    } else {
        render();
    }
}

// ----- povezovanje -----
function submitAdd() {
    const value = els.addInput.value;
    if (!value.trim()) return;
    els.addInput.value = '';
    addItem(value);
    els.addInput.focus();
    renderTray();
}

function wire() {
    els.addButton.addEventListener('click', submitAdd);
    els.addInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitAdd(); }
    });
    els.addInput.addEventListener('input', renderTray);
    els.addInput.addEventListener('focus', renderTray);
    els.addInput.addEventListener('blur', () => {
        // Dovolj pozno, da tap po oznaki še pride skozi.
        setTimeout(renderTray, 150);
    });

    els.clearDone.addEventListener('click', clearDone);

    els.pickerOpen.addEventListener('click', openPicker);
    els.menuOpen.addEventListener('click', openLabelsSheet);
    els.accessOpen.addEventListener('click', openAccessSheet);

    els.newListCreate.addEventListener('click', async () => {
        const name = els.newListInput.value.trim();
        if (!name) return;
        els.newListInput.value = '';
        await closeTopSheet();
        createCollection(name);
    });
    els.newListInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); els.newListCreate.click(); }
    });

    els.firstListCreate.addEventListener('click', () => {
        createCollection(els.firstListInput.value);
        els.firstListInput.value = '';
    });
    els.firstListInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); els.firstListCreate.click(); }
    });

    els.itemDelete.addEventListener('click', () => {
        const edit = state.editing;
        if (!edit) return;
        const item = (state.itemsBy[state.active] || []).find((x) => x.id === edit.id);
        state.editing = null;
        closeTopSheet();
        if (item) deleteItem(item);
    });

    els.labelsDefaults.addEventListener('click', async () => {
        els.labelsDefaults.disabled = true;
        try {
            const res = await ListAPI.addDefaults(state.active);
            state.labelsBy[state.active] = res.labels || [];
            render();
            renderLabelsSheet();
        } catch (err) {
            toast('Ni bilo mogoče dodati: ' + err.message);
        } finally {
            els.labelsDefaults.disabled = false;
        }
    });

    for (const btn of document.querySelectorAll('[data-add-label]')) {
        btn.addEventListener('click', () => addLabel(btn.dataset.addLabel));
    }
    els.newSection.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addLabel('section'); }
    });
    els.newShop.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addLabel('shop'); }
    });

    els.accessCollection.addEventListener('change', loadAccessUsers);
    els.accessDelete.addEventListener('click', deleteCollectionFromSheet);

    els.historyToggle.addEventListener('click', () => {
        state.historyOpen = !state.historyOpen;
        renderHistory();
    });

    for (const btn of document.querySelectorAll('.sheet-close')) {
        btn.addEventListener('click', () => closeTopSheet());
    }
    els.backdrop.addEventListener('click', () => closeTopSheet());

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && state.sheets.length) closeTopSheet();
    });

    // Gumb nazaj na telefonu zapre pokrov, namesto da bi zapustil stran.
    window.addEventListener('popstate', () => {
        if (state.sheets.length) closeTopSheet({ fromPop: true });
    });

    window.addEventListener('hashchange', () => {
        const target = decodeURIComponent(location.hash.slice(1));
        if (!target || target === state.active) return;
        setActive(target, { updateHash: false });
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            refreshItems().catch(() => {});
            refreshCollections().catch(() => {});
        }
    });

    document.addEventListener('click', unlockAudio, { once: true });
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ----- zagon -----
async function boot() {
    registerServiceWorker();
    wire();

    let me = null;
    try {
        me = await ListAPI.me();
    } catch { /* spodaj obravnavano kot odjavljen */ }
    if (!me || !me.user) {
        showGate('signed-out');
        return;
    }
    state.user = me.user;
    state.isAdmin = !!me.user.is_admin;

    try {
        const res = await ListAPI.collections();
        state.collections = res.collections || [];
    } catch (err) {
        if (err.status === 401) { showGate('signed-out'); return; }
        if (err.status === 403) { showGate('no-access'); return; }
        state.collections = [];
    }

    const hash = decodeURIComponent(location.hash.slice(1));
    const active = hash || (state.collections.length ? state.collections[0] : null);
    if (active) {
        setActive(active);
    } else {
        render();
        setTimeout(() => els.firstListInput && els.firstListInput.focus(), 0);
    }

    startPolling();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
