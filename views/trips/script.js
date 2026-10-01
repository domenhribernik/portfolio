// Trips: wiring only. Decisions live in logic.js (tested), the map in map.js,
// the server in api.js, the queue in outbox.js, the phone's copy in
// storage.js. This file turns state into screens and events into state.
//
// Screens are hash routes (logic.js parseRoute) so components/back-link.js
// can walk them: a new screen is `location.hash = ...`, which deepens the
// back trail; a step that is not a new place to go back to (a station step, a
// map or grid toggle, the next photo) uses history.replaceState instead.
//
// Every create goes through the outbox, online or not: it is the same path,
// so a create made with no signal behaves exactly like one made with signal,
// only later.

import {
    LINE_COLOURS, lineColour, nextLineColour, networkStats, tripInitials,
    parseRoute, routeHash, parseJoinFragment, placeFromNominatim,
    resolvePhotoLocation, resolveTakenAt, groupByDay, toDmy, clockOf, dateSpan,
    mergePending, mergePendingTrips, rehome, splitMarkers, can,
} from './logic.js';
import { call, photoUrl } from './api.js';
import { createMap } from './map.js';
import { createOutbox } from './outbox.js';
import { preparePhoto } from './photo.js';
import * as store from './storage.js';
import { loginUrl } from '../../components/auth-gate.js';
import { formatCoords } from '../nebo/geo.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const JOIN_KEY = 'trips-join';

const $ = (id) => document.getElementById(id);

const el = {
    service: $('service'), who: $('who'), banners: $('banners'), mapHint: $('mapHint'),
    screens: { atlas: $('screenAtlas'), trip: $('screenTrip'), place: $('screenPlace'), join: $('screenJoin') },
    atlasTitle: $('atlasTitle'), atlasCount: $('atlasCount'), tripKey: $('tripKey'), atlasEmpty: $('atlasEmpty'),
    tray: $('tray'), trayList: $('trayList'),
    newTrip: $('newTrip'), newTripName: $('newTripName'), newTripLine: $('newTripLine'), newTripCancel: $('newTripCancel'),
    usage: $('usage'), usageFill: $('usageFill'), usageText: $('usageText'),
    signin: $('signin'), signinLink: $('signinLink'),
    tripBullet: $('tripBullet'), tripTitle: $('tripTitle'), tripMeta: $('tripMeta'),
    tripMore: $('tripMore'), tripMenu: $('tripMenu'), tripLine: $('tripLine'),
    addPlace: $('addPlace'), placeHere: $('placeHere'), placeTap: $('placeTap'),
    placeSearch: $('placeSearch'), placeQuery: $('placeQuery'), placeResults: $('placeResults'),
    placeConfirm: $('placeConfirm'), placeName: $('placeName'), placeWhere: $('placeWhere'), placeCancel: $('placeCancel'),
    stripWindow: $('stripWindow'), stripTrack: $('stripTrack'), stripPrev: $('stripPrev'), stripNext: $('stripNext'),
    placeTitle: $('placeTitle'), placeMeta: $('placeMeta'), placeMore: $('placeMore'), placeMenu: $('placeMenu'),
    album: $('album'), albumNote: $('albumNote'), placeEmpty: $('placeEmpty'), capture: $('capture'),
    takePhoto: $('takePhoto'), addPhotos: $('addPhotos'),
    join: $('join'),
    lightbox: $('lightbox'), lbMedia: $('lbMedia'), lbTitle: $('lbTitle'), lbWhere: $('lbWhere'), lbBy: $('lbBy'),
    lbActions: $('lbActions'), lbPrev: $('lbPrev'), lbNext: $('lbNext'), lbClose: $('lbClose'),
};

const state = {
    viewer: null,
    limits: { max_upload_bytes: 8 * 1024 * 1024, max_edge: 2560 },
    trips: [],          // the atlas as the server last said
    usage: null,
    showcase: null,     // the showcase tree, for signed-out visitors
    tree: null,         // the open trip as the server last said
    ops: [],            // the outbox, as of the last change
    route: { screen: 'atlas' },
    draft: null,        // a place being added
    picking: null,      // 'pin' while choosing where a photo was taken
    online: navigator.onLine,
};

const blobUrls = new Map();   // photo uuid -> object URL of its queued blob

const map = createMap($('map'));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * A data line ("5 stations · 7 photos · 12.08.2026 to 18.08.2026") that
 * wraps only between whole parts, never inside a date range, and never leaves
 * a separator dangling at the end of a line.
 */
const metaHtml = (parts) => `<span class="meta__in">${parts.filter(Boolean)
    .map((p) => `<span class="part">${esc(p)}</span>`).join('')}</span>`;

/** How much of the phone atlas the sheet covers when it peeks (style.css). */
const PEEK = 0.42;
const isPhone = () => window.matchMedia('(max-width: 1023px)').matches;

