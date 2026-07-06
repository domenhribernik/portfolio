import { resolveTab, filterProjects, filterHubApps, buildHubPayload, swapPlan, randomGradient, accentFromGradient } from './logic.js';

const ADMIN_API = '../../app/controllers/admin-controller.php';
const AUTH_API = '../../app/controllers/auth-controller.php';
const HUB_API = '../../app/controllers/hub-controller.php';

let selectedUserId = null;
let selectedUser = null;
let projects = [];

// ------------------------------------------------------------------
//  API helper
// ------------------------------------------------------------------

async function apiFetch(base, params, options = {}) {
    const url = base + '?' + new URLSearchParams(params);
    if (options.body !== undefined) {
        options.headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
        options.body = JSON.stringify(options.body);
    }
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
}

const adminFetch = (params, options) => apiFetch(ADMIN_API, params, options);
const hubFetch = (params, options) => apiFetch(HUB_API, params, options);

// ------------------------------------------------------------------
//  Toast
// ------------------------------------------------------------------

let toastTimer = null;

function toast(message, isError = false) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.classList.remove('hidden');
    el.classList.toggle('toast-error', isError);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// ------------------------------------------------------------------
//  Tabs (hash-routed: #users / #projects / #hub)
// ------------------------------------------------------------------

const tabButtons = document.querySelectorAll('.tab');

function setTab(id, updateHash = false) {
    tabButtons.forEach(t => {
        const active = t.dataset.tab === id;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', String(active));
    });
    ['users', 'projects', 'hub'].forEach(p => {
        document.getElementById('panel-' + p).classList.toggle('hidden', p !== id);
    });
    if (updateHash) history.replaceState(null, '', '#' + id);
}

tabButtons.forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab, true)));
window.addEventListener('hashchange', () => setTab(resolveTab(location.hash)));
setTab(resolveTab(location.hash));

function setCount(id, n) {
    document.getElementById(id).textContent = String(n);
}

// ------------------------------------------------------------------
//  Boot / gate
// ------------------------------------------------------------------

async function boot() {
    let meData = null;
    try {
        meData = await apiFetch(AUTH_API, { action: 'me' });
    } catch { /* treated as signed out below */ }

    if (!meData || !meData.user || !meData.user.is_admin) {
        document.getElementById('view-loading').classList.add('hidden');
        const link = document.getElementById('denied-login-link');
        link.href = '../account/?redirect=' + encodeURIComponent(location.pathname);
        document.getElementById('view-denied').classList.remove('hidden');
        return;
    }

    document.getElementById('whoami').textContent = meData.user.email;
    document.getElementById('view-loading').classList.add('hidden');
    document.getElementById('view-dash').classList.remove('hidden');

    await Promise.all([loadUsers(), loadProjects(), loadHubApps()]);
}

// ------------------------------------------------------------------
//  Roster
// ------------------------------------------------------------------

async function loadUsers() {
    const q = document.getElementById('user-search').value.trim();
    let users = [];
    try {
        users = await adminFetch(q ? { resource: 'users', q } : { resource: 'users' });
    } catch (err) {
        toast(err.message, true);
        return;
    }

    if (!q) setCount('count-users', users.length);

    const list = document.getElementById('user-list');
    list.replaceChildren();
    document.getElementById('user-empty').classList.toggle('hidden', users.length > 0);

    users.forEach(u => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'roster-row' + (u.id === selectedUserId ? ' selected' : '');
        btn.addEventListener('click', () => selectUser(u.id));

        const led = document.createElement('span');
        led.className = 'led ' + (u.is_active ? 'led-ok' : 'led-off');
        btn.appendChild(led);

        const info = document.createElement('span');
        info.className = 'min-w-0 flex-1';
        const name = document.createElement('span');
        name.className = 'block text-sm font-semibold truncate';
        name.textContent = u.display_name || u.username || u.email;
        const mail = document.createElement('span');
        mail.className = 'block font-mono text-[10px] text-faint truncate';
        mail.textContent = u.email;
        info.append(name, mail);
        btn.appendChild(info);

        const tags = document.createElement('span');
        tags.className = 'font-mono text-[9px] uppercase tracking-widest text-stone shrink-0 text-right';
        tags.textContent = [
            u.is_admin ? 'admin' : null,
            !u.is_active ? 'off' : null,
            u.role_count ? `${u.role_count}r` : null,
        ].filter(Boolean).join(' · ');
        btn.appendChild(tags);

        li.appendChild(btn);
        list.appendChild(li);
    });
}

