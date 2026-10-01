// The one door to trips-controller.php. It never throws: every call resolves
// to {ok, status, code, data, offline, signedOut}, because the offline outbox
// and the screens both need to decide what a failure means rather than catch
// it. Writes carry X-Trips-Client, which the controller requires on every
// non-GET as its CSRF backstop.

export const API = '../../app/controllers/trips-controller.php';

function url(params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') q.set(k, v);
    }
    return `${API}?${q}`;
}

/** Same-origin URL of a stored photo's bytes. size: 'thumb' | 'display'. */
export function photoUrl(uuid, size = 'thumb') {
    return url({ resource: 'photo', uuid, size });
}

/**
 * @param {object} params   query string (resource, action, uuid, ...)
 * @param {object} [opts]   {method, json, form, timeoutMs}
 */
export async function call(params, { method = 'GET', json, form, timeoutMs = 30000 } = {}) {
    const headers = {};
    let body;
    if (method !== 'GET') headers['X-Trips-Client'] = '1';
    if (json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(json);
    } else if (form !== undefined) {
        body = form;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(url(params), {
            method, headers, body, credentials: 'same-origin', signal: ctrl.signal,
        });
    } catch {
        return { ok: false, status: 0, code: null, data: null, offline: true, signedOut: false };
    } finally {
        clearTimeout(timer);
    }

    let data = null;
    try { data = await res.json(); } catch { /* an empty or HTML error body */ }
    return {
        ok: res.ok,
        status: res.status,
        code: data?.code ?? null,
        data,
        offline: false,
        signedOut: res.status === 401,
    };
}
