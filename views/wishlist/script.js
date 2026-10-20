// views/wishlist: the page. Renders what logic.js decides and talks to
// app/controllers/wishlist-controller.php. Every user-written string reaches
// the DOM through textContent, never innerHTML.

import {
    itemState,
    groupForDisplay,
    neededCount,
    validateDraft,
    domainLabel,
    shortTitle,
    pruneTokens,
    QTY_MAX,
} from './logic.js';

const API = '../../app/controllers/wishlist-controller.php';
const SITE_ROOT = '../../';
const TOKENS_KEY = 'wishlist.claims.v1';
const POLL_MS = 20_000;
const FEED_MS = 260;
const SVG_NS = 'http://www.w3.org/2000/svg';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const $ = (id) => document.getElementById(id);

const state = {
    items: [],
    canEdit: false,
    version: null,
    loaded: false,
    error: false,
    tokens: readTokens(),
    keep: new Set(),   // claimed on this page view: stays where it was
    busy: new Set(),   // item ids with a request in flight
    punch: null,       // the item to punch on the next render
};

// Every write bumps the epoch. A poll that started before a write is thrown
// away when it lands, so a stale list cannot undo what the write just did
// (or prune the token it just stored).
let epoch = 0;

// ------------------------------------------------------------------
//  Remembered claims
// ------------------------------------------------------------------

function readTokens() {
    try {
        const parsed = JSON.parse(localStorage.getItem(TOKENS_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeTokens() {
    try {
        localStorage.setItem(TOKENS_KEY, JSON.stringify(state.tokens));
    } catch {
        // Private mode: the claim still counts; Undo just lasts this visit.
    }
}

// ------------------------------------------------------------------
//  Talking to the controller
// ------------------------------------------------------------------

async function api(url, { method = 'GET', body, form } = {}) {
    const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (form) {
        opts.body = form;
    } else if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    let res;
    try {
        res = await fetch(url, opts);
    } catch {
        throw Object.assign(new Error('offline'), { status: 0 });
    }
    let data = null;
    try {
        data = await res.json();
    } catch {
        // an empty or non-JSON body
    }
    if (!res.ok) {
        throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status, data });
    }
    return data;
}

async function load({ full = false } = {}) {
    const startedAt = epoch;
    const since = !full && state.version ? `?since=${encodeURIComponent(state.version)}` : '';
    try {
        const data = await api(API + since);
        if (startedAt !== epoch) return;
        // An editor is typing on a tag: a re-render would take the text from
        // under the caret. The next poll catches up.
        if (document.activeElement?.closest?.('[data-inline]')) return;
        state.version = data.version;
        if (data.changed === false) return;
        state.items = data.items;
        state.canEdit = !!data.can_edit;
        state.tokens = pruneTokens(state.tokens, state.items);
        writeTokens();
        state.loaded = true;
        state.error = false;
    } catch {
        if (state.loaded) return; // a missed poll is not worth a banner
        state.error = true;
    }
    render();
}

function findItem(id) {
    return state.items.find((item) => item.id === id) || null;
}

function replaceItem(next) {
    if (!next) return;
    const i = state.items.findIndex((item) => item.id === next.id);
    if (i === -1) state.items.push(next);
    else state.items[i] = next;
}

// ------------------------------------------------------------------
//  Rendering
// ------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === false || value === null || value === undefined) continue;
        node.setAttribute(key, value === true ? '' : String(value));
    }
    node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
    return node;
}

function icon(name, cls = 'icon') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
}

function photo(item) {
    if (!item.image) {
        return el('div', { class: 'bay__photo bay__photo--none' }, icon('image', 'icon icon--lg'));
    }
    return el('div', { class: 'bay__photo' }, el('img', {
        src: SITE_ROOT + item.image.url,
        alt: '',
        width: item.image.width,
        height: item.image.height,
        loading: 'lazy',
        decoding: 'async',
    }));
}