/** crypto.randomUUID needs a secure context; keep a usable id either way. */
function newId() {
    if (self.crypto?.randomUUID) return self.crypto.randomUUID();
    const b = new Uint8Array(16);
    (self.crypto || { getRandomValues: (a) => a.forEach((_, i) => { a[i] = Math.random() * 256; }) })
        .getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const viewerId = () => state.viewer?.id ?? null;
const myOps = () => state.ops.filter((o) => o.userId === viewerId());

// ---------------------------------------------------------------- banners

function banner(id, text, { kind = 'info', actions = [] } = {}) {
    let node = document.getElementById(`banner-${id}`);
    if (!text) { node?.remove(); return; }
    if (!node) {
        node = document.createElement('div');
        node.id = `banner-${id}`;
        el.banners.appendChild(node);
    }
    node.className = `banner banner--${kind}`;
    node.innerHTML = `<p class="banner__text">${esc(text)}</p>`;
    for (const a of actions) {
        const b = document.createElement(a.href ? 'a' : 'button');
        if (a.href) b.href = a.href; else b.type = 'button';
        b.className = 'btn btn--ghost';
        b.textContent = a.label;
        if (a.onClick) b.addEventListener('click', a.onClick);
        node.appendChild(b);
    }
}

function setLine(key) {
    const c = key ? lineColour(key) : { hex: '#1d1b18', text: '#fbfaf6' };
    document.body.style.setProperty('--line', c.hex);
    document.body.style.setProperty('--line-text', c.text);
}

// ---------------------------------------------------------------- chrome

function renderWho() {
    if (state.viewer) {
        const name = state.viewer.display_name || 'You';
        el.who.innerHTML = `<a class="who__me" href="../account/" title="${esc(name)}"><span class="sr-only">Your account, </span>${esc(tripInitials(name))}</a>`;
    } else {
        el.who.innerHTML = `<a class="btn btn--ghost who__in" href="${esc(loginUrl())}">Sign in</a>`;
    }
}

/** The status line: Good service, or what is waiting, or what needs the person. */
function renderService() {
    if (!state.viewer) { el.service.hidden = true; return; }
    const ops = myOps();
    const problems = ops.filter((o) => o.state !== 'pending').length;
    const waiting = ops.filter((o) => o.state === 'pending');
    const photos = waiting.filter((o) => o.kind === 'photo').length;
    el.service.hidden = false;
    if (problems) {
        el.service.dataset.state = 'problem';
        el.service.textContent = `${plural(problems, 'item needs', 'items need')} you`;
    } else if (waiting.length) {
        el.service.dataset.state = 'waiting';
        const what = photos === waiting.length ? plural(photos, 'photo', 'photos') : plural(waiting.length, 'item', 'items');
        el.service.textContent = state.online ? `Sending ${what}` : `${what} waiting for signal`;
    } else {
        el.service.dataset.state = state.online ? 'good' : 'waiting';
        el.service.textContent = state.online ? 'Good service' : 'No signal';
    }
}

function showScreen(name) {
    for (const [key, node] of Object.entries(el.screens)) node.hidden = key !== name;
    document.body.dataset.screen = name;
    closeMenus();
    // The map's box changes height between screens.
    requestAnimationFrame(() => map.invalidate());
}

function closeMenus() {
    for (const [btn, menu] of [[el.tripMore, el.tripMenu], [el.placeMore, el.placeMenu]]) {
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
    }
}

// ---------------------------------------------------------------- data views

/** The atlas as shown: the server's trips plus trips started offline. */
function atlasTrips() {
    if (!state.viewer) return state.showcase ? [{ ...state.showcase.trip, places: state.showcase.places, photo_count: state.showcase.photos.length }] : [];
    const merged = mergePendingTrips(state.trips, myOps());
    // Queued places and photos count on their trip's row too.
    return merged.map((t) => {
        const extraPlaces = myOps().filter((o) => o.kind === 'place' && o.trip === t.uuid && !t.places.some((p) => p.uuid === o.uuid))
            .map((o) => ({ ...o.body, pending: true }));
        const extraPhotos = myOps().filter((o) => o.kind === 'photo' && o.trip === t.uuid).length;
        return { ...t, places: [...t.places, ...extraPlaces], photo_count: (t.photo_count ?? 0) + extraPhotos };
    });
}

/** The open trip as shown: the server's copy plus anything still queued. */
function view() {
    return state.tree ? mergePending(state.tree, myOps()) : null;
}

function photoSrc(p, size = 'thumb') {
    if (p.pending) return blobUrls.get(p.uuid) ?? '';
    return photoUrl(p.uuid, size);
}

/** Object URLs for queued photos, read once from storage. */
async function ensureBlobUrls() {
    let added = false;
    for (const o of state.ops) {
        if (o.kind !== 'photo' || blobUrls.has(o.uuid)) continue;
        const blob = await store.getBlob(o.uuid);
        if (blob) { blobUrls.set(o.uuid, URL.createObjectURL(blob)); added = true; }
    }
    return added;
}

function dropBlobUrl(uuid) {
    const url = blobUrls.get(uuid);
    if (url) { URL.revokeObjectURL(url); blobUrls.delete(uuid); }
}

// ---------------------------------------------------------------- atlas

function tripMetaLine(t) {
    const places = (t.places ?? []).length;
    return `${plural(places, 'station', 'stations')} · ${plural(t.photo_count ?? 0, 'photo', 'photos')}`;
}

function renderAtlas() {
    showScreen('atlas');
    setLine(null);
    stopPicking();
    const signedIn = !!state.viewer;
    const trips = atlasTrips();

    el.atlasTitle.textContent = signedIn ? 'Your network' : 'A trip, as a line';
    el.signin.hidden = signedIn;
    el.signinLink.href = loginUrl();

    const s = networkStats(trips);
    el.atlasCount.textContent = signedIn && trips.length
        ? `${plural(s.trips, 'trip', 'trips')} · ${plural(s.places, 'place', 'places')} · ${plural(s.photos, 'photo', 'photos')} · ${plural(s.countries, 'country', 'countries')}`
        : '';

    el.tripKey.innerHTML = trips.map((t) => {
        const c = lineColour(t.line);
        const role = t.pending ? 'waiting for signal' : t.role === 'traveller' ? 'you are a traveller' : t.role === 'viewer' ? `${t.owner_name ?? 'Domen'}'s trip` : '';
        return `<li class="key__row${t.pending ? ' key__row--pending' : ''}" style="--c:${c.hex};--t:${c.text}">
            <span class="bullet${t.pending ? ' bullet--pending' : ''}" aria-hidden="true">${esc(tripInitials(t.name))}</span>
            <div>
                <h3 class="key__name"><a class="key__link" href="${routeHash({ screen: 'trip', trip: t.uuid })}">${esc(t.name)}</a></h3>
                <p class="key__meta mono">${metaHtml([tripMetaLine(t), role])}</p>
            </div>
        </li>`;
    }).join('') + (signedIn ? `<li class="key__row key__row--new">
            <span class="bullet bullet--hollow" aria-hidden="true">+</span>
            <div>
                <h3 class="key__name"><button class="key__new" type="button" id="startTrip">Start a new trip</button></h3>
                <p class="key__meta key__meta--prose">A new line on the map</p>
            </div>
        </li>` : '');

    el.atlasEmpty.hidden = !(signedIn && trips.length === 0);
    $('startTrip')?.addEventListener('click', openNewTrip);

    if (signedIn && state.usage) {
        const used = state.usage.bytes;
        const quota = state.usage.quota_bytes || 1;
        el.usage.hidden = false;
        el.usageFill.style.width = `${Math.min(100, (used / quota) * 100).toFixed(1)}%`;
        el.usageText.textContent = `${formatMb(used)} of ${formatMb(quota)} photo storage used`;
    } else {
        el.usage.hidden = true;
    }

    renderTray();
    map.setNetwork(trips, {
        onTrip: (uuid) => go({ screen: 'trip', trip: uuid }),
        // On a phone the sheet peeks over the lower map; frame the network above it.
        padBottom: isPhone() ? Math.round(window.innerHeight * PEEK) : 0,
    });
}

function formatMb(bytes) {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;
}

// Things the queue could not send, with what the person can do about each.
function renderTray() {
    const problems = myOps().filter((o) => o.state !== 'pending');
    el.tray.hidden = problems.length === 0;
    if (!problems.length) return;
    const places = atlasTrips().flatMap((t) => t.places.filter((p) => !p.pending).map((p) => ({ ...p, trip: t.uuid, tripName: t.name })));
    el.trayList.innerHTML = problems.map((o) => {
        const what = o.kind === 'photo' ? 'A photo' : o.kind === 'place' ? `The place "${o.body.name}"` : `The trip "${o.body.name}"`;
        const why = {
            stalled: 'kept failing to send.',
            failed: o.lastError ? `was refused: ${o.lastError}` : 'was refused by the server.',
            blocked: 'is waiting for room: your photo storage is full.',
            orphaned: o.kind === 'photo' ? 'lost its place: it was deleted, or you left the trip.' : 'lost its trip: it was deleted, or you left it.',
        }[o.state] ?? '';
        const move = o.kind === 'photo' && o.state === 'orphaned' && places.length
            ? `<label class="tray__move"><span class="sr-only">Move to</span><select data-move="${o.uuid}">
                <option value="">Move to a place</option>
                ${places.map((p) => `<option value="${p.uuid}|${p.trip}">${esc(p.name)} (${esc(p.tripName)})</option>`).join('')}
              </select></label>` : '';
        return `<li class="tray__item">
            ${o.kind === 'photo' ? `<img class="tray__thumb" alt="" src="${esc(blobUrls.get(o.uuid) ?? '')}">` : ''}
            <p class="tray__text">${esc(what)} ${esc(why)}</p>
            <div class="tray__actions">
                ${o.state !== 'orphaned' ? `<button class="btn btn--ghost" type="button" data-retry="${o.uuid}">Try again</button>` : ''}
                ${move}
                ${o.kind === 'photo' ? `<button class="btn btn--ghost" type="button" data-save="${o.uuid}">Save to phone</button>` : ''}
                <button class="btn btn--danger" type="button" data-discard="${o.uuid}">Discard</button>
            </div>
        </li>`;
    }).join('');
}

el.trayList.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.retry) outbox.retry(t.dataset.retry);
    if (t.dataset.save) savePhotoToDevice(t.dataset.save);
    if (t.dataset.discard) {
        if (!confirmInline(t, 'Discard for good?')) return;
        await outbox.discard(t.dataset.discard);
        dropBlobUrl(t.dataset.discard);
    }
});

el.trayList.addEventListener('change', async (e) => {
    const sel = e.target.closest('select[data-move]');
    if (!sel || !sel.value) return;
    const [placeUuid, tripUuid] = sel.value.split('|');
    const moved = rehome(state.ops, [sel.dataset.move], placeUuid, tripUuid)
        .filter((o) => o.uuid === sel.dataset.move)
        .map((o) => ({ ...o, body: { ...o.body, place: placeUuid } }));
    await outbox.replaceAll(moved);
});

