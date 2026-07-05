const API = '../../app/controllers/auth-controller.php';

const views = ['view-loading', 'view-login', 'view-account', 'view-reset'];
let me = null;

// ------------------------------------------------------------------
//  API helper
// ------------------------------------------------------------------

async function apiFetch(params, options = {}) {
    const url = API + '?' + new URLSearchParams(params);
    if (options.body !== undefined) {
        options.headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
        options.body = JSON.stringify(options.body);
    }
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
}

// ------------------------------------------------------------------
//  View switching
// ------------------------------------------------------------------

function showView(id) {
    views.forEach(v => document.getElementById(v).classList.toggle('hidden', v !== id));
}

function setMsg(id, text, ok = false) {
    const el = document.getElementById(id);
    el.textContent = text;
    el.classList.toggle('hidden', !text);
    el.classList.toggle('text-pine', ok);
    el.classList.toggle('text-danger', !ok);
}

// ------------------------------------------------------------------
//  Boot
// ------------------------------------------------------------------

async function boot() {
    const resetToken = new URLSearchParams(location.search).get('reset');
    if (resetToken) {
        showView('view-reset');
        initResetForm(resetToken);
        return;
    }
    try {
        const data = await apiFetch({ action: 'me' });
        if (data.user) {
            me = data;
            renderAccount();
        } else {
            showView('view-login');
            initGoogleButton();
        }
    } catch {
        showView('view-login');
        initGoogleButton();
    }
}

function afterLogin(data) {
    const redirect = new URLSearchParams(location.search).get('redirect');
    // Only same-site relative paths, so the login page can't be used to bounce elsewhere.
    if (redirect && redirect.startsWith('/') && !redirect.startsWith('//')) {
        location.href = redirect;
        return;
    }
    me = data;
    renderAccount();
}

// ------------------------------------------------------------------
//  Google sign-in
// ------------------------------------------------------------------

async function initGoogleButton() {
    let clientId = '';
    try {
        const cfg = await apiFetch({ action: 'config' });
        clientId = cfg.google_client_id || '';
    } catch { /* fall through to the note below */ }

    if (!clientId) {
        document.getElementById('gsi-note').classList.remove('hidden');
        return;
    }

    const render = () => {
        google.accounts.id.initialize({ client_id: clientId, callback: onGoogleCredential });
        google.accounts.id.renderButton(document.getElementById('gsi-button'), {
            theme: 'outline',
            size: 'large',
            text: 'continue_with',
            width: 320,
        });
    };

    if (window.google && google.accounts) {
        render();
    } else {
        // The GSI script loads async; poll briefly until it lands.
        let tries = 0;
        const timer = setInterval(() => {
            if (window.google && google.accounts) {
                clearInterval(timer);
                render();
            } else if (++tries > 50) {
                clearInterval(timer);
                document.getElementById('gsi-note').classList.remove('hidden');
            }
        }, 100);
    }
}

async function onGoogleCredential(response) {
    setMsg('login-error', '');
    try {
        const data = await apiFetch({ action: 'google' }, {
            method: 'POST',
            body: { credential: response.credential },
        });
        afterLogin(data);
    } catch (err) {
        setMsg('login-error', err.message);
    }
}

// ------------------------------------------------------------------
//  Backup password login
// ------------------------------------------------------------------

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg('login-error', '');
    try {
        const data = await apiFetch({ action: 'login' }, {
            method: 'POST',
            body: {
                identifier: document.getElementById('login-identifier').value.trim(),
                password: document.getElementById('login-password').value,
            },
        });
        afterLogin(data);
    } catch (err) {
        setMsg('login-error', err.message);
    }
});

// ------------------------------------------------------------------
//  Signed-in account view
// ------------------------------------------------------------------

function renderAccount() {
    showView('view-account');
    const u = me.user;

    document.getElementById('acct-name').textContent = u.display_name || u.username || u.email;
    document.getElementById('acct-email').textContent = u.email;

    const avatar = document.getElementById('acct-avatar');
    const fallback = document.getElementById('acct-avatar-fallback');
    if (u.avatar_url) {
        avatar.src = u.avatar_url;
        avatar.classList.remove('hidden');
        fallback.classList.add('hidden');
    } else {
        fallback.textContent = (u.display_name || u.email || '?').charAt(0).toUpperCase();
    }

    const badges = document.getElementById('acct-badges');
    badges.replaceChildren();
    if (u.is_admin) badges.appendChild(badge('site admin', true));
    (me.roles || []).forEach(r => badges.appendChild(badge(`${r.project_key} / ${r.role}`)));
    if (!u.is_admin && (me.roles || []).length === 0) {
        badges.appendChild(badge('no project roles yet'));
    }

    const credState = document.getElementById('cred-state');
    credState.textContent = u.has_password ? '[ configured ]' : '[ not set ]';
    credState.className = 'font-mono text-xs ' + (u.has_password ? 'text-pine' : 'text-faint');
    document.getElementById('cred-username').value = u.username || '';
    document.getElementById('cred-current-wrap').classList.toggle('hidden', !u.has_password);

    loadSessions();
}