function shopLink(url) {
    return el('a', { class: 'shop-link', href: url, target: '_blank', rel: 'noopener noreferrer nofollow' },
        domainLabel(url) || 'Link',
        el('span', { class: 'sr-only' }, ' (opens in a new tab)'),
        icon('arrow'));
}

function qtyLine(st) {
    return st.taken > 0 ? `${st.wanted} wanted · ${st.taken} taken` : `${st.wanted} wanted`;
}

function displayState(st) {
    if (st.mine !== null) return 'mine';
    return st.open ? 'open' : 'taken';
}

/**
 * An editor writes the name and note straight onto the tag. Saved on blur,
 * Enter in the name saves, Escape puts back what was there.
 */
function inlineField(tagName, cls, item, field) {
    const value = item[field] || '';
    const node = el(tagName, {
        class: cls + (value ? '' : ' is-empty'),
        contenteditable: 'plaintext-only',
        spellcheck: 'true',
        role: 'textbox',
        'aria-label': field === 'name' ? 'Name' : `Note for ${item.name}`,
        'aria-multiline': field === 'note' ? 'true' : 'false',
        'data-inline': field,
        'data-id': item.id,
        'data-placeholder': field === 'note' ? 'Add a note' : 'Name',
    }, value);
    return node;
}

/**
 * One gift on its shelf: the product square, the rail, and the tag clipped
 * into it. The taken run uses the same bay, smaller and without the note, so
 * a claimed tag stays punched and flagged on every visit, not just the one
 * that claimed it.
 */
function bay(item, st, compact = false) {
    const shown = displayState(st);
    const busy = state.busy.has(item.id);
    const nameId = `name-${item.id}${compact ? 'c' : ''}`;
    const inline = state.canEdit && !compact;

    const tag = el('article', { class: 'tag', 'aria-labelledby': nameId });
    const name = inline ? inlineField('h3', 'tag__name', item, 'name') : el('h3', { class: 'tag__name' }, item.name);
    name.id = nameId;
    tag.append(name);
    if (st.wanted > 1) tag.append(el('p', { class: 'tag__qty' }, qtyLine(st)));
    if (inline) tag.append(inlineField('p', 'tag__note', item, 'note'));
    else if (item.note && !compact) tag.append(el('p', { class: 'tag__note' }, item.note));

    const links = el('div', { class: 'tag__links' });
    if (item.url && !compact) links.append(shopLink(item.url));
    if (state.canEdit) {
        links.append(el('button', { type: 'button', class: 'link-btn link-btn--quiet', 'data-edit': item.id },
            icon('pencil'), compact ? 'Edit' : 'Details', el('span', { class: 'sr-only' }, ` of ${item.name}`)));
    }

    let action = null;
    if (shown === 'mine') {
        action = el('div', { class: 'mine-line' },
            compact ? null : el('span', {}, st.wanted > 1 ? "You're bringing one" : "You're bringing this"),
            el('button', { type: 'button', class: 'link-btn', 'data-undo': item.id, disabled: busy },
                'Undo', el('span', { class: 'sr-only' }, ` ${item.name}`)));
    } else if (shown === 'open') {
        action = el('button', {
            type: 'button',
            class: 'key',
            'data-claim': item.id,
            'aria-describedby': nameId,
            'aria-busy': busy ? 'true' : false,
            disabled: busy,
        }, "I'll bring this");
    }
    if (links.childElementCount || action) tag.append(el('div', { class: 'tag__foot' }, links, action));

    // The flag hangs from the rail, not the tag: the tag is masked to cut the
    // punch hole, and the mask would clip anything sticking out of it.
    const flag = shown === 'open' ? null : el('span', { class: 'tag__flag' }, shown === 'mine' ? 'Yours' : 'Taken');

    return el('li', { class: `bay${compact ? ' bay--compact' : ''}`, 'data-id': item.id, 'data-state': shown },
        el('div', { class: 'bay__product' }, photo(item)),
        el('div', { class: 'rail' }, tag, flag));
}

