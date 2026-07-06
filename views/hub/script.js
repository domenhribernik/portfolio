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

async function boot() {
    show('view-loading');
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

    if (apps.length === 0) {
        document.getElementById('shelf-note').textContent = 'nothing on the shelf';
        show('view-empty');
        return;
    }

    renderTiles(apps);
    document.getElementById('shelf-note').textContent =
        apps.length + (apps.length === 1 ? ' app on this shelf' : ' apps on this shelf');
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

// The stored gradient collapses to a flat accent: its first hex color, or ink
// if it has none. Mirrors accentFromGradient() in views/admin/logic.js.
function accentFromGradient(gradient) {
    const m = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/.exec(gradient || '');
    return m ? m[0] : '#1c1a17';
}

document.getElementById('btn-retry').addEventListener('click', boot);

boot();
