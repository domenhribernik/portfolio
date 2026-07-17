import { accentFromGradient, shelfNote, toggleRequest, applyToggle } from './logic.js';

const API = '../../app/controllers/hub-controller.php';

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* non-fatal */ });
}

const VIEWS = ['view-loading', 'view-signin', 'view-grid', 'view-empty', 'view-error'];

function show(id) {
    VIEWS.forEach(v => document.getElementById(v).classList.toggle('hidden', v !== id));
}

// ------------------------------------------------------------------
//  Masthead
// ------------------------------------------------------------------

document.getElementById('today').textContent = new Date()
    .toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
    .replace(/,\s*/g, ' · ');

// ------------------------------------------------------------------
//  Shelf
// ------------------------------------------------------------------

const btnEdit = document.getElementById('btn-edit');

async function boot() {
    show('view-loading');
    btnEdit.classList.add('hidden');
    document.getElementById('shelf-note').textContent = 'opening the shelf…';

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
        document.getElementById('shelf-note').textContent = 'signed out';
        show('view-signin');
        return;
    }
    if (!res.ok) {
        showError();
        return;
    }

    const apps = await res.json().catch(() => null);
    if (!Array.isArray(apps)) {
        showError();
        return;
    }

    btnEdit.classList.remove('hidden');
    document.getElementById('shelf-note').textContent = shelfNote(apps.length);

    if (apps.length === 0) {
        show('view-empty');
        return;
    }

    renderTiles(apps);
    show('view-grid');
}

function showError() {
    document.getElementById('shelf-note').textContent = 'offline';
    show('view-error');
}

function renderTiles(apps) {
    // Root-relative urls from the DB resolve against the site root, so tiles
    // work whether the site is served at / or under /portfolio/.
    const siteRoot = new URL('../../', location.href);
    const grid = document.getElementById('tile-grid');
    grid.replaceChildren();

    apps.forEach((app, i) => {
        const li = document.createElement('li');
        li.style.animationDelay = (i * 60) + 'ms';

        const a = document.createElement('a');
        a.className = 'tile';
        // Each tile's stored gradient collapses to a single flat accent (its
        // first hex), driving the border, the icon, and the press-tint.
        a.style.setProperty('--accent', accentFromGradient(app.gradient));
        a.href = app.url.startsWith('/') ? new URL(app.url.slice(1), siteRoot).href : app.url;

        const icon = document.createElement('i');
        icon.className = app.icon + ' tile-icon';
        icon.setAttribute('aria-hidden', 'true');

        const name = document.createElement('span');
        name.className = 'tile-name';
        name.textContent = app.name;

        a.append(icon, name);
        li.appendChild(a);
        grid.appendChild(li);
    });
}

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
    btnEdit.focus();
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
    if (res.status === 401) {
        closePicker(); // session expired: boot() will show the sign-in card
        return;
    }
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
        // A 404 on remove means it was already gone: the desired state holds.
        ok = res.ok || (req.method === 'DELETE' && res.status === 404);
    } catch {
        ok = false;
    }

    inflight.delete(appId);
    if (!ok) {
        manageList = applyToggle(manageList, appId, tile.on_shelf); // revert
        pickerNote.textContent = 'could not save, try again';
    }
    renderPicker();
}

btnEdit.addEventListener('click', openPicker);
document.getElementById('btn-choose').addEventListener('click', openPicker);
document.getElementById('btn-picker-close').addEventListener('click', closePicker);
document.getElementById('picker-backdrop').addEventListener('click', closePicker);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !picker.classList.contains('hidden')) closePicker();
});

document.getElementById('btn-retry').addEventListener('click', boot);

boot();