// ---- Inline edits

function inlineValue(node) {
    return node.textContent.replace(/ /g, ' ').trim();
}

document.querySelector('main').addEventListener('keydown', (event) => {
    const node = event.target.closest?.('[data-inline]');
    if (!node) return;
    if (event.key === 'Escape') {
        const item = findItem(Number(node.dataset.id));
        node.textContent = item?.[node.dataset.inline] || '';
        node.blur();
    } else if (event.key === 'Enter' && node.dataset.inline === 'name') {
        event.preventDefault();
        node.blur();
    }
});

document.querySelector('main').addEventListener('focusout', async (event) => {
    const node = event.target.closest?.('[data-inline]');
    if (!node) return;
    const id = Number(node.dataset.id);
    const field = node.dataset.inline;
    const item = findItem(id);
    if (!item) return;
    const value = inlineValue(node);
    if (value === (item[field] || '')) {
        node.classList.toggle('is-empty', value === '');
        return;
    }
    const checked = validateDraft({ name: item.name, url: item.url, note: item.note, quantity: item.quantity, [field]: value });
    if (!checked.ok) {
        toast(Object.values(checked.errors)[0]);
        node.textContent = item[field] || '';
        return;
    }
    epoch++;
    try {
        const data = await api(`${API}?id=${id}`, { method: 'PATCH', body: { [field]: checked.value[field] } });
        replaceItem(data.item);
        toast(field === 'name' ? 'Name saved.' : 'Note saved.');
    } catch (err) {
        node.textContent = item[field] || '';
        toast(failureText(err));
    }
    render();
});

// Rows are rebuilt only when something they show has changed, so a poll
// does not reload twenty-four pictures every twenty seconds.
const rendered = new Map();

function renderList(ul, items, compact) {
    const nodes = items.map((item) => {
        const st = itemState(item, state.tokens);
        const key = `${compact ? 'c' : 'b'}${item.id}`;
        const sig = JSON.stringify([item, st, state.canEdit, state.busy.has(item.id)]);
        let cached = rendered.get(key);
        if (!cached || cached.sig !== sig) {
            cached = { sig, node: bay(item, st, compact) };
            rendered.set(key, cached);
        }
        return cached.node;
    });
    ul.replaceChildren(...nodes);
}

function render() {
    document.body.classList.toggle('is-editor', state.canEdit);
    for (const node of document.querySelectorAll('[data-editor]')) node.classList.toggle('hidden', !state.canEdit);
    for (const node of document.querySelectorAll('[data-guest-only]')) node.classList.toggle('hidden', state.canEdit);

    const empty = state.loaded && state.items.length === 0;
    $('loading').classList.toggle('hidden', state.loaded || state.error);
    $('error').classList.toggle('hidden', !state.error || state.loaded);
    $('empty').classList.toggle('hidden', !empty);
    $('signin').classList.toggle('hidden', !state.loaded || state.canEdit);
    const pictureless = state.items.filter((item) => !item.image).length;
    $('refetch').classList.toggle('hidden', !state.canEdit || pictureless === 0);
    $('refetch-count').textContent = pictureless === 1 ? '1 item is' : `${pictureless} items are`;

    const { needed, taken } = groupForDisplay(state.items, state.tokens, state.keep);
    const count = neededCount(state.items);
    const mine = state.items.filter((item) => itemState(item, state.tokens).mine !== null).length;

    let tally = '';
    if (state.loaded && count.total > 0) {
        tally = count.needed === 0 ? `All ${count.total} are taken` : `${count.needed} of ${count.total} still needed`;
        if (mine > 0) tally += `, and you're bringing ${mine}`;
        tally += '.';
    }
    $('tally').textContent = tally;

    $('needed-section').classList.toggle('hidden', !state.loaded || empty);
    $('all-done').classList.toggle('hidden', needed.length > 0);
    renderList($('needed'), needed, false);

    $('taken-section').classList.toggle('hidden', taken.length === 0);
    $('taken-count').textContent = String(taken.length);
    renderList($('taken'), taken, true);

    if (state.punch !== null) {
        const node = document.querySelector(`#needed .bay[data-id="${state.punch}"]`);
        state.punch = null;
        if (node && !reducedMotion.matches) {
            node.classList.add('is-punching');
            setTimeout(() => node.classList.remove('is-punching'), FEED_MS + 40);
        }
    }
}