/** A two-step confirm on the button itself: first press arms, second acts. */
function confirmInline(button, armedText) {
    if (button.dataset.armed === '1') return true;
    button.dataset.armed = '1';
    const was = button.textContent;
    button.textContent = armedText;
    setTimeout(() => {
        if (button.isConnected) { button.dataset.armed = ''; button.textContent = was; }
    }, 4000);
    return false;
}

async function savePhotoToDevice(uuid) {
    const blob = await store.getBlob(uuid);
    if (!blob) return;
    const file = new File([blob], `trip-photo-${uuid.slice(0, 8)}.jpg`, { type: 'image/jpeg' });
    if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file] }); return; } catch { /* cancelled: fall back to a download */ }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------------------------------------------------------------- new trip

function openNewTrip() {
    const chosen = nextLineColour(atlasTrips());
    el.newTripLine.innerHTML = '<legend class="field__label">Line colour</legend>' + LINE_COLOURS.map((c) => `
        <label class="swatch" style="--c:${c.hex};--t:${c.text}">
            <input type="radio" name="line" value="${c.key}" ${c.key === chosen ? 'checked' : ''}>
            <span class="swatch__tick"></span>
            <span class="sr-only">${c.name}</span>
        </label>`).join('');
    el.newTrip.hidden = false;
    el.newTripName.value = '';
    el.newTripName.focus();
    el.newTrip.scrollIntoView({ block: 'nearest' });
}

el.newTripCancel.addEventListener('click', () => { el.newTrip.hidden = true; });

el.newTrip.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = el.newTripName.value.trim();
    if (!name || !state.viewer) return;
    const line = el.newTrip.querySelector('input[name="line"]:checked')?.value ?? nextLineColour(atlasTrips());
    const uuid = newId();
    el.newTrip.hidden = true;
    await outbox.enqueue({ kind: 'trip', uuid, userId: viewerId(), body: { uuid, name, line } });
    state.tree = null;
    go({ screen: 'trip', trip: uuid });
});

// ---------------------------------------------------------------- trip

/**
 * The open trip: from the network when there is one, else this phone's last
 * copy, else (for a trip started offline) built from its queued create.
 */
async function loadTree(uuid, { fresh = false } = {}) {
    if (!fresh && state.tree?.trip.uuid === uuid) return state.tree;
    if (!state.viewer && state.showcase?.trip.uuid === uuid) return (state.tree = state.showcase);

    const r = await call({ resource: 'trip', uuid });
    if (r.ok) {
        state.tree = r.data;
        if (state.viewer) store.putSnapshot(r.data, viewerId()).catch(() => {});
        return state.tree;
    }
    if (r.offline && state.viewer) {
        const snap = await store.getSnapshot(uuid, viewerId());
        if (snap) return (state.tree = snap);
    }
    const queued = myOps().find((o) => o.kind === 'trip' && o.uuid === uuid);
    if (queued) {
        return (state.tree = {
            trip: { ...queued.body, role: 'owner', owner_name: state.viewer.display_name, cover_photo_uuid: null, version: 0, pending: true },
            places: [], photos: [], members: [],
        });
    }
    return null;
}

function placePhotos(v, placeUuid) {
    return v.photos.filter((p) => p.place === placeUuid);
}

async function renderTrip() {
    const tree = await loadTree(state.route.trip);
    if (!tree) return notFoundScreen();
    const v = view();
    const { trip, places } = v;
    showScreen('trip');
    setLine(trip.line);
    resetAddPlace();

    el.tripBullet.textContent = tripInitials(trip.name);
    el.tripTitle.textContent = trip.name;
    const span = dateSpan(v.photos);
    // Termini, the way a line is named on the platform: first stop to last.
    const termini = places.length > 1 ? `${places[0].name} to ${places[places.length - 1].name}` : '';
    el.tripMeta.innerHTML = (termini ? `<span class="band__termini">${esc(termini)}</span>` : '') + metaHtml([
        plural(places.length, 'station', 'stations'),
        plural(v.photos.length, 'photo', 'photos'),
        span,
        trip.role === 'traveller' || trip.role === 'viewer' ? `${trip.owner_name ?? 'Someone'}'s trip` : '',
        trip.pending ? 'waiting for signal' : '',
    ]);

    const role = trip.role;
    const canAdd = can(role, 'add');
    el.tripMore.hidden = role === 'viewer';
    el.tripLine.innerHTML = places.map((p, i) => {
        const photos = placePhotos(v, p.uuid);
        const pd = dateSpan(photos);
        const reorder = can(role, 'manage') && state.reordering && !p.pending
            ? `<span class="line__move">
                <button class="btn btn--ghost" type="button" data-move="${p.uuid}" data-dir="-1" ${i === 0 ? 'disabled' : ''}><span class="sr-only">Move ${esc(p.name)} earlier</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg></button>
                <button class="btn btn--ghost" type="button" data-move="${p.uuid}" data-dir="1" ${i === places.length - 1 ? 'disabled' : ''}><span class="sr-only">Move ${esc(p.name)} later</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
              </span>` : '';
        const end = i === 0 || i === places.length - 1 ? ' line__stop--terminus' : '';
        return `<li class="line__stop${p.pending ? ' line__stop--pending' : end}">
            <span class="line__dot" aria-hidden="true"></span>
            <div class="line__text">
                <h3 class="line__name"><a class="line__link" href="${routeHash({ screen: 'place', trip: trip.uuid, place: p.uuid, view: 'map' })}">${esc(p.name)}</a></h3>
                <p class="line__meta mono">${metaHtml([`${i + 1}`, plural(photos.length, 'photo', 'photos'), pd, p.pending ? 'waiting for signal' : ''])}</p>
            </div>
            ${reorder}
        </li>`;
    }).join('') + (canAdd ? `<li class="line__stop line__stop--next">
            <span class="line__dot" aria-hidden="true"></span>
            <div class="line__text">
                <h3 class="line__name"><button class="line__add" type="button" id="openAddPlace">Add the next place</button></h3>
                <p class="line__meta line__meta--prose">${places.length ? 'Extend the line' : 'Your first station'}</p>
            </div>
        </li>` : '');
    $('openAddPlace')?.addEventListener('click', openAddPlace);
    if (canAdd && places.length === 0) openAddPlace();

    map.setTrip(trip, places, { onPlace: (uuid) => go({ screen: 'place', trip: trip.uuid, place: uuid, view: 'map' }) });
}

el.tripLine.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-move]');
    if (!b) return;
    const v = view();
    const order = v.places.filter((p) => !p.pending).map((p) => p.uuid);
    const i = order.indexOf(b.dataset.move);
    const j = i + Number(b.dataset.dir);
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    const r = await call({ resource: 'trip', action: 'reorder', uuid: v.trip.uuid }, { method: 'POST', json: { places: order } });
    if (!r.ok) return problem(r, 'Could not move the stop.');
    state.tree = r.data;
    renderTrip();
});

function notFoundScreen() {
    banner('missing', 'That trip is not here. It may have been deleted, or you are signed in as someone else.', { kind: 'problem' });
    go({ screen: 'atlas' }, { replace: true });
}

function problem(r, fallback) {
    banner('action', r.offline ? 'That needs a connection. Try again when you have signal.' : (r.data?.error ?? fallback), { kind: 'problem' });
}

// ---------------------------------------------------------------- trip menu

el.tripMore.addEventListener('click', () => {
    const open = el.tripMenu.hidden;
    closeMenus();
    if (open) {
        renderTripMenu();
        el.tripMenu.hidden = false;
        el.tripMore.setAttribute('aria-expanded', 'true');
    }
});