let searchTimer = null;
document.getElementById('user-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadUsers, 250);
});

// ------------------------------------------------------------------
//  User detail
// ------------------------------------------------------------------

async function selectUser(id) {
    selectedUserId = id;
    let data;
    try {
        data = await adminFetch({ resource: 'users', id });
    } catch (err) {
        toast(err.message, true);
        return;
    }
    selectedUser = data.user;

    document.getElementById('detail-placeholder').classList.add('hidden');
    document.getElementById('detail').classList.remove('hidden');
    document.querySelectorAll('.roster-row').forEach(r => r.classList.remove('selected'));
    loadUsers();

    renderProfile(data);
    renderRoles(data.roles);
    renderPasswordSection(data);
    renderSessions(data.sessions);
}

function renderProfile(data) {
    const u = data.user;
    document.getElementById('d-name').textContent = u.display_name || u.username || u.email;
    document.getElementById('d-email').textContent = u.email;

    const avatar = document.getElementById('d-avatar');
    const fallback = document.getElementById('d-avatar-fallback');
    if (u.avatar_url) {
        avatar.src = u.avatar_url;
        avatar.classList.remove('hidden');
        fallback.classList.add('hidden');
    } else {
        avatar.classList.add('hidden');
        fallback.classList.remove('hidden');
        fallback.textContent = (u.display_name || u.email || '?').charAt(0).toUpperCase();
    }

    const badges = document.getElementById('d-badges');
    badges.replaceChildren();
    if (u.is_admin) badges.appendChild(badge('site admin', 'clay'));
    badges.appendChild(u.is_active ? badge('active', 'ok') : badge('deactivated', 'danger'));
    if (u.username) badges.appendChild(badge('@' + u.username));

    const meta = document.getElementById('d-meta');
    meta.replaceChildren();
    metaItem(meta, 'user id', '#' + u.id);
    metaItem(meta, 'google', u.has_google ? 'linked' : 'not linked');
    metaItem(meta, 'last login', u.last_login_at || 'never');
    metaItem(meta, 'created', u.created_at || '');

    const toggle = document.getElementById('btn-toggle-active');
    toggle.textContent = u.is_active ? 'Deactivate' : 'Reactivate';
    toggle.onclick = async () => {
        if (u.is_active && !confirm(`Deactivate ${u.email}? They will be signed out everywhere.`)) return;
        try {
            const res = await adminFetch({ resource: 'users', id: u.id }, {
                method: 'PUT',
                body: { is_active: !u.is_active },
            });
            toast(res.message);
            selectUser(u.id);
        } catch (err) {
            toast(err.message, true);
        }
    };
}

function metaItem(parent, label, value) {
    const wrap = document.createElement('div');
    const dt = document.createElement('dt');
    dt.className = 'field-label mb-0';
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.className = 'font-mono text-xs text-ink truncate';
    dd.textContent = value;
    wrap.append(dt, dd);
    parent.appendChild(wrap);
}

function badge(text, tone = '') {
    const span = document.createElement('span');
    const toneClass = {
        clay: 'border-clay text-clay',
        ok: 'border-pine/50 text-pine',
        danger: 'border-danger/60 text-danger',
    }[tone] || 'border-ink/20 text-stone';
    span.className = 'font-mono text-[10px] tracking-[0.15em] uppercase px-2 py-0.5 border rounded-[2px] ' + toneClass;
    span.textContent = text;
    return span;
}

