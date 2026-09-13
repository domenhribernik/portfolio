// DOM wiring for the share page. Every decision lives in logic.js and qr.js,
// both DOM free and unit-tested; this file only reads the address, fetches the
// catalog and moves the results into the page.
//
// Everything derived from the URL is written with textContent, never innerHTML.
// The target path is attacker-controlled in principle (it is whatever follows
// the host), so it is normalised in logic.js and then only ever concatenated
// onto the site origin.
//
// The page is a rack of plates and one dialog. Picking a plate opens the dialog
// AND pushes the address that plate already links to, so the back button and
// the link agree; shareAddressFor in logic.js is the single source of both.

import {
    requestedTarget,
    normalizeSharePath,
    targetUrl,
    shareAddressFor,
    resolveCard,
    projectEntries,
    subtleGradient,
    readableAccent,
    qrSvgPath,
} from './logic.js';
import { encodeQr } from './qr.js';

const QUIET = 4; // modules of light margin the standard asks for around a code

// Captured once. XAMPP serves the repo from /portfolio/, so the page's own path
// is read rather than assumed, and read before any pushState can move it.
const PAGE = { hostname: location.hostname, pathname: location.pathname };
const BASE_TITLE = document.title;

const el = (id) => document.getElementById(id);

const nodes = {
    plate: el('plate'),
    icon: el('plate-icon'),
    kicker: el('plate-kicker'),
    title: el('plate-title'),
    deck: el('plate-deck'),
    figure: el('qr-figure'),
    svg: el('qr-svg'),
    path: el('qr-path'),
    url: el('qr-url'),
    open: el('action-open'),
    copy: el('action-copy'),
    share: el('action-share'),
    save: el('action-save'),
    status: el('action-status'),
    host: el('masthead-host'),
    self: el('lede-self'),
    grid: el('rack-grid'),
    note: el('rack-note'),
    count: el('rack-count'),
};

const OPEN_LABEL = nodes.open.textContent.trim();

let catalog = { origin: 'https://domenhribernik.com', pages: {} };
let current = null;

//? -------------------------------------------------------------------- draw

function drawQr(text, label) {
    const qr = encodeQr(text);
    const span = qr.size + QUIET * 2;
    nodes.svg.setAttribute('viewBox', `0 0 ${span} ${span}`);
    nodes.svg.querySelector('rect').setAttribute('width', span);
    nodes.svg.querySelector('rect').setAttribute('height', span);
    nodes.svg.setAttribute('aria-label', label);
    nodes.path.setAttribute('d', qrSvgPath(qr.modules, qr.size));
}