function renderTripMenu() {
    const v = view();
    const { trip } = v;
    const role = trip.role;
    const items = [];
    if (can(role, 'manage') && !trip.pending) {
        items.push(`<button class="menu__item" type="button" data-act="rename">Rename trip</button>`);
        items.push(`<button class="menu__item" type="button" data-act="colour">Change line colour</button>`);
        items.push(`<button class="menu__item" type="button" data-act="invite">Invite travellers</button>`);
        items.push(`<button class="menu__item" type="button" data-act="reorder">${state.reordering ? 'Done reordering' : 'Reorder stops'}</button>`);
        if (state.viewer?.is_admin) {
            items.push(`<button class="menu__item" type="button" data-act="showcase">${trip.showcase ? 'Stop showing to visitors' : 'Show to signed-out visitors'}</button>`);
        }
    }
    if ((v.members ?? []).length) items.push(`<button class="menu__item" type="button" data-act="members">Travellers (${v.members.length})</button>`);
    if (can(role, 'leave')) items.push(`<button class="menu__item menu__item--danger" type="button" data-act="leave">Leave this trip</button>`);
    if (can(role, 'manage') && !trip.pending) {
        items.push(`<button class="menu__item menu__item--danger" type="button" data-act="delete">Delete trip</button>`);
    }
    el.tripMenu.innerHTML = items.join('') || '<p class="menu__note">Nothing to change while this trip is waiting for signal.</p>';
}

el.tripMenu.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const v = view();
    const trip = v.trip;
    const act = b.dataset.act;

    if (act === 'rename') {
        el.tripMenu.innerHTML = `<form class="menu__form" id="renameTrip">
            <label class="field"><span class="field__label">Trip name</span>
            <input class="field__input" name="name" maxlength="120" required value="${esc(trip.name)}"></label>
            <div class="actions"><button class="btn btn--line" type="submit">Save</button></div></form>`;
        const f = $('renameTrip');
        f.name.focus();
        f.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const r = await call({ resource: 'trip', action: 'update', uuid: trip.uuid }, { method: 'POST', json: { name: f.name.value } });
            if (!r.ok) return problem(r, 'Could not rename the trip.');
            state.tree.trip = { ...state.tree.trip, ...r.data.trip };
            patchAtlasTrip(r.data.trip);
            renderTrip();
        });
    }

    if (act === 'colour') {
        el.tripMenu.innerHTML = `<fieldset class="swatches">${LINE_COLOURS.map((c) => `
            <label class="swatch" style="--c:${c.hex};--t:${c.text}">
                <input type="radio" name="relines" value="${c.key}" ${c.key === trip.line ? 'checked' : ''}>
                <span class="swatch__tick"></span><span class="sr-only">${c.name}</span>
            </label>`).join('')}<legend class="field__label">Line colour</legend></fieldset>`;
        el.tripMenu.querySelectorAll('input[name="relines"]').forEach((i) => i.addEventListener('change', async () => {
            const r = await call({ resource: 'trip', action: 'update', uuid: trip.uuid }, { method: 'POST', json: { line: i.value } });
            if (!r.ok) return problem(r, 'Could not change the colour.');
            state.tree.trip = { ...state.tree.trip, ...r.data.trip };
            patchAtlasTrip(r.data.trip);
            renderTrip();
        }));
    }

    if (act === 'invite') renderInvite(trip, null);

    if (act === 'reorder') {
        state.reordering = !state.reordering;
        renderTrip();
    }

    if (act === 'showcase') {
        const r = await call({ resource: 'trip', action: 'showcase', uuid: trip.uuid }, { method: 'POST', json: { on: !trip.showcase } });
        if (!r.ok) return problem(r, 'Could not change the showcase.');
        state.tree.trip = { ...state.tree.trip, ...r.data.trip };
        banner('action', r.data.trip.showcase ? 'Signed-out visitors now see this trip, including every traveller\'s photos (without their names).' : 'This trip is private again.');
        renderTrip();
    }

    if (act === 'members') renderMembers(v);

    if (act === 'leave') {
        if (!confirmInline(b, 'Leave? You lose access to it')) return;
        const r = await call({ resource: 'member', action: 'leave', uuid: trip.uuid }, { method: 'POST', json: {} });
        if (!r.ok) return problem(r, 'Could not leave the trip.');
        state.trips = state.trips.filter((t) => t.uuid !== trip.uuid);
        state.tree = null;
        go({ screen: 'atlas' });
    }

    if (act === 'delete') {
        if (!confirmInline(b, `Delete it and all ${plural(v.photos.length, 'photo', 'photos')}? Press again`)) return;
        const r = await call({ resource: 'trip', action: 'delete', uuid: trip.uuid }, { method: 'POST', json: {} });
        if (!r.ok) return problem(r, 'Could not delete the trip.');
        state.trips = state.trips.filter((t) => t.uuid !== trip.uuid);
        state.tree = null;
        go({ screen: 'atlas' });
    }
});

function patchAtlasTrip(trip) {
    const t = state.trips.find((x) => x.uuid === trip.uuid);
    if (t) Object.assign(t, trip);
}

/** The invite panel: the link (only ever shown right after it was made), copy, share, reset, turn off. */
function renderInvite(trip, token) {
    const link = token ? `${location.origin}${location.pathname}#join=${token}` : null;
    const on = token || state.tree.trip.invite_on;
    el.tripMenu.innerHTML = `<div class="menu__form">
        <p class="menu__note">Anyone signed in who opens the link joins as a traveller: they can add places and photos and see everyone's. Each link is shown once; make a new one to share it again.</p>
        ${link ? `<div class="menu__token">
            <input class="field__input" readonly value="${esc(link)}" id="inviteLink" aria-label="Invite link">
            <button class="btn btn--line" type="button" data-inv="copy">${navigator.share ? 'Share' : 'Copy'}</button>
        </div>` : ''}
        <div class="actions">
            <button class="btn btn--ghost" type="button" data-inv="reset">${on ? 'Make a new link' : 'Make a link'}</button>
            ${on ? '<button class="btn btn--danger" type="button" data-inv="disable">Turn the link off</button>' : ''}
        </div>
        ${on && !link ? '<p class="menu__note mono">A link is active. Making a new one stops the old one working.</p>' : ''}
    </div>`;
    el.tripMenu.querySelectorAll('[data-inv]').forEach((b) => b.addEventListener('click', async () => {
        if (b.dataset.inv === 'copy') {
            if (navigator.share) {
                try { await navigator.share({ title: trip.name, text: `Join "${trip.name}" on Trips`, url: link }); } catch { /* cancelled */ }
            } else {
                try { await navigator.clipboard.writeText(link); b.textContent = 'Copied'; } catch { $('inviteLink').select(); }
            }
            return;
        }
        const r = await call({ resource: 'invite', action: b.dataset.inv, uuid: trip.uuid }, { method: 'POST', json: {} });
        if (!r.ok) return problem(r, 'Could not change the link.');
        state.tree.trip.invite_on = b.dataset.inv === 'reset';
        renderInvite(trip, r.data.token ?? null);
    }));
}

function renderMembers(v) {
    const owner = v.trip.role === 'owner';
    el.tripMenu.innerHTML = `<ul class="members">${v.members.map((m) => `<li class="members__row">
        <span class="bullet bullet--small" aria-hidden="true">${esc(tripInitials(m.name))}</span>
        <span class="members__name">${esc(m.name)}${m.id === viewerId() ? ' (you)' : ''}</span>
        <span class="members__role mono">${m.role === 'owner' ? 'Owner' : 'Traveller'}</span>
        ${owner && m.role !== 'owner' ? `<button class="btn btn--danger" type="button" data-remove="${m.id}">Remove</button>` : ''}
    </li>`).join('')}</ul>
    ${owner ? '<p class="menu__note">Removing someone also turns the invite link off, so they cannot simply rejoin. Their photos stay.</p>' : ''}`;
    el.tripMenu.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirmInline(b, 'Remove?')) return;
        const r = await call({ resource: 'member', action: 'remove', uuid: v.trip.uuid }, { method: 'POST', json: { user_id: Number(b.dataset.remove), reset_link: true } });
        if (!r.ok) return problem(r, 'Could not remove them.');
        state.tree = r.data;
        renderMembers(view());
    }));
}

// ---------------------------------------------------------------- adding a place

function openAddPlace() {
    el.addPlace.hidden = false;
    $('openAddPlace')?.closest('.line__stop')?.setAttribute('hidden', '');
    el.addPlace.scrollIntoView({ block: 'nearest' });
}