// ------------------------------------------------------------------
//  Roles
// ------------------------------------------------------------------

function renderRoles(roles) {
    const list = document.getElementById('d-roles');
    list.replaceChildren();
    if (!roles.length) {
        const li = document.createElement('li');
        li.className = 'font-mono text-xs text-faint';
        li.textContent = 'No roles granted.';
        list.appendChild(li);
    }
    roles.forEach(r => {
        const li = document.createElement('li');
        li.className = 'flex items-center justify-between gap-3 border border-hairline bg-paper rounded-[3px] px-4 py-2.5';

        const info = document.createElement('div');
        info.className = 'min-w-0';
        const line = document.createElement('p');
        line.className = 'font-mono text-xs text-ink truncate';
        line.textContent = `${r.project_key} / ${r.role}`;
        info.appendChild(line);
        if (r.permissions) {
            const perms = document.createElement('p');
            perms.className = 'font-mono text-[10px] text-faint truncate';
            perms.textContent = JSON.stringify(r.permissions);
            info.appendChild(perms);
        }
        li.appendChild(info);

        const btn = document.createElement('button');
        btn.className = 'btn-ghost shrink-0';
        btn.textContent = 'Revoke';
        btn.addEventListener('click', async () => {
            if (!confirm(`Revoke ${r.project_key}/${r.role}?`)) return;
            try {
                const res = await adminFetch({ resource: 'roles', id: r.id }, { method: 'DELETE' });
                toast(res.message);
                selectUser(selectedUserId);
            } catch (err) {
                toast(err.message, true);
            }
        });
        li.appendChild(btn);
        list.appendChild(li);
    });
}

document.getElementById('grant-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedUserId) return;

    const rawPerms = document.getElementById('grant-permissions').value.trim();
    let permissions = null;
    if (rawPerms) {
        try {
            permissions = JSON.parse(rawPerms);
        } catch {
            toast('Permissions is not valid JSON', true);
            return;
        }
    }

    try {
        const res = await adminFetch({ resource: 'roles' }, {
            method: 'POST',
            body: {
                user_id: selectedUserId,
                project_key: document.getElementById('grant-project').value,
                role: document.getElementById('grant-role').value.trim(),
                permissions,
            },
        });
        toast(res.message);
        document.getElementById('grant-role').value = '';
        document.getElementById('grant-permissions').value = '';
        selectUser(selectedUserId);
    } catch (err) {
        toast(err.message, true);
    }
});

// ------------------------------------------------------------------
//  Password / resets
// ------------------------------------------------------------------

function renderPasswordSection(data) {
    const el = document.getElementById('d-haspwd');
    el.textContent = data.user.has_password ? '[ configured ]' : '[ not set ]';
    el.className = 'font-mono text-xs ' + (data.user.has_password ? 'text-pine' : 'text-faint');

    document.getElementById('reset-output').classList.add('hidden');
    document.getElementById('temp-form').classList.add('hidden');
    document.getElementById('d-resets-note').textContent = data.resets.length
        ? `${data.resets.length} unused reset link(s) pending, newest expires ${data.resets[0].expires_at}`
        : '';
}

document.getElementById('btn-reset-link').addEventListener('click', async () => {
    if (!selectedUserId) return;
    try {
        const res = await adminFetch({ resource: 'resets', action: 'link' }, {
            method: 'POST',
            body: { user_id: selectedUserId },
        });
        const url = location.origin + res.path;
        document.getElementById('reset-url').textContent = url;
        document.getElementById('reset-ttl').textContent = res.expires_in;
        document.getElementById('reset-output').classList.remove('hidden');
    } catch (err) {
        toast(err.message, true);
    }
});

document.getElementById('btn-copy-reset').addEventListener('click', async () => {
    const url = document.getElementById('reset-url').textContent;
    try {
        await navigator.clipboard.writeText(url);
        toast('Link copied');
    } catch {
        toast('Copy failed, select it manually', true);
    }
});