function paintPlate(card) {
    current = card;

    nodes.plate.style.setProperty('--acc', readableAccent(card.gradient));
    nodes.plate.style.setProperty('--band', subtleGradient(card.gradient));

    nodes.icon.className = `plate__icon ${card.icon}`;
    nodes.kicker.textContent = card.registered ? 'Scan to open' : 'Unlisted page';
    nodes.title.textContent = card.title;
    nodes.deck.textContent = card.description;

    // The address without its scheme: shorter to read, and the scheme is never
    // the interesting part when you are checking a link before you follow it.
    nodes.url.textContent = card.url.replace(/^https?:\/\//, '');
    nodes.open.href = card.url;
    nodes.open.textContent = OPEN_LABEL;

    nodes.figure.hidden = false;
    nodes.copy.hidden = false;
    nodes.save.hidden = false;
    nodes.share.hidden = !navigator.share;

    drawQr(card.url, `QR code for ${card.title} at ${card.url}`);
}

// Not an address on this site. Say so rather than drawing a code that leads
// somewhere the visitor did not ask for; the rack behind is still there to
// pick from.
function paintRefusal() {
    current = null;

    nodes.plate.style.setProperty('--acc', 'var(--danger)');
    nodes.plate.style.setProperty('--band', 'linear-gradient(90deg, #f2dedc 0%, #efe9dd 100%)');

    nodes.icon.className = 'plate__icon fas fa-circle-question';
    nodes.kicker.textContent = 'Not a page here';
    nodes.title.textContent = 'No such address';
    nodes.deck.textContent =
        'That is not an address on this site, so there is nothing to point a code at. '
        + 'Close this and pick a project instead.';

    nodes.open.href = targetUrl(catalog.origin, '');
    nodes.open.textContent = 'Go to the site';
    nodes.figure.hidden = true;
    nodes.copy.hidden = true;
    nodes.save.hidden = true;
    nodes.share.hidden = true;
}

//? -------------------------------------------------------------------- rack

function tileFor(entry) {
    const item = document.createElement('li');
    item.className = 'tile';
    item.style.setProperty('--acc', readableAccent(entry.gradient));
    item.style.setProperty('--band', subtleGradient(entry.gradient));

    const band = document.createElement('span');
    band.className = 'tile__band';
    band.setAttribute('aria-hidden', 'true');

    // A real link, so it opens in a new tab, copies, and still works with no
    // JS. The click handler only upgrades it to the dialog.
    const link = document.createElement('a');
    link.className = 'tile__link';
    link.href = shareAddressFor({ ...PAGE, path: entry.path });
    link.dataset.path = entry.path;
    link.setAttribute('aria-label', `Show the code for ${entry.title}`);

    const icon = document.createElement('i');
    icon.className = `tile__icon ${entry.icon}`;
    icon.setAttribute('aria-hidden', 'true');

    const name = document.createElement('span');
    name.className = 'tile__name';
    name.textContent = entry.title;

    link.append(icon, name);
    item.append(band, link);
    return item;
}

function renderRack(failed) {
    const entries = projectEntries(catalog);

    if (!entries.length) {
        nodes.note.textContent = failed
            ? 'The catalog did not load. You can still put share. in front of any address.'
            : 'No projects in the catalog yet.';
        nodes.note.classList.toggle('rack__note--error', Boolean(failed));
        nodes.note.hidden = false;
        return;
    }

    nodes.grid.replaceChildren(...entries.map(tileFor));
    nodes.count.textContent = `/ ${entries.length}`;
    nodes.note.hidden = true;
}

//? ------------------------------------------------------------------ plate

// Set when the page closes the dialog itself in response to a history event, so
// the close handler does not answer it by walking history again. Cleared by the
// handler rather than straight after close(), because the close event is queued
// as a task: by the time it fires, a flag reset on the next line is long gone.
let closingSilently = false;

// The rack, as distinct from both a page path and a refused one.
const RACK = Symbol('rack');

function openPlate(path, { push }) {
    const card = path === null ? null : resolveCard(catalog, path);
    if (card) paintPlate(card); else paintRefusal();

    document.title = card ? `${card.title} | Share` : `No such address | Share`;

    if (push) {
        history.pushState({ sharePath: path }, '', shareAddressFor({ ...PAGE, path }));
    }
    if (!nodes.plate.open) nodes.plate.showModal();
}

function closePlate() {
    if (nodes.plate.open) {
        closingSilently = true;
        nodes.plate.close();
    }
    document.title = BASE_TITLE;
    current = null;
}

// What the address is asking for: RACK when it names nothing, a page path
// ('' being the homepage), or null when it names something that is not a page.
function targetFromLocation() {
    const raw = requestedTarget(location);
    if (raw === null) return RACK;
    return normalizeSharePath(raw, catalog.pages);
}

function syncToLocation() {
    const target = targetFromLocation();
    if (target === RACK) closePlate();
    else openPlate(target, { push: false });
}

//? ----------------------------------------------------------------- actions

let statusTimer = 0;

function say(message, warn = false) {
    nodes.status.textContent = message;
    nodes.status.classList.toggle('actions__status--warn', warn);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { nodes.status.textContent = ''; }, 2500);
}