// ------------------------------------------------------------------
//  Toast
// ------------------------------------------------------------------

let toastTimer = null;

function toast(text, { action, onAction } = {}) {
    $('toast-text').textContent = text;
    const button = $('toast-action');
    button.hidden = !action;
    button.textContent = action || '';
    button.onclick = action ? () => { hideToast(); onAction(); } : null;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 7000 : 4500);
}

function hideToast() {
    $('toast').hidden = true;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function failureText(err) {
    if (err.status === 0) return "You're offline. Try again once you're connected.";
    return "That didn't go through. Try again.";
}

// ------------------------------------------------------------------
//  Claiming
// ------------------------------------------------------------------

async function claim(id) {
    const item = findItem(id);
    if (!item || state.busy.has(id)) return;
    epoch++;
    state.busy.add(id);
    render();
    try {
        const data = await api(`${API}?resource=claim`, { method: 'POST', body: { item_id: id } });
        state.tokens[data.claim.id] = data.claim.token;
        writeTokens();
        replaceItem(data.item);
        state.keep.add(id);
        state.punch = id;
        toast(`“${item.name}” is yours to bring.`, { action: 'Undo', onAction: () => undo(id) });
    } catch (err) {
        if (err.status === 409) {
            toast('Someone took that one a moment ago.');
            load({ full: true });
        } else if (err.status === 404) {
            toast('That item has just come off the list.');
            load({ full: true });
        } else {
            toast(failureText(err));
        }
    } finally {
        state.busy.delete(id);
        render();
    }
}

async function undo(id) {
    const item = findItem(id);
    const claimId = item ? itemState(item, state.tokens).mine : null;
    if (claimId === null || state.busy.has(id)) return;
    epoch++;
    state.busy.add(id);
    render();

    const row = document.querySelector(`#needed .bay[data-id="${id}"]`);
    const animate = row && !reducedMotion.matches;
    if (animate) row.classList.add('is-closing');
    const started = performance.now();

    try {
        const data = await api(`${API}?resource=claim&id=${claimId}`, {
            method: 'DELETE',
            body: { token: state.tokens[claimId] },
        });
        if (animate) await wait(Math.max(0, FEED_MS - (performance.now() - started)));
        delete state.tokens[claimId];
        writeTokens();
        replaceItem(data.item);
    } catch (err) {
        if (err.status === 404) {
            delete state.tokens[claimId];
            writeTokens();
            load({ full: true });
        } else {
            toast(failureText(err));
        }
    } finally {
        state.busy.delete(id);
        render();
    }
}

document.querySelector('main').addEventListener('click', (event) => {
    const target = event.target.closest('[data-claim], [data-undo], [data-edit]');
    if (!target) return;
    if (target.dataset.claim) claim(Number(target.dataset.claim));
    else if (target.dataset.undo) undo(Number(target.dataset.undo));
    else if (target.dataset.edit) openSheet(findItem(Number(target.dataset.edit)));
});

// ------------------------------------------------------------------
//  The editor's sheet
// ------------------------------------------------------------------

const sheet = $('sheet');
const form = $('sheet-form');
const URL_HINT = 'Paste a link and the name and picture fill in.';

// What the sheet is editing. `picture` is what the item will have after
// Save: keep (unchanged), none, upload (an id) or remote (a URL the server
// fetches and copies on save).
let draft = null;
let previewSeq = 0;

function openSheet(item) {
    draft = {
        id: item ? item.id : null,
        quantity: item ? item.quantity : 1,
        picture: item?.image ? { kind: 'keep', src: SITE_ROOT + item.image.url } : { kind: 'none' },
        pictureChanged: false,
        autoNamed: false,
        lastPreviewUrl: item?.url || '',
        claims: item ? [...item.claims] : [],
        name: item ? item.name : '',
    };
    $('sheet-title').textContent = item ? 'Edit item' : 'Add item';
    $('f-url').value = item?.url || '';
    $('f-name').value = item?.name || '';
    $('f-note').value = item?.note || '';
    $('f-url-status').textContent = item ? '' : URL_HINT;
    $('f-photo-status').textContent = '';
    $('f-error').textContent = '';
    $('f-delete').classList.toggle('hidden', !item);
    resetClaimsButton();
    clearErrors();
    renderQty();
    renderPicture();
    renderClaims();
    sheet.showModal();
    (item ? $('f-name') : $('f-url')).focus();
}

function closeSheet() {
    if (sheet.open) sheet.close();
}

sheet.addEventListener('close', () => {
    draft = null;
    previewSeq++;
});

sheet.addEventListener('click', (event) => {
    if (event.target === sheet) closeSheet(); // the backdrop
});

for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', closeSheet);
}