document.getElementById('btn-temp-pwd').addEventListener('click', () => {
    document.getElementById('temp-form').classList.toggle('hidden');
});

document.getElementById('temp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedUserId) return;
    try {
        const res = await adminFetch({ resource: 'resets', action: 'temp-password' }, {
            method: 'POST',
            body: {
                user_id: selectedUserId,
                password: document.getElementById('temp-password').value,
            },
        });
        toast(res.message);
        document.getElementById('temp-password').value = '';
        document.getElementById('temp-form').classList.add('hidden');
        selectUser(selectedUserId);
    } catch (err) {
        toast(err.message, true);
    }
});

// ------------------------------------------------------------------
//  Sessions
// ------------------------------------------------------------------

function renderSessions(sessions) {
    const list = document.getElementById('d-sessions');
    list.replaceChildren();
    document.getElementById('d-sessions-empty').classList.toggle('hidden', sessions.length > 0);

    sessions.forEach(s => {
        const li = document.createElement('li');
        li.className = 'flex items-center justify-between gap-3 border border-hairline bg-paper rounded-[3px] px-4 py-2.5';

        const info = document.createElement('div');
        info.className = 'min-w-0';
        const line1 = document.createElement('p');
        line1.className = 'font-mono text-xs text-ink truncate';
        line1.textContent = s.ip_address || 'unknown ip';
        const line2 = document.createElement('p');
        line2.className = 'font-mono text-[10px] text-faint truncate';
        line2.textContent = `${(s.user_agent || 'unknown device').slice(0, 60)} · last seen ${s.last_seen_at}`;
        info.append(line1, line2);
        li.appendChild(info);

        const btn = document.createElement('button');
        btn.className = 'btn-ghost shrink-0';
        btn.textContent = 'Revoke';
        btn.addEventListener('click', async () => {
            try {
                const res = await adminFetch({ resource: 'sessions', id: s.id }, { method: 'DELETE' });
                toast(res.message);
                selectUser(selectedUserId);
            } catch (err) {
                toast(err.message, true);
            }
        });
        li.appendChild(btn);
        list.appendChild(li);
    });
}

document.getElementById('btn-revoke-all').addEventListener('click', async () => {
    if (!selectedUserId) return;
    if (!confirm('Revoke every session of this user?')) return;
    try {
        const res = await adminFetch({ resource: 'sessions', user_id: selectedUserId, all: 1 }, { method: 'DELETE' });
        toast(res.message);
        selectUser(selectedUserId);
    } catch (err) {
        toast(err.message, true);
    }
});

// ------------------------------------------------------------------
//  Projects registry
// ------------------------------------------------------------------

async function loadProjects() {
    try {
        projects = await adminFetch({ resource: 'projects' });
    } catch (err) {
        toast(err.message, true);
        return;
    }

    setCount('count-projects', projects.length);
    renderProjects();

    // Grant form project picker only offers active projects.
    const select = document.getElementById('grant-project');
    select.replaceChildren();
    projects.filter(p => p.active).forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.project_key;
        opt.textContent = `${p.project_key} (${p.name})`;
        select.appendChild(opt);
    });

    // Hub tile project picker: blank option = visible to any signed-in user.
    // Inactive projects stay listed since tiles may already link to them.
    const hubSelect = document.getElementById('hub-project');
    const previous = hubSelect.value;
    hubSelect.replaceChildren();
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'everyone (any signed-in user)';
    hubSelect.appendChild(blank);
    projects.forEach(p => {
        const opt = document.createElement('option');
        opt.value = String(p.id);
        opt.textContent = `${p.project_key} (${p.name})${p.active ? '' : ' · disabled'}`;
        hubSelect.appendChild(opt);
    });
    hubSelect.value = previous;
    if (hubSelect.selectedIndex === -1) hubSelect.value = '';
}

