// What this phone keeps for Trips, in IndexedDB:
//
//   outbox     creates waiting to be sent (logic.js has the rules)
//   blobs      the resized photo for each queued photo op. Until the server
//              confirms it, this can be the ONLY copy: a photo taken with the
//              in-app camera on iOS never reaches the camera roll.
//   snapshots  the last trip trees fetched, so a trip opens with no signal
//   lists      the last atlas per account
//   meta       small things: the last viewer, the map or grid preference
//
// Where IndexedDB is missing or refuses (Safari private mode), it falls back
// to memory and says so through `memory`, so the page can warn that a photo
// queued now is lost if the tab closes.

const DB_NAME = 'trips';
const DB_VERSION = 1;
const STORES = ['outbox', 'blobs', 'snapshots', 'lists', 'meta'];

let db = null;
const mem = Object.fromEntries(STORES.map((s) => [s, new Map()]));
let memSeq = 0;
export let memory = false;

export async function open() {
    if (db || memory) return;
    try {
        db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const d = req.result;
                if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
                for (const s of ['blobs', 'snapshots', 'lists', 'meta']) {
                    if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('blocked'));
        });
    } catch {
        memory = true;
    }
}

function tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req?.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
    });
}

async function get(store, key) {
    if (memory) return mem[store].get(key);
    return tx(store, 'readonly', (s) => s.get(key));
}

async function put(store, key, value) {
    if (memory) { mem[store].set(key, value); return; }
    await tx(store, 'readwrite', (s) => s.put(value, key));
}

async function del(store, key) {
    if (memory) { mem[store].delete(key); return; }
    await tx(store, 'readwrite', (s) => s.delete(key));
}

// ---- outbox ------------------------------------------------------------

export async function ops() {
    if (memory) return [...mem.outbox.values()].sort((a, b) => a.seq - b.seq);
    const all = await tx('outbox', 'readonly', (s) => s.getAll());
    return (all ?? []).sort((a, b) => a.seq - b.seq);
}

/** Adds an op (and its photo, in the same breath) and returns its seq. */
export async function addOp(op, blob = null) {
    if (blob) await put('blobs', op.uuid, blob);
    if (memory) {
        const seq = ++memSeq;
        mem.outbox.set(seq, { ...op, seq });
        return seq;
    }
    const { seq: _drop, ...rest } = op;
    return tx('outbox', 'readwrite', (s) => s.add(rest));
}

export async function putOp(op) {
    if (memory) { mem.outbox.set(op.seq, op); return; }
    await tx('outbox', 'readwrite', (s) => s.put(op));
}

/** Removes an op and its photo. Only ever called once the server has it. */
export async function deleteOp(op) {
    if (memory) mem.outbox.delete(op.seq);
    else await tx('outbox', 'readwrite', (s) => s.delete(op.seq));
    await del('blobs', op.uuid);
}

export const getBlob = (uuid) => get('blobs', uuid);

// ---- snapshots and lists --------------------------------------------------

export const putSnapshot = (tree, viewerId) => put('snapshots', tree.trip.uuid, { tree, viewerId, at: Date.now() });

export async function getSnapshot(tripUuid, viewerId) {
    const s = await get('snapshots', tripUuid);
    return s && s.viewerId === viewerId ? s.tree : null;
}

export const putList = (viewerId, data) => put('lists', String(viewerId), data);
export const getList = (viewerId) => get('lists', String(viewerId));

/** On a change of account: forget what the last one could see, keep its queue. */
export async function forgetViews() {
    if (memory) { mem.snapshots.clear(); mem.lists.clear(); return; }
    await tx('snapshots', 'readwrite', (s) => s.clear());
    await tx('lists', 'readwrite', (s) => s.clear());
}

// ---- meta ------------------------------------------------------------------

export const getMeta = (key) => get('meta', key);
export const setMeta = (key, value) => put('meta', key, value);