function resetAddPlace() {
    el.addPlace.hidden = true;
    el.placeResults.hidden = true;
    el.placeResults.innerHTML = '';
    el.placeConfirm.hidden = true;
    el.placeQuery.value = '';
    state.draft = null;
    stopPicking();
}

function stopPicking() {
    map.onTap(null);
    el.mapHint.hidden = true;
    state.picking = null;
}

async function reverseGeocode(lat, lon) {
    if (!state.online) return null;
    try {
        const res = await fetch(`${NOMINATIM}/reverse?format=jsonv2&zoom=14&addressdetails=1&lat=${lat}&lon=${lon}`,
            { headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        return placeFromNominatim(await res.json());
    } catch {
        return null;
    }
}

/** The confirm form for a point, named by a reverse lookup when there is signal. */
async function draftAt(lat, lon, named = null) {
    stopPicking();
    el.placeResults.hidden = true;
    el.placeConfirm.hidden = false;
    el.placeName.value = '';
    el.placeWhere.textContent = formatCoords(lat, lon);
    const found = named ?? await reverseGeocode(lat, lon);
    state.draft = { name: found?.name ?? '', lat, lon, country_code: found?.country_code ?? null, detail: found?.detail ?? null };
    el.placeName.value = state.draft.name;
    el.placeName.placeholder = found ? '' : 'Name this stop';
    el.placeWhere.textContent = [state.draft.detail, formatCoords(lat, lon)].filter(Boolean).join(' · ');
    el.placeName.focus();
    el.placeName.select();
}

/** One fresh position, or null; never waits more than `timeout`. */
function currentFix({ timeout = 12000, maximumAge = 60000 } = {}) {
    return new Promise((resolve) => {
        if (!('geolocation' in navigator)) return resolve(null);
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, timestamp: pos.timestamp }),
            (err) => resolve({ error: err.code }),
            { enableHighAccuracy: true, timeout, maximumAge });
    });
}

el.placeHere.addEventListener('click', async () => {
    el.placeHere.disabled = true;
    el.placeHere.textContent = 'Finding you';
    const fix = await currentFix({ timeout: 20000 });
    el.placeHere.disabled = false;
    el.placeHere.textContent = "I'm here";
    if (!fix || fix.error !== undefined) {
        banner('geo', fix?.error === 1
            ? 'Location is blocked for this site. Tap the map or search instead.'
            : 'Could not get a position fix. Tap the map or search instead.', { kind: 'problem' });
        return;
    }
    banner('geo', null);
    map.flyTo(fix.lat, fix.lon, 14);
    draftAt(fix.lat, fix.lon);
});

el.placeTap.addEventListener('click', () => {
    el.mapHint.textContent = 'Tap where the place is';
    el.mapHint.hidden = false;
    map.onTap(({ lat, lon }) => draftAt(lat, lon));
    $('mapwrap').scrollIntoView({ block: 'nearest' });
});

el.placeSearch.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = el.placeQuery.value.trim();
    if (!q) return;
    el.placeResults.hidden = false;
    if (!state.online) {
        el.placeResults.innerHTML = '<li class="results__note mono">Search needs signal. Tap the map, or use I\'m here.</li>';
        return;
    }
    el.placeResults.innerHTML = '<li class="results__note mono">Searching</li>';
    let hits = [];
    try {
        const res = await fetch(`${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(q)}`,
            { headers: { Accept: 'application/json' } });
        if (res.ok) hits = (await res.json()).map(placeFromNominatim).filter(Boolean);
    } catch {
        el.placeResults.innerHTML = '<li class="results__note mono">Search failed. Tap the map instead.</li>';
        return;
    }
    if (hits.length === 0) {
        el.placeResults.innerHTML = '<li class="results__note mono">Nothing found. Try a nearby town.</li>';
        return;
    }
    el.placeResults.innerHTML = hits.map((h, i) => `<li><button class="results__hit" type="button" data-i="${i}">
        <span class="results__name">${esc(h.name)}</span>
        <span class="results__detail mono">${esc(h.detail ?? '')}</span></button></li>`).join('');
    el.placeResults.querySelectorAll('.results__hit').forEach((b) => b.addEventListener('click', () => {
        const h = hits[Number(b.dataset.i)];
        map.flyTo(h.lat, h.lon, 13);
        draftAt(h.lat, h.lon, h);
    }));
});

el.placeCancel.addEventListener('click', () => {
    el.placeConfirm.hidden = true;
    state.draft = null;
});

el.placeConfirm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = state.draft;
    const name = el.placeName.value.trim();
    if (!d || !name || !state.tree) return;
    const tripUuid = state.tree.trip.uuid;
    const uuid = newId();
    const body = { uuid, trip: tripUuid, name, lat: d.lat, lon: d.lon, country_code: d.country_code };
    await outbox.enqueue({ kind: 'place', uuid, userId: viewerId(), trip: tripUuid, body });
    go({ screen: 'place', trip: tripUuid, place: uuid, view: 'map' });
});

// ---------------------------------------------------------------- place

async function renderPlace() {
    const tree = await loadTree(state.route.trip);
    if (!tree) return notFoundScreen();
    const v = view();
    const index = v.places.findIndex((p) => p.uuid === state.route.place);
    if (index < 0) return go({ screen: 'trip', trip: v.trip.uuid }, { replace: true });
    const place = v.places[index];
    const role = v.trip.role;
    showScreen('place');
    setLine(v.trip.line);
    document.body.dataset.view = state.route.view;

    el.placeTitle.textContent = place.name;
    const photos = placePhotos(v, place.uuid);
    const { exact, approximate } = splitMarkers(photos);
    el.placeMeta.innerHTML = metaHtml([
        `Station ${index + 1} of ${v.places.length}`,
        plural(photos.length, 'photo', 'photos'),
        dateSpan(photos),
        formatCoords(place.lat, place.lon),
        place.pending ? 'waiting for signal' : '',
    ]);

    const mine = place.by_id != null && place.by_id === viewerId();
    el.placeMore.hidden = !can(role, 'editPlace', { mine }) || !!place.pending;
    el.capture.hidden = !can(role, 'add');

    renderStrip(v.places, index);
    for (const b of document.querySelectorAll('.seg__btn')) {
        b.setAttribute('aria-pressed', String(b.dataset.view === state.route.view));
    }
    el.placeEmpty.hidden = photos.length > 0;
    el.albumNote.hidden = approximate.length === 0 || photos.length === 0;
    el.albumNote.textContent = approximate.length
        ? `${plural(approximate.length, 'photo has', 'photos have')} no location of ${approximate.length === 1 ? 'its' : 'their'} own, so ${approximate.length === 1 ? 'it is' : 'they are'} marked At the stop and counted on the station.`
        : '';
    renderAlbum(photos);

    map.setTrip(v.trip, v.places, {
        selected: place.uuid,
        fit: false,
        badge: approximate.length,
        onPlace: (uuid) => go({ screen: 'place', trip: v.trip.uuid, place: uuid, view: state.route.view }, { replace: true }),
    });
    map.setPhotos(exact, {
        src: (p) => photoSrc(p),
        line: v.trip.line,
        onPhoto: (uuid) => openPhoto(uuid),
    });
    if (exact.length) map.frame([place, ...exact], { maxZoom: 16 });
    else map.flyTo(place.lat, place.lon, 14);

    if (state.route.photo) showPhoto(state.route.photo);
    else hideLightbox();
}

const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' });

