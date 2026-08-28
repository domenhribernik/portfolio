// DOM wiring for the share page. Every decision lives in logic.js and qr.js,
// both DOM free and unit-tested; this file only reads the address, fetches the
// catalog and moves the results into the page.
//
// Everything derived from the URL is written with textContent, never innerHTML.
// The target path is attacker-controlled in principle (it is whatever follows
// the host), so it is normalised in logic.js and then only ever concatenated
// onto the site origin.

import {
    targetPathFrom,
    normalizeSharePath,
    targetUrl,
    shareOriginFor,
    resolveCard,
    indexEntries,
    subtleGradient,
    readableAccent,
    qrSvgPath,
} from './logic.js';
import { encodeQr } from './qr.js';

const QUIET = 4; // modules of light margin the standard asks for around a code

// Which of the two routes we are on. On share.<site> the path is the target;
// anywhere else this directory is just a page and the target is a ?p= query.
const isShareHost = /^share\./i.test(location.hostname);

const el = (id) => document.getElementById(id);

const nodes = {
    card: el('card'),
    icon: el('card-icon'),
    kicker: el('card-kicker'),
    title: el('card-title'),
    deck: el('card-deck'),
    svg: el('qr-svg'),
    path: el('qr-path'),
    url: el('qr-url'),
    open: el('action-open'),
    copy: el('action-copy'),
    share: el('action-share'),
    save: el('action-save'),
    status: el('action-status'),
    host: el('masthead-host'),
    index: el('index'),
    indexList: el('index-list'),
    indexCount: el('index-count'),
    footAddr: el('foot-addr'),
};

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

function renderCard(card) {
    current = card;

    nodes.card.style.setProperty('--acc', readableAccent(card.gradient));
    nodes.card.style.setProperty('--band', subtleGradient(card.gradient));

    nodes.icon.className = `card__icon ${card.icon}`;
    nodes.kicker.textContent = card.registered ? 'Scan to open' : 'Unlisted page';
    nodes.title.textContent = card.title;
    nodes.deck.textContent = card.description;

    // The address without its scheme: shorter to read, and the scheme is never
    // the interesting part when you are checking a link before you follow it.
    nodes.url.textContent = card.url.replace(/^https?:\/\//, '');
    nodes.open.href = card.url;

    drawQr(card.url, `QR code for ${card.title} at ${card.url}`);
    document.title = `${card.title} | Share`;
}

function shareHref(path) {
    // On the subdomain the path is the address; anywhere else it is a query.
    return isShareHost ? `/${path}${path ? '/' : ''}` : `?p=${encodeURIComponent(path)}`;
}

function renderIndex(catalog) {
    const entries = indexEntries(catalog);
    if (!entries.length) return;

    const list = document.createDocumentFragment();
    entries.forEach((entry, i) => {
        const row = document.createElement('li');
        row.className = 'row';

        const ord = document.createElement('span');
        ord.className = 'row__ord';
        ord.textContent = String(i + 1).padStart(2, '0');

        const body = document.createElement('span');
        const title = document.createElement('span');
        title.className = 'row__title';
        title.textContent = entry.title;
        const path = document.createElement('span');
        path.className = 'row__path';
        path.textContent = entry.url.replace(/^https?:\/\//, '');
        body.append(title, path);

        const arrow = document.createElement('span');
        arrow.className = 'row__arrow';
        arrow.textContent = '→';
        arrow.setAttribute('aria-hidden', 'true');

        const cover = document.createElement('a');
        cover.className = 'row__cover';
        cover.href = shareHref(entry.path);
        cover.setAttribute('aria-label', `Share ${entry.title}`);

        row.append(ord, body, arrow, cover);
        list.append(row);
    });

    nodes.indexList.replaceChildren(list);
    nodes.indexCount.textContent = `/ ${entries.length}`;
    nodes.index.hidden = false;
}

//? ----------------------------------------------------------------- actions

let statusTimer = 0;

function say(message) {
    nodes.status.textContent = message;
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
        say('Copy blocked, the link is above');
    }
}

async function shareLink() {
    if (!current) return;
    try {
        await navigator.share({ title: current.title, url: current.url });
    } catch (error) {
        if (error && error.name !== 'AbortError') say('Sharing unavailable');
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
            say('Could not save');
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

async function boot() {
    let catalog = { origin: 'https://domenhribernik.com', pages: {} };
    try {
        const response = await fetch('catalog.json', { cache: 'no-cache' });
        if (response.ok) catalog = await response.json();
    } catch {
        // Offline, or the catalog has not been generated. The code still draws:
        // the address is built from the path, and that is the part that matters.
    }

    nodes.host.href = targetUrl(catalog.origin, '');
    nodes.host.textContent = catalog.origin.replace(/^https?:\/\//, '');

    const raw = targetPathFrom(location);
    const path = normalizeSharePath(raw, catalog.pages);

    if (path === null) {
        // Not an address on this site. Say so rather than drawing a code that
        // leads somewhere the visitor did not ask for.
        nodes.card.style.setProperty('--acc', '#b3261e');
        nodes.icon.className = 'card__icon fas fa-circle-question';
        nodes.kicker.textContent = 'Not a page here';
        nodes.title.textContent = 'No such address';
        nodes.deck.textContent =
            'That is not an address on this site, so there is nothing to point a code at. '
            + 'Pick one below instead.';
        el('qr-figure').hidden = true;
        nodes.open.href = targetUrl(catalog.origin, '');
        nodes.open.textContent = 'Go to the site';
        nodes.copy.hidden = true;
        nodes.save.hidden = true;
        renderIndex(catalog);
        return;
    }

    renderCard(resolveCard(catalog, path));

    // The address this card lives at, spelled out. On the main domain it is
    // the thing the page is trying to teach; on the subdomain it is what the
    // visitor already typed, confirmed back.
    nodes.footAddr.textContent = targetUrl(shareOriginFor(catalog.origin), path)
        .replace(/^https?:\/\//, '');

    // The landing state doubles as the index: arriving at the bare share
    // address shows the site's own card and then everything you could pick.
    if (path === '') renderIndex(catalog);

    if (navigator.share) nodes.share.hidden = false;
    nodes.copy.addEventListener('click', copyLink);
    nodes.share.addEventListener('click', shareLink);
    nodes.save.addEventListener('click', saveQr);
}

boot();
