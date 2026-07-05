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
        li.style.animationDelay = (i * 70) + 'ms';

        const a = document.createElement('a');
        a.className = 'tile block bg-card border border-ink rounded p-3 sm:p-4';
        a.href = app.url.startsWith('/') ? new URL(app.url.slice(1), siteRoot).href : app.url;

        const square = document.createElement('div');
        square.className = 'aspect-square rounded-sm border border-ink/10 bg-paper-2 flex items-center justify-center';
        const icon = document.createElement('i');
        icon.className = app.icon + ' text-clay text-4xl';
        icon.setAttribute('aria-hidden', 'true');
        square.appendChild(icon);

        const row = document.createElement('div');
        row.className = 'flex items-baseline justify-between gap-2 mt-3';
        const name = document.createElement('span');
        name.className = 'font-display font-bold text-lg leading-tight truncate';
        name.textContent = app.name;
        const arrow = document.createElement('i');
        arrow.className = 'fa-solid fa-arrow-right tile-arrow text-clay text-sm shrink-0';
        arrow.setAttribute('aria-hidden', 'true');
        row.append(name, arrow);

        const kicker = document.createElement('p');
        kicker.className = 'font-mono text-[10px] tracking-[0.18em] uppercase text-stone mt-1 truncate flex items-center gap-1.5';
        // The tile's color survives only as this small accent dot.
        const dot = document.createElement('span');
        dot.className = 'w-2 h-2 rounded-full inline-block shrink-0';
        dot.style.background = app.gradient;
        kicker.append(dot, document.createTextNode(kickerFor(app.url)));

        a.append(square, row, kicker);
        li.appendChild(a);
        grid.appendChild(li);
    });
}

function kickerFor(url) {
    if (url.startsWith('/')) {
        return url.replace(/^\/views\//, '').replace(/\/+$/, '').replace(/^\//, '') || 'home';
    }
    try {
        return new URL(url).hostname;
    } catch {
        return 'link';
    }
}

document.getElementById('btn-retry').addEventListener('click', boot);

boot();