function renderAlbum(photos) {
    const role = view().trip.role;
    el.album.innerHTML = groupByDay(photos).map((g) => `<section class="day">
        <h3 class="day__head mono">
            <span>${g.day ? esc(toDmy(g.day)) : 'No date'}</span>
            ${g.day ? `<span>${esc(WEEKDAY.format(new Date(`${g.day}T12:00:00Z`)))}</span>` : ''}
            <span class="day__count">${plural(g.photos.length, 'photo', 'photos')}</span>
        </h3>
        <ul class="grid">${g.photos.map((p) => {
            const st = p.pending ? (p.state === 'pending' ? (state.online ? 'Sending' : 'Waiting') : 'Not sent') : '';
            const time = clockOf(p.taken_at);
            const alt = [`Photo${time ? ` at ${time}` : ''}`, p.by && role !== 'viewer' ? `by ${p.by}` : '', p.caption].filter(Boolean).join(', ');
            return `<li><button class="ph${p.pending ? ' ph--pending' : ''}${p.pending && p.state !== 'pending' ? ' ph--problem' : ''}" type="button" data-photo="${p.uuid}">
                <img class="ph__img" src="${esc(photoSrc(p))}" alt="${esc(alt)}" loading="lazy" decoding="async">
                ${time ? `<span class="ph__time mono">${esc(time)}</span>` : ''}
                ${st ? `<span class="ph__state mono">${st}</span>` : ''}
                ${p.loc_source === 'place' ? '<span class="ph__approx">At the stop</span>' : ''}
            </button></li>`;
        }).join('')}</ul>
    </section>`).join('');
}

el.album.addEventListener('click', (e) => {
    const b = e.target.closest('[data-photo]');
    if (b) openPhoto(b.dataset.photo);
});

// The station strip: every stop of the trip on one horizontal line, the
// current one held under a fixed you-are-here marker. Moving station is a
// snap with one short overshoot, never a glide (style.css --snap).
function renderStrip(places, index) {
    el.stripTrack.innerHTML = places.map((p, i) => `<li class="strip__stop${i === index ? ' strip__stop--here' : ''}${p.pending ? ' strip__stop--pending' : ''}">
        <a class="strip__link" href="${routeHash({ screen: 'place', trip: state.route.trip, place: p.uuid, view: state.route.view })}"
           data-step="${i - index}" ${i === index ? 'aria-current="location"' : ''}>
            <span class="strip__dot" aria-hidden="true"></span>
            <span class="strip__name">${esc(p.name)}</span>
        </a></li>`).join('');
    el.stripPrev.disabled = index === 0;
    el.stripNext.disabled = index === places.length - 1;
    centreStrip(index);
}

function centreStrip(index) {
    const stop = el.stripTrack.children[index];
    if (!stop) return;
    const offset = el.stripWindow.clientWidth / 2 - (stop.offsetLeft + stop.offsetWidth / 2);
    el.stripTrack.style.transform = `translateX(${Math.round(offset)}px)`;
}

function stepStation(delta) {
    const places = view()?.places ?? [];
    const i = places.findIndex((p) => p.uuid === state.route.place) + delta;
    if (i < 0 || i >= places.length) return;
    go({ screen: 'place', trip: state.route.trip, place: places[i].uuid, view: state.route.view }, { replace: true });
}

el.stripPrev.addEventListener('click', () => stepStation(-1));
el.stripNext.addEventListener('click', () => stepStation(1));
// A station picked on the strip is a step along the line, not a new screen.
el.stripTrack.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-step]');
    if (!a) return;
    e.preventDefault();
    stepStation(Number(a.dataset.step));
});

// A horizontal swipe on the strip steps one station, whatever its length.
let swipeX = null;
el.stripWindow.addEventListener('pointerdown', (e) => { swipeX = e.clientX; });
el.stripWindow.addEventListener('pointerup', (e) => {
    if (swipeX === null) return;
    const dx = e.clientX - swipeX;
    swipeX = null;
    if (Math.abs(dx) > 40) stepStation(dx < 0 ? 1 : -1);
});
el.stripWindow.addEventListener('pointercancel', () => { swipeX = null; });

window.addEventListener('resize', () => {
    if (state.route.screen !== 'place') return;
    centreStrip((view()?.places ?? []).findIndex((p) => p.uuid === state.route.place));
});

for (const b of document.querySelectorAll('.seg__btn')) {
    b.addEventListener('click', () => {
        if (state.route.view === b.dataset.view) return;
        go({ ...state.route, view: b.dataset.view, photo: undefined }, { replace: true });
    });
}

// ---------------------------------------------------------------- place menu

el.placeMore.addEventListener('click', () => {
    const open = el.placeMenu.hidden;
    closeMenus();
    if (!open) return;
    const v = view();
    const role = v.trip.role;
    const items = [`<button class="menu__item" type="button" data-pact="rename">Rename this stop</button>`];
    if (can(role, 'deletePlace')) items.push(`<button class="menu__item menu__item--danger" type="button" data-pact="delete">Delete this stop and its photos</button>`);
    el.placeMenu.innerHTML = items.join('');
    el.placeMenu.hidden = false;
    el.placeMore.setAttribute('aria-expanded', 'true');
});

el.placeMenu.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-pact]');
    if (!b) return;
    const v = view();
    const place = v.places.find((p) => p.uuid === state.route.place);
    if (b.dataset.pact === 'rename') {
        el.placeMenu.innerHTML = `<form class="menu__form" id="renamePlace">
            <label class="field"><span class="field__label">Stop name</span>
            <input class="field__input" name="name" maxlength="120" required value="${esc(place.name)}"></label>
            <div class="actions"><button class="btn btn--line" type="submit">Save</button></div></form>`;
        const f = $('renamePlace');
        f.name.focus();
        f.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const r = await call({ resource: 'place', action: 'update', uuid: place.uuid }, { method: 'POST', json: { name: f.name.value } });
            if (!r.ok) return problem(r, 'Could not rename the stop.');
            Object.assign(state.tree.places.find((p) => p.uuid === place.uuid), r.data.place);
            renderPlace();
        });
    }
    if (b.dataset.pact === 'delete') {
        const n = placePhotos(v, place.uuid).length;
        if (!confirmInline(b, `Delete ${place.name} and ${plural(n, 'photo', 'photos')}? Press again`)) return;
        const r = await call({ resource: 'place', action: 'delete', uuid: place.uuid }, { method: 'POST', json: {} });
        if (!r.ok) return problem(r, 'Could not delete the stop.');
        state.tree.places = state.tree.places.filter((p) => p.uuid !== place.uuid);
        state.tree.photos = state.tree.photos.filter((p) => p.place !== place.uuid);
        go({ screen: 'trip', trip: v.trip.uuid }, { replace: true });
    }
});

// ---------------------------------------------------------------- taking and adding photos

el.takePhoto.addEventListener('change', () => addFiles(el.takePhoto, { capturedInApp: true }));
el.addPhotos.addEventListener('change', () => addFiles(el.addPhotos, { capturedInApp: false }));

// Ask for where the phone is the moment the camera opens, so a fix is ready
// by the time the photo comes back.
let pendingFix = null;
el.takePhoto.closest('label').addEventListener('click', () => { pendingFix = currentFix(); });

async function addFiles(input, { capturedInApp }) {
    const files = [...input.files];
    input.value = '';
    if (!files.length || !state.tree) return;
    const v = view();
    const place = v.places.find((p) => p.uuid === state.route.place);
    if (!place) return;
    const tripUuid = v.trip.uuid;

    // The blob may be the only copy of this photo until it is sent; ask the
    // browser not to clear it under storage pressure.
    navigator.storage?.persist?.().catch(() => {});
    if (store.memory) {
        banner('memory', 'This browser is not letting Trips keep anything on the phone, so photos only survive while this tab stays open. Keep it open until they are sent.', { kind: 'problem' });
    }

    const fix = await (pendingFix ?? currentFix({ timeout: 6000 }));
    pendingFix = null;
    const tz = -new Date().getTimezoneOffset();
    let failed = 0;
    for (const [i, file] of files.entries()) {
        el.albumNote.hidden = false;
        el.albumNote.textContent = `Preparing ${files.length > 1 ? `${i + 1} of ${files.length}` : 'the photo'}`;
        try {
            const prepared = await preparePhoto(file, { maxBytes: state.limits.max_upload_bytes });
            const now = Date.now();
            const loc = resolvePhotoLocation({
                exif: prepared.exif, fix: fix && fix.error === undefined ? fix : null, place,
                fileLastModified: file.lastModified, now, capturedInApp,
            });
            const time = resolveTakenAt({ exif: prepared.exif, fileLastModified: capturedInApp ? now : file.lastModified, tzOffsetMin: tz });
            const uuid = newId();
            const body = {
                uuid, place: place.uuid, lat: +loc.lat.toFixed(6), lon: +loc.lon.toFixed(6), loc_source: loc.source,
                taken_at: time.takenAt ?? '', taken_offset_min: time.offsetMin ?? '',
            };
            blobUrls.set(uuid, URL.createObjectURL(prepared.blob));
            await outbox.enqueue({ kind: 'photo', uuid, userId: viewerId(), trip: tripUuid, place: place.uuid, body }, prepared.blob);
        } catch (err) {
            failed++;
            banner('photo', err.message || 'Could not read that photo.', { kind: 'problem' });
        }
    }
    if (!failed) banner('photo', null);
    renderPlace();
}