function renderProjects() {
    const visible = filterProjects(projects, document.getElementById('project-search').value);

    const list = document.getElementById('project-list');
    list.replaceChildren();
    document.getElementById('project-empty').classList.toggle('hidden', visible.length > 0);

    visible.forEach(p => {
        const li = document.createElement('li');
        li.className = 'flex items-center justify-between gap-3 border border-hairline bg-paper rounded-[3px] px-4 py-2.5';

        const info = document.createElement('div');
        info.className = 'flex items-center gap-3 min-w-0';
        const led = document.createElement('span');
        led.className = 'led ' + (p.active ? 'led-ok' : 'led-off');
        const label = document.createElement('p');
        label.className = 'font-mono text-xs text-ink truncate';
        label.textContent = `${p.project_key} · ${p.name} · ${p.member_count} member(s)`;
        info.append(led, label);
        li.appendChild(info);

        const btn = document.createElement('button');
        btn.className = 'btn-ghost shrink-0';
        btn.textContent = p.active ? 'Disable' : 'Enable';
        btn.addEventListener('click', async () => {
            try {
                const res = await adminFetch({ resource: 'projects', id: p.id }, {
                    method: 'PUT',
                    body: { active: !p.active },
                });
                toast(res.message);
                loadProjects();
            } catch (err) {
                toast(err.message, true);
            }
        });
        li.appendChild(btn);
        list.appendChild(li);
    });
}

document.getElementById('project-search').addEventListener('input', renderProjects);

document.getElementById('project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        const res = await adminFetch({ resource: 'projects' }, {
            method: 'POST',
            body: {
                project_key: document.getElementById('project-key').value.trim(),
                name: document.getElementById('project-name').value.trim(),
            },
        });
        toast(res.message);
        document.getElementById('project-key').value = '';
        document.getElementById('project-name').value = '';
        loadProjects();
    } catch (err) {
        toast(err.message, true);
    }
});

// ------------------------------------------------------------------
//  Hub apps
// ------------------------------------------------------------------

let hubApps = [];
let editingHubAppId = null;

async function loadHubApps() {
    try {
        hubApps = await hubFetch({ all: 1 });
    } catch (err) {
        toast(err.message, true);
        return;
    }
    setCount('count-hub', hubApps.length);
    renderHubApps();
}

function renderHubApps() {
    const visible = filterHubApps(hubApps, document.getElementById('hub-search').value);
    // Reordering only makes sense on the full, unfiltered list.
    const filtered = visible.length !== hubApps.length;

    const list = document.getElementById('hub-list');
    list.replaceChildren();
    document.getElementById('hub-empty').classList.toggle('hidden', visible.length > 0);

    visible.forEach(app => {
        const i = hubApps.indexOf(app);
        const li = document.createElement('li');
        li.className = 'flex items-center justify-between gap-3 border border-hairline bg-paper rounded-[3px] px-4 py-2.5';

        const info = document.createElement('div');
        info.className = 'flex items-center gap-3 min-w-0';
        const led = document.createElement('span');
        led.className = 'led ' + (app.active ? 'led-ok' : 'led-off');
        const swatch = document.createElement('span');
        swatch.className = 'hub-swatch hub-swatch-sm shrink-0';
        swatch.style.setProperty('--swatch', app.gradient);
        // Mirror the hub: the icon carries the tile's flat accent (first hex).
        const icon = document.createElement('i');
        icon.className = app.icon + ' w-4 text-center shrink-0';
        icon.style.color = accentFromGradient(app.gradient);
        const label = document.createElement('p');
        label.className = 'font-mono text-xs text-ink truncate';
        label.textContent = `${app.name} · ${app.url} · ${app.project_key || 'everyone'} · #${app.sort_order}`;
        info.append(led, swatch, icon, label);
        li.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'flex gap-2 shrink-0';

        const upBtn = document.createElement('button');
        upBtn.className = 'btn-ghost';
        upBtn.textContent = '↑';
        upBtn.disabled = filtered || i === 0;
        upBtn.addEventListener('click', () => moveHubApp(i, -1));

        const downBtn = document.createElement('button');
        downBtn.className = 'btn-ghost';
        downBtn.textContent = '↓';
        downBtn.disabled = filtered || i === hubApps.length - 1;
        downBtn.addEventListener('click', () => moveHubApp(i, 1));

        const editBtn = document.createElement('button');
        editBtn.className = 'btn-ghost';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => startHubEdit(app));

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'btn-ghost';
        toggleBtn.textContent = app.active ? 'Disable' : 'Enable';
        toggleBtn.addEventListener('click', async () => {
            try {
                const res = await hubFetch({ id: app.id }, { method: 'PUT', body: { active: !app.active } });
                toast(res.message);
                loadHubApps();
            } catch (err) {
                toast(err.message, true);
            }
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn-ghost';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', async () => {
            if (!confirm(`Delete the "${app.name}" tile?`)) return;
            try {
                const res = await hubFetch({ id: app.id }, { method: 'DELETE' });
                toast(res.message);
                if (editingHubAppId === app.id) resetHubForm();
                loadHubApps();
            } catch (err) {
                toast(err.message, true);
            }
        });

        actions.append(upBtn, downBtn, editBtn, toggleBtn, deleteBtn);
        li.appendChild(actions);
        list.appendChild(li);
    });
}