for (const button of document.querySelectorAll('[data-add]')) {
    button.addEventListener('click', () => openSheet(null));
}
$('add-top').addEventListener('click', () => openSheet(null));

function renderQty() {
    $('f-qty').textContent = String(draft.quantity);
    form.querySelector('[data-step="-1"]').disabled = draft.quantity <= 1;
    form.querySelector('[data-step="1"]').disabled = draft.quantity >= QTY_MAX;
}

for (const button of form.querySelectorAll('[data-step]')) {
    button.addEventListener('click', () => {
        draft.quantity = Math.min(QTY_MAX, Math.max(1, draft.quantity + Number(button.dataset.step)));
        renderQty();
    });
}

function renderPicture() {
    const well = $('f-photo');
    const pic = draft.picture;
    if (pic.kind === 'none') {
        well.replaceChildren(icon('image', 'icon icon--lg text-ramp-4'));
    } else {
        well.replaceChildren(el('img', { src: pic.src, alt: '' }));
    }
    $('f-photo-remove').classList.toggle('hidden', pic.kind === 'none');
    $('f-upload-label').textContent = pic.kind === 'none' ? 'Upload photo' : 'Replace photo';
}

function setPicture(picture) {
    draft.picture = picture;
    draft.pictureChanged = true;
    renderPicture();
}

$('f-photo-remove').addEventListener('click', () => {
    setPicture({ kind: 'none' });
    $('f-photo-status').textContent = '';
});

$('f-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !draft) return;
    const status = $('f-photo-status');
    status.textContent = 'Uploading…';
    const body = new FormData();
    body.append('image', file);
    try {
        const data = await api(`${API}?resource=image`, { method: 'POST', form: body });
        if (!draft) return;
        setPicture({ kind: 'upload', id: data.image_id, src: SITE_ROOT + data.image.url });
        status.textContent = '';
    } catch (err) {
        status.textContent = err.status === 422
            ? "That file isn't a photo this page can use. Try a JPEG or PNG."
            : failureText(err);
    }
});

function renderClaims() {
    const n = draft.claims.length;
    $('f-claims').classList.toggle('hidden', n === 0);
    $('f-claims-text').textContent = n === 1 ? 'One person is bringing this.' : `${n} people are bringing this.`;
}

let resetArmed = null;

function resetClaimsButton() {
    clearTimeout(resetArmed);
    resetArmed = null;
    $('f-claims-reset').textContent = 'Reset';
}