// ---------------------------------------------------------------- one photo

let lbPhotos = [];

function openPhoto(uuid) {
    const r = { ...state.route, photo: uuid };
    location.hash = routeHash(r);
}

function showPhoto(uuid) {
    const v = view();
    const place = v.places.find((p) => p.uuid === state.route.place);
    lbPhotos = groupByDay(placePhotos(v, place.uuid)).flatMap((g) => g.photos);
    const i = lbPhotos.findIndex((p) => p.uuid === uuid);
    if (i < 0) return hideLightbox();
    const p = lbPhotos[i];
    const role = v.trip.role;
    const mine = p.by_id !== null && p.by_id === viewerId();

    el.lightbox.hidden = false;
    document.body.classList.add('is-lightbox');
    el.lbMedia.innerHTML = `<img class="lightbox__img" src="${esc(photoSrc(p, 'display'))}" alt="${esc(p.caption || `Photo ${i + 1} of ${lbPhotos.length} at ${place.name}`)}">`;
    el.lbTitle.textContent = [p.taken_at ? `${toDmy(p.taken_at)} · ${clockOf(p.taken_at)}` : 'No date', `${i + 1} / ${lbPhotos.length}`].join(' · ');
    el.lbWhere.textContent = {
        exif: 'Pinned where the camera says it was taken.',
        device: 'Pinned where the phone was when it was taken.',
        manual: 'Pinned by hand.',
        place: `No location of its own: it sits at ${place.name}.`,
    }[p.loc_source] ?? '';
    el.lbBy.textContent = [p.caption, p.by && role !== 'viewer' ? `Added by ${mine ? 'you' : p.by}` : '', p.pending ? (p.state === 'pending' ? 'Waiting to be sent' : 'Not sent: see the atlas') : ''].filter(Boolean).join(' · ');
    el.lbPrev.disabled = i === 0;
    el.lbNext.disabled = i === lbPhotos.length - 1;

    const acts = [];
    if (!p.pending && can(role, 'editPhoto', { mine })) acts.push('<button class="btn btn--ghost" type="button" data-lb="pin">Pin it here</button>');
    if (!p.pending && can(role, 'editPhoto', { mine })) acts.push('<button class="btn btn--ghost" type="button" data-lb="caption">Caption</button>');
    if (!p.pending && can(role, 'manage') && v.trip.cover_photo_uuid !== p.uuid) acts.push('<button class="btn btn--ghost" type="button" data-lb="cover">Make it the cover</button>');
    if (p.pending) acts.push('<button class="btn btn--ghost" type="button" data-lb="save">Save to phone</button>');
    if (!p.pending && can(role, 'deletePhoto', { mine })) acts.push('<button class="btn btn--danger" type="button" data-lb="delete">Delete</button>');
    if (p.pending && p.state !== 'pending') acts.push('<button class="btn btn--danger" type="button" data-lb="discard">Discard</button>');
    el.lbActions.innerHTML = acts.join('');
    el.lbActions.dataset.uuid = p.uuid;
    el.lbClose.focus({ preventScroll: true });
}

function hideLightbox() {
    if (el.lightbox.hidden) return;
    el.lightbox.hidden = true;
    document.body.classList.remove('is-lightbox');
    el.lbMedia.innerHTML = '';
}

function stepPhoto(delta) {
    const i = lbPhotos.findIndex((p) => p.uuid === state.route.photo) + delta;
    if (i < 0 || i >= lbPhotos.length) return;
    go({ ...state.route, photo: lbPhotos[i].uuid }, { replace: true });
}

el.lbPrev.addEventListener('click', () => stepPhoto(-1));
el.lbNext.addEventListener('click', () => stepPhoto(1));
el.lbClose.addEventListener('click', closePhoto);

function closePhoto() {
    // Back is the natural way out of a photo that was opened as a screen.
    if (history.state && history.state.__backLinkDepth > 0) history.back();
    else go({ ...state.route, photo: undefined }, { replace: true });
}

document.addEventListener('keydown', (e) => {
    if (el.lightbox.hidden) return;
    if (e.key === 'Escape') closePhoto();
    if (e.key === 'ArrowLeft') stepPhoto(-1);
    if (e.key === 'ArrowRight') stepPhoto(1);
});

let lbSwipe = null;
el.lightbox.addEventListener('pointerdown', (e) => { lbSwipe = e.clientX; });
el.lightbox.addEventListener('pointerup', (e) => {
    if (lbSwipe === null) return;
    const dx = e.clientX - lbSwipe;
    lbSwipe = null;
    if (Math.abs(dx) > 50) stepPhoto(dx < 0 ? 1 : -1);
});

el.lbActions.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-lb]');
    if (!b) return;
    const uuid = el.lbActions.dataset.uuid;
    const act = b.dataset.lb;
    if (act === 'save') return savePhotoToDevice(uuid);
    if (act === 'discard') {
        await outbox.discard(uuid);
        dropBlobUrl(uuid);
        return closePhoto();
    }
    if (act === 'cover') {
        const r = await call({ resource: 'trip', action: 'cover', uuid: state.tree.trip.uuid }, { method: 'POST', json: { photo: uuid } });
        if (!r.ok) return problem(r, 'Could not set the cover.');
        state.tree.trip = { ...state.tree.trip, ...r.data.trip };
        b.remove();
        return;
    }
    if (act === 'caption') {
        const p = state.tree.photos.find((x) => x.uuid === uuid);
        el.lbActions.innerHTML = `<form class="lightbox__form" id="captionForm">
            <label class="field"><span class="field__label">Caption</span>
            <input class="field__input" name="caption" maxlength="500" value="${esc(p?.caption ?? '')}"></label>
            <button class="btn btn--line" type="submit">Save</button></form>`;
        const f = $('captionForm');
        f.caption.focus();
        f.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const r = await call({ resource: 'photo', action: 'update', uuid }, { method: 'POST', json: { caption: f.caption.value } });
            if (!r.ok) return problem(r, 'Could not save the caption.');
            Object.assign(state.tree.photos.find((x) => x.uuid === uuid), r.data.photo);
            showPhoto(uuid);
        });
        return;
    }
    if (act === 'pin') {
        hideLightbox();
        state.picking = uuid;
        el.mapHint.textContent = 'Tap where this photo was taken';
        el.mapHint.hidden = false;
        $('mapwrap').scrollIntoView({ block: 'nearest' });
        map.onTap(async ({ lat, lon }) => {
            stopPicking();
            const r = await call({ resource: 'photo', action: 'update', uuid }, { method: 'POST', json: { lat: +lat.toFixed(6), lon: +lon.toFixed(6) } });
            if (!r.ok) return problem(r, 'Could not move the pin.');
            Object.assign(state.tree.photos.find((x) => x.uuid === uuid), r.data.photo);
            go({ ...state.route, photo: undefined }, { replace: true });
        });
        return;
    }
    if (act === 'delete') {
        if (!confirmInline(b, 'Delete for good? Press again')) return;
        const r = await call({ resource: 'photo', action: 'delete', uuid }, { method: 'POST', json: {} });
        if (!r.ok) return problem(r, 'Could not delete the photo.');
        state.tree.photos = state.tree.photos.filter((x) => x.uuid !== uuid);
        if (state.tree.trip.cover_photo_uuid === uuid) state.tree.trip.cover_photo_uuid = null;
        closePhoto();
    }
});