async function copyLink() {
    if (!current) return;
    try {
        await navigator.clipboard.writeText(current.url);
        say('Link copied');
    } catch {
        // Clipboard access is refused outside a secure context and in some
        // embedded browsers; the address is on screen either way.
        say('Copy blocked, the link is above', true);
    }
}

async function shareLink() {
    if (!current) return;
    try {
        await navigator.share({ title: current.title, url: current.url });
    } catch (error) {
        if (error && error.name !== 'AbortError') say('Sharing unavailable', true);
    }
}

// Redraw the code straight onto a canvas rather than rasterising the SVG: an
// SVG drawn through an image is tainted in some browsers and the canvas then
// refuses to export.
function saveQr() {
    if (!current) return;
    const qr = encodeQr(current.url);
    const span = qr.size + QUIET * 2;
    const scale = Math.max(4, Math.ceil(1024 / span));

    const canvas = document.createElement('canvas');
    canvas.width = span * scale;
    canvas.height = span * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fffdf8';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#1c1a17';
    for (let row = 0; row < qr.size; row++) {
        for (let col = 0; col < qr.size; col++) {
            if (!qr.modules[row * qr.size + col]) continue;
            ctx.fillRect((col + QUIET) * scale, (row + QUIET) * scale, scale, scale);
        }
    }

    canvas.toBlob((blob) => {
        if (!blob) {
            say('Could not save', true);
            return;
        }
        const href = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = `${(current.path || 'home').replace(/\//g, '-')}-qr.png`;
        link.click();
        URL.revokeObjectURL(href);
        say('QR saved');
    }, 'image/png');
}

//? ------------------------------------------------------------------- boot

function wire() {
    // One listener for the whole rack: twenty-six plates, one handler, and it
    // keeps working when the grid is rebuilt.
    nodes.grid.addEventListener('click', (event) => {
        const link = event.target.closest('.tile__link');
        if (!link) return;
        // Let a modified click do what the visitor asked of a normal link.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
            || event.button !== 0) return;

        event.preventDefault();
        openPlate(link.dataset.path, { push: true });
    });

    // Escape and the close button both end in a close event. Walk the history
    // back if we put an entry there, so the address follows the dialog.
    nodes.plate.addEventListener('close', () => {
        if (closingSilently) {
            closingSilently = false;
            return;
        }
        document.title = BASE_TITLE;
        current = null;
        // Opened from the rack: an entry was pushed, so step back over it. Opened
        // cold from a shared link: nothing to step back to, so rewrite the address
        // in place and leave the visitor in the rack instead of on another site.
        if (history.state && 'sharePath' in history.state) history.back();
        else history.replaceState(null, '', shareAddressFor({ ...PAGE, path: null }));
    });

    // A click that lands on the dialog itself landed on the backdrop.
    nodes.plate.addEventListener('click', (event) => {
        if (event.target === nodes.plate) nodes.plate.close();
    });

    nodes.self.addEventListener('click', (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
            || event.button !== 0) return;
        event.preventDefault();
        openPlate('', { push: true });
    });

    addEventListener('popstate', syncToLocation);

    nodes.copy.addEventListener('click', copyLink);
    nodes.share.addEventListener('click', shareLink);
    nodes.save.addEventListener('click', saveQr);
}

async function boot() {
    let failed = false;
    try {
        const response = await fetch('catalog.json', { cache: 'no-cache' });
        if (response.ok) catalog = await response.json();
        else failed = true;
    } catch {
        // Offline, or the catalog has not been generated. A named target still
        // draws: its address is built from the path, and that is the part that
        // matters. Only the rack needs the catalog.
        failed = true;
    }

    nodes.host.href = targetUrl(catalog.origin, '');
    nodes.host.textContent = catalog.origin.replace(/^https?:\/\//, '');

    renderRack(failed);
    wire();
    syncToLocation();
}

boot();