// Resetting throws away guests' claims for good, so it takes a second tap.
$('f-claims-reset').addEventListener('click', async () => {
    const button = $('f-claims-reset');
    if (!resetArmed) {
        button.textContent = 'Tap again to reset';
        resetArmed = setTimeout(resetClaimsButton, 4000);
        return;
    }
    resetClaimsButton();
    const id = draft.id;
    epoch++;
    button.disabled = true;
    try {
        let item = null;
        for (const claimId of draft.claims) {
            item = (await api(`${API}?resource=claim&id=${claimId}`, { method: 'DELETE', body: {} })).item;
        }
        replaceItem(item);
        if (draft && draft.id === id) {
            draft.claims = [];
            renderClaims();
        }
        render();
    } catch (err) {
        $('f-error').textContent = failureText(err);
        load({ full: true });
    } finally {
        button.disabled = false;
    }
});

// ---- Auto-fill from a pasted link

let previewTimer = null;

function urlForPreview() {
    const raw = $('f-url').value.trim();
    if (!raw) return null;
    const checked = validateDraft({ name: 'x', url: raw });
    return checked.errors.url ? null : checked.value.url;
}

function schedulePreview(delay) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
        const url = urlForPreview();
        if (url && draft && url !== draft.lastPreviewUrl) autofill(url);
    }, delay);
}

$('f-url').addEventListener('paste', () => schedulePreview(0));
$('f-url').addEventListener('input', () => schedulePreview(700));
$('f-url').addEventListener('change', () => schedulePreview(0));
$('f-name').addEventListener('input', () => {
    if (draft) draft.autoNamed = false;
});

async function autofill(url) {
    const seq = ++previewSeq;
    draft.lastPreviewUrl = url;
    const status = $('f-url-status');
    status.textContent = 'Reading the page…';
    try {
        const data = await api(`${API}?resource=preview`, { method: 'POST', body: { url } });
        if (seq !== previewSeq || !draft) return;
        const filled = [];
        const nameField = $('f-name');
        if (data.title && (!nameField.value.trim() || draft.autoNamed)) {
            nameField.value = shortTitle(data.title);
            draft.autoNamed = true;
            filled.push('name');
        }
        if (data.image_url && (draft.picture.kind === 'none' || draft.picture.kind === 'remote')) {
            setPicture({ kind: 'remote', url: data.image_url, src: data.image_url });
            filled.push('picture');
        }
        status.textContent = {
            'name,picture': 'Filled in the name and picture. Check the name reads well.',
            name: 'Filled in the name. Upload a photo if you have one.',
            picture: 'Found a picture. Give it a name below.',
        }[filled.join(',')] || "Couldn't find a name or picture on that page. Fill them in below.";
    } catch (err) {
        if (seq !== previewSeq || !draft) return;
        status.textContent = err.status === 422
            ? "That address can't be read. Fill in the name yourself."
            : "Couldn't read that page. Fill in the name and upload a photo.";
    }
}

// ---- Save, remove

function clearErrors() {
    for (const node of form.querySelectorAll('[data-error]')) node.textContent = '';
    for (const node of form.querySelectorAll('.field--invalid')) node.classList.remove('field--invalid');
}