// ---------------------------------------------------------------- joining a trip

async function renderJoin(token) {
    showScreen('join');
    setLine(null);
    el.join.innerHTML = '<p class="mono">Reading the invite</p>';
    const r = await call({ resource: 'invite', t: token });
    if (!r.ok) {
        sessionStorage.removeItem(JOIN_KEY);
        el.join.innerHTML = `<div class="empty"><p class="empty__lead">${r.offline ? 'This invite needs signal to open.' : 'This invite link no longer works.'}</p>
            <p>${r.offline ? 'Open it again when you are online.' : 'The owner may have made a new link or turned it off. Ask them for a fresh one.'}</p>
            <a class="btn btn--ghost" href="#/">Go to your trips</a></div>`;
        return;
    }
    const inv = r.data.invite;
    const c = lineColour(inv.line);
    setLine(inv.line);
    map.setNetwork([]);
    el.join.innerHTML = `<div class="joincard" style="--c:${c.hex};--t:${c.text}">
        <div class="band"><span class="bullet" aria-hidden="true">${esc(tripInitials(inv.name))}</span>
            <div class="band__text"><h3 class="band__title">${esc(inv.name)}</h3>
            <p class="band__meta mono">${esc(inv.owner_name ?? 'Someone')}'s trip · ${plural(inv.place_count, 'station', 'stations')} · ${plural(inv.photo_count, 'photo', 'photos')}</p></div></div>
        <p class="joincard__text">${esc(inv.owner_name ?? 'The owner')} invited you to travel along. You will see every place and photo on this trip, and can add your own. Everyone on it sees your name next to what you add.</p>
        <p class="joincard__text joincard__fine">If the owner ever shows this trip to signed-out visitors, your photos are shown too, without your name.</p>
        ${state.viewer
            ? '<button class="btn btn--line" type="button" id="joinBtn">Join this trip</button>'
            : `<a class="btn btn--ink" href="${esc(loginUrl())}">Sign in to join</a>`}
    </div>`;
    $('joinBtn')?.addEventListener('click', async () => {
        const j = await call({ resource: 'join' }, { method: 'POST', json: { token } });
        if (!j.ok) return problem(j, 'Could not join the trip.');
        sessionStorage.removeItem(JOIN_KEY);
        await loadAtlas();
        state.tree = null;
        go({ screen: 'trip', trip: j.data.trip.uuid });
    });
}

// ---------------------------------------------------------------- routing

/**
 * Move to a screen. A real move sets location.hash so the back arrow counts
 * it; `replace` swaps the current entry instead (toggles, station steps,
 * the next photo), spreading history.state so back-link.js keeps its depth.
 */
function go(route, { replace = false } = {}) {
    const hash = routeHash(route);
    if (replace) {
        history.replaceState({ ...history.state }, '', hash);
        state.route = parseRoute(hash);
        render();
    } else if (location.hash !== hash) {
        location.hash = hash;
    } else {
        render();
    }
}

window.addEventListener('hashchange', () => {
    if (captureJoin()) return render();
    state.route = parseRoute(location.hash);
    render();
});

/** A #join= link: keep the token across sign-in, take it out of the address bar. */
function captureJoin() {
    const token = parseJoinFragment(location.hash);
    if (!token) return false;
    sessionStorage.setItem(JOIN_KEY, token);
    history.replaceState({ ...history.state }, '', '#/');
    state.route = { screen: 'atlas' };
    return true;
}

let renderQueued = false;
function render() {
    renderService();
    if (state.route.screen !== 'place') hideLightbox();
    const join = sessionStorage.getItem(JOIN_KEY);
    if (join && state.route.screen === 'atlas') return renderJoin(join);
    if (state.route.screen === 'trip') return renderTrip();
    if (state.route.screen === 'place') return renderPlace();
    return renderAtlas();
}

/** Re-render once per frame however many queue events arrive. */
function rerender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
        renderQueued = false;
        render();
    });
}

// ---------------------------------------------------------------- the queue

const outbox = createOutbox({
    viewerId,
    async onChange(ev) {
        state.ops = await store.ops();
        if (ev.kind === 'done' && ev.data) applyCreated(ev.op, ev.data);
        if (ev.kind === 'gone' && ev.op) dropBlobUrl(ev.op.uuid);
        if (ev.kind === 'auth') {
            banner('auth', 'Your session ended. Sign in again to send what is waiting.', { kind: 'problem', actions: [{ label: 'Sign in', href: loginUrl() }] });
        }
        if (ev.kind === 'failed' && ev.op) {
            const op = state.ops.find((o) => o.uuid === ev.op.uuid);
            if (op && ev.error) await store.putOp({ ...op, lastError: ev.error });
            state.ops = await store.ops();
        }
        await ensureBlobUrls();
        rerender();
    },
});

/** Fold a confirmed create into what the screens show. */
function applyCreated(op, data) {
    if (op.kind === 'trip' && data.trip) {
        if (!state.trips.some((t) => t.uuid === data.trip.uuid)) state.trips.unshift({ ...data.trip, places: [], photo_count: 0 });
        if (state.tree?.trip.uuid === data.trip.uuid) state.tree.trip = { ...state.tree.trip, ...data.trip, pending: false };
    }
    if (op.kind === 'place' && data.place) {
        if (state.tree?.trip.uuid === op.trip && !state.tree.places.some((p) => p.uuid === data.place.uuid)) {
            state.tree.places.push(data.place);
        }
        const t = state.trips.find((x) => x.uuid === op.trip);
        if (t && !t.places.some((p) => p.uuid === data.place.uuid)) t.places.push(data.place);
    }
    if (op.kind === 'photo' && data.photo) {
        if (state.tree?.trip.uuid === op.trip && !state.tree.photos.some((p) => p.uuid === data.photo.uuid)) {
            state.tree.photos.push(data.photo);
        }
        const t = state.trips.find((x) => x.uuid === op.trip);
        if (t) t.photo_count = (t.photo_count ?? 0) + 1;
        // Keep showing the local copy until the server's thumb is loaded.
        const local = blobUrls.get(op.uuid);
        if (local) setTimeout(() => dropBlobUrl(op.uuid), 30000);
    }
}

window.addEventListener('online', () => { state.online = true; renderService(); outbox.kick(); });
window.addEventListener('offline', () => { state.online = false; renderService(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') outbox.kick(); });

// ---------------------------------------------------------------- boot

async function loadAtlas() {
    const r = await call({ resource: 'trips' });
    if (r.ok) {
        state.trips = r.data.trips;
        state.usage = r.data.usage;
        store.putList(viewerId(), r.data).catch(() => {});
    } else if (r.offline) {
        const saved = await store.getList(viewerId());
        if (saved) { state.trips = saved.trips; state.usage = saved.usage; }
    }
    return r;
}

async function boot() {
    await store.open();
    state.ops = await store.ops();
    await ensureBlobUrls();

    const s = await call({ resource: 'session' });
    const lastViewer = await store.getMeta('viewer').catch(() => null);
    if (s.ok) {
        state.viewer = s.data.viewer;
        state.limits = s.data.limits;
        if (lastViewer && lastViewer.id !== state.viewer?.id) {
            // Someone else, or nobody: forget what the last account could see,
            // its cached photos included. Its unsent queue stays for its return.
            await store.forgetViews();
            await caches?.delete('trips-photos').catch(() => {});
        }
        store.setMeta('viewer', state.viewer).catch(() => {});
    } else if (s.offline) {
        // No signal: carry on as whoever was signed in last time.
        state.viewer = lastViewer ?? null;
        state.online = false;
    }

    renderWho();
    if (state.viewer) {
        await loadAtlas();
        outbox.kick();
    } else {
        const sc = await call({ resource: 'showcase' });
        if (sc.ok) state.showcase = sc.data;
    }
    captureJoin();
    state.route = parseRoute(location.hash);
    if (store.memory && state.viewer) {
        banner('memory', 'This browser is not letting Trips keep anything on the phone, so nothing opens without signal here.', { kind: 'info' });
    }
    render();
}

boot();