document.getElementById('hub-search').addEventListener('input', renderHubApps);

async function moveHubApp(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= hubApps.length) return;
    try {
        for (const update of swapPlan(hubApps[i], hubApps[j], dir)) {
            await hubFetch({ id: update.id }, { method: 'PUT', body: { sort_order: update.sort_order } });
        }
        loadHubApps();
    } catch (err) {
        toast(err.message, true);
    }
}

// Reflect the current gradient value in the composer swatch. An empty field
// falls back to the paper placeholder so the swatch never renders as black.
function syncGradientSwatch() {
    const value = document.getElementById('hub-gradient').value.trim();
    document.getElementById('hub-gradient-swatch')
        .style.setProperty('--swatch', value || '#f6f2ea');
}

function startHubEdit(app) {
    editingHubAppId = app.id;
    document.getElementById('hub-name').value = app.name;
    document.getElementById('hub-url').value = app.url;
    document.getElementById('hub-icon').value = app.icon;
    document.getElementById('hub-gradient').value = app.gradient;
    document.getElementById('hub-project').value = app.project_id === null ? '' : String(app.project_id);
    document.getElementById('hub-sort').value = app.sort_order;
    document.getElementById('hub-submit').textContent = 'Save tile';
    document.getElementById('hub-cancel').classList.remove('hidden');
    syncGradientSwatch();
    document.getElementById('hub-name').focus();
}

function resetHubForm() {
    editingHubAppId = null;
    document.getElementById('hub-form').reset();
    document.getElementById('hub-project').value = '';
    document.getElementById('hub-sort').value = '0';
    document.getElementById('hub-submit').textContent = 'Add tile';
    document.getElementById('hub-cancel').classList.add('hidden');
    syncGradientSwatch();
}

document.getElementById('hub-cancel').addEventListener('click', resetHubForm);
document.getElementById('hub-gradient').addEventListener('input', syncGradientSwatch);
document.getElementById('hub-gradient-random').addEventListener('click', () => {
    document.getElementById('hub-gradient').value = randomGradient();
    syncGradientSwatch();
});

document.getElementById('hub-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = buildHubPayload({
        name: document.getElementById('hub-name').value,
        url: document.getElementById('hub-url').value,
        icon: document.getElementById('hub-icon').value,
        gradient: document.getElementById('hub-gradient').value,
        project: document.getElementById('hub-project').value,
        sort: document.getElementById('hub-sort').value,
    });
    try {
        const res = editingHubAppId === null
            ? await hubFetch({}, { method: 'POST', body })
            : await hubFetch({ id: editingHubAppId }, { method: 'PUT', body });
        toast(res.message);
        resetHubForm();
        loadHubApps();
    } catch (err) {
        toast(err.message, true);
    }
});

boot();
