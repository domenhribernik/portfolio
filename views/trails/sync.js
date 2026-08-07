// Talking to the server, which is strictly optional.
//
// Recording, history and playback all work with no account and no network:
// this file is what happens *afterwards*, when a signed-in visitor lands and
// wants their flights on every device and a link to send someone. Every call
// here fails soft. A refused sync must never cost a flight, so nothing is ever
// deleted locally on the strength of a server response.

import { loginUrl } from '../../components/auth-gate.js';
import { serializeFlight, deserializeFlight, mergeFlightLists } from './logic.js';

const API = '../../app/controllers/trails-controller.php';

export { loginUrl };

/** A JSON call that reports why it failed instead of throwing. */
async function call(query, options = {}) {
    let response;
    try {
        response = await fetch(`${API}?${query}`, {
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            ...options,
        });
    } catch {
        return { ok: false, offline: true, error: 'No connection.' };
    }
    if (response.status === 401) return { ok: false, signedOut: true };
    let data = null;
    try { data = await response.json(); } catch { /* an HTML error page */ }
    if (!response.ok || !data) {
        return { ok: false, error: (data && data.error) || `Server error ${response.status}.` };
    }
    return { ok: true, data };
}

/** Who, if anyone, is signed in. */
export function getSession() {
    return call('resource=session');
}

/** Summaries of every flight the server holds for this account. */
export function listRemote() {
    return call('resource=flights');
}

/** One flight with its whole track. */
export function fetchRemote(uuid) {
    return call(`resource=flight&uuid=${encodeURIComponent(uuid)}`);
}

export function renameRemote(uuid, name) {
    return call(`resource=flight&uuid=${encodeURIComponent(uuid)}&action=rename`, {
        method: 'POST', body: JSON.stringify({ name }),
    });
}

export function createShare(uuid) {
    return call(`resource=share&uuid=${encodeURIComponent(uuid)}&action=create`, { method: 'POST' });
}

export function revokeShare(uuid) {
    return call(`resource=share&uuid=${encodeURIComponent(uuid)}&action=revoke`, { method: 'POST' });
}

/** A shared flight by token. No account needed: this is the public link. */
export function fetchShared(token) {
    return call(`resource=shared&t=${encodeURIComponent(token)}`);
}

/**
 * Reconcile this device with the account, in one round trip plus one fetch
 * per flight that only exists on the other side.
 *
 * `load` is called to read a local flight's track lazily, so a sync of forty
 * flights does not pull forty tracks out of IndexedDB to discover it needed
 * none of them.
 */
export async function syncFlights({ local, load, save, markSynced }) {
    const remote = await listRemote();
    if (!remote.ok) return remote;

    const theirs = (remote.data.flights || []).map((f) => ({ uuid: f.uuid, updatedAt: f.updated_at }));
    const mine = local.map((f) => ({ uuid: f.id, updatedAt: f.updatedAt || 0 }));
    const { toPush, toPull } = mergeFlightLists(mine, theirs);

    let pushed = 0;
    let pulled = 0;

    if (toPush.length) {
        const payloads = [];
        const deleted = [];
        for (const uuid of toPush) {
            const flight = local.find((f) => f.id === uuid);
            if (!flight) continue;
            if (flight.deletedAt) { deleted.push(uuid); continue; }
            payloads.push(serializeFlight(flight, await load(uuid)));
        }

        // The controller caps how much one request may carry, so send the
        // flights in batches. Deletions are tiny and all ride along with the
        // first call, which is also the only call when there is nothing to
        // upload but something to tombstone.
        const batches = [];
        for (let i = 0; i < payloads.length; i += 8) batches.push(payloads.slice(i, i + 8));
        if (!batches.length && deleted.length) batches.push([]);

        for (let i = 0; i < batches.length; i++) {
            const res = await call('resource=sync', {
                method: 'POST',
                body: JSON.stringify({ flights: batches[i], deleted: i === 0 ? deleted : [] }),
            });
            if (!res.ok) return res;
            pushed += (res.data.accepted || []).length;
            for (const uuid of res.data.accepted || []) await markSynced(uuid);
        }
    }

    for (const uuid of toPull) {
        const res = await fetchRemote(uuid);
        if (!res.ok) continue;
        const parsed = deserializeFlight(res.data.flight);
        if (!parsed) continue;
        await save(parsed.flight, parsed.points);
        pulled++;
    }

    return { ok: true, pushed, pulled };
}