function badge(text, clay = false) {
    const span = document.createElement('span');
    span.className = 'font-mono text-[10px] tracking-[0.15em] uppercase px-2 py-1 border rounded-[2px] '
        + (clay ? 'border-clay text-clay' : 'border-ink/20 text-stone');
    span.textContent = text;
    return span;
}

document.getElementById('btn-logout').addEventListener('click', async () => {
    try {
        await apiFetch({ action: 'logout' }, { method: 'POST', body: {} });
    } finally {
        me = null;
        showView('view-login');
        initGoogleButton();
    }
});

// ------------------------------------------------------------------
//  Backup credentials form
// ------------------------------------------------------------------

document.getElementById('cred-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg('cred-msg', '');
    try {
        const data = await apiFetch({ action: 'set-credentials' }, {
            method: 'POST',
            body: {
                username: document.getElementById('cred-username').value.trim(),
                new_password: document.getElementById('cred-password').value,
                current_password: document.getElementById('cred-current').value,
            },
        });
        document.getElementById('cred-password').value = '';
        document.getElementById('cred-current').value = '';
        me = await apiFetch({ action: 'me' });
        renderAccount();
        setMsg('cred-msg', data.message, true);
    } catch (err) {
        setMsg('cred-msg', err.message);
    }
});

// ------------------------------------------------------------------
//  Sessions
// ------------------------------------------------------------------

async function loadSessions() {
    const list = document.getElementById('session-list');
    list.replaceChildren();
    let sessions = [];
    try {
        sessions = await apiFetch({ resource: 'sessions' });
    } catch {
        return;
    }
    sessions.forEach(s => {
        const li = document.createElement('li');
        li.className = 'flex items-center justify-between gap-3 border border-hairline bg-paper rounded-[3px] px-4 py-3';

        const info = document.createElement('div');
        info.className = 'min-w-0';
        const line1 = document.createElement('p');
        line1.className = 'font-mono text-xs text-ink truncate';
        line1.textContent = (s.ip_address || 'unknown ip') + (s.current ? '  · this device' : '');
        const line2 = document.createElement('p');
        line2.className = 'font-mono text-[10px] text-faint truncate';
        line2.textContent = `${shortAgent(s.user_agent)} · last seen ${s.last_seen_at}`;
        info.append(line1, line2);
        li.appendChild(info);

        if (s.current) {
            const tag = document.createElement('span');
            tag.className = 'font-mono text-[10px] uppercase tracking-widest text-pine shrink-0';
            tag.textContent = 'active';
            li.appendChild(tag);
        } else {
            const btn = document.createElement('button');
            btn.className = 'btn-ghost shrink-0';
            btn.textContent = 'Revoke';
            btn.addEventListener('click', async () => {
                try {
                    await apiFetch({ resource: 'sessions', id: s.id }, { method: 'DELETE' });
                    loadSessions();
                } catch { /* list refresh will show reality */ }
            });
            li.appendChild(btn);
        }
        list.appendChild(li);
    });
}

function shortAgent(ua) {
    if (!ua) return 'unknown device';
    if (ua.includes('Firefox')) return 'Firefox';
    if (ua.includes('Edg/')) return 'Edge';
    if (ua.includes('Chrome')) return 'Chrome';
    if (ua.includes('Safari')) return 'Safari';
    return ua.slice(0, 40);
}

// ------------------------------------------------------------------
//  One-time reset link
// ------------------------------------------------------------------

function initResetForm(token) {
    document.getElementById('reset-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        setMsg('reset-msg', '');
        const p1 = document.getElementById('reset-password').value;
        const p2 = document.getElementById('reset-password2').value;
        if (p1 !== p2) {
            setMsg('reset-msg', 'Passwords do not match');
            return;
        }
        try {
            const data = await apiFetch({ action: 'reset-password' }, {
                method: 'POST',
                body: { token, new_password: p1 },
            });
            setMsg('reset-msg', data.message + ' Redirecting to sign-in…', true);
            setTimeout(() => { location.href = location.pathname; }, 1800);
        } catch (err) {
            setMsg('reset-msg', err.message);
        }
    });
}

boot();