function showErrors(errors) {
    let first = null;
    for (const [field, message] of Object.entries(errors)) {
        const slot = form.querySelector(`[data-error="${field}"]`);
        if (!slot) continue;
        slot.textContent = message;
        slot.closest('.field')?.classList.add('field--invalid');
        first ||= slot.closest('.field')?.querySelector('input, textarea, button');
    }
    first?.focus();
}

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!draft) return;
    clearErrors();
    $('f-error').textContent = '';

    const checked = validateDraft({
        name: $('f-name').value,
        url: $('f-url').value,
        note: $('f-note').value,
        quantity: draft.quantity,
    });
    if (!checked.ok) {
        showErrors(checked.errors);
        return;
    }

    const body = { ...checked.value };
    if (draft.pictureChanged) {
        if (draft.picture.kind === 'none') body.image_id = null;
        else if (draft.picture.kind === 'upload') body.image_id = draft.picture.id;
        else if (draft.picture.kind === 'remote') body.image_url = draft.picture.url;
    }

    const save = $('f-save');
    save.disabled = true;
    save.setAttribute('aria-busy', 'true');
    const editing = draft.id;
    epoch++;
    try {
        const data = editing
            ? await api(`${API}?id=${editing}`, { method: 'PATCH', body })
            : await api(API, { method: 'POST', body });
        replaceItem(data.item);
        closeSheet();
        render();
        toast(data.warning || (editing ? 'Saved.' : 'Added to the list.'));
        if (!editing) {
            document.querySelector(`.bay[data-id="${data.item.id}"]`)?.scrollIntoView({
                behavior: reducedMotion.matches ? 'auto' : 'smooth',
                block: 'center',
            });
        }
    } catch (err) {
        $('f-error').textContent = err.status === 401 || err.status === 403
            ? 'Your sign-in has run out. Sign in again, then save.'
            : err.status === 422 ? err.message : failureText(err);
    } finally {
        save.disabled = false;
        save.removeAttribute('aria-busy');
    }
});

$('f-delete').addEventListener('click', async () => {
    if (!draft?.id) return;
    const { id, name } = draft;
    epoch++;
    try {
        await api(`${API}?id=${id}`, { method: 'DELETE' });
        state.items = state.items.filter((item) => item.id !== id);
        closeSheet();
        render();
        toast(`Removed “${name}”.`, { action: 'Undo', onAction: () => restore(id) });
    } catch (err) {
        $('f-error').textContent = failureText(err);
    }
});

async function restore(id) {
    epoch++;
    try {
        await api(`${API}?id=${id}`, { method: 'PATCH', body: { restore: true } });
    } catch (err) {
        toast(failureText(err));
    }
    await load({ full: true });
}

// ------------------------------------------------------------------
//  One-time import of the Amazon registry
// ------------------------------------------------------------------

// The same run serves both buttons: on an empty list it imports; once
// items exist, the controller recognises each one by its source_key and
// only fills in a picture that failed last time.
async function runImport(button, status, { refetch = false } = {}) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    let rows;
    try {
        rows = (await (await fetch('seed.json')).json()).items;
    } catch {
        status.textContent = "Couldn't read the registry file. Try again.";
        button.disabled = false;
        button.removeAttribute('aria-busy');
        return;
    }
    let failed = 0;
    let noPicture = 0;
    let warning = '';
    for (const [i, row] of rows.entries()) {
        status.textContent = `${refetch ? 'Checking' : 'Importing'} ${i + 1} of ${rows.length}…`;
        epoch++;
        try {
            const data = await api(API, { method: 'POST', body: row });
            if (data.warning) {
                noPicture++;
                warning ||= data.warning;
            }
        } catch {
            failed++;
        }
    }
    status.textContent = '';
    button.disabled = false;
    button.removeAttribute('aria-busy');
    await load({ full: true });

    const done = rows.length - failed;
    let text = refetch ? 'Pictures checked.' : `Imported ${done} of ${rows.length} items.`;
    if (failed) text += ` ${failed} didn't go through; run it again for those.`;
    // The first warning says why (a missing image extension, a dead link).
    if (noPicture) text += ` ${noPicture} still ${noPicture === 1 ? 'has' : 'have'} no picture. ${warning}`;
    toast(text);
}

$('import').addEventListener('click', () => runImport($('import'), $('import-status')));
$('refetch-run').addEventListener('click', () => runImport($('refetch-run'), $('refetch-status'), { refetch: true }));

// ------------------------------------------------------------------
//  Boot and polling
// ------------------------------------------------------------------

$('signin-link').href = `../account/?redirect=${encodeURIComponent(location.pathname)}`;
$('retry').addEventListener('click', () => {
    state.error = false;
    render();
    load({ full: true });
});

setInterval(() => {
    if (document.visibilityState === 'visible') load();
}, POLL_MS);

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') load();
});

load({ full: true });
