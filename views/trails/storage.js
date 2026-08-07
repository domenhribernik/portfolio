// On-device flight store for Trails. IndexedDB rather than localStorage
// because a ten-hour flight is 8-12 000 fixes: localStorage would blow its
// ~5 MB quota and, worse, it can only rewrite the whole track on every fix.
//
// The crash-safety rule this file exists to keep: an accepted fix is written
// as one small `add()` in its own transaction, so nothing is ever held in
// memory waiting to be flushed. Close the tab mid-flight, run out of battery,
// let the browser evict the tab, and every fix already stored is still there.
//
// Everything is promise-shaped and nothing throws: Safari in private mode
// refuses to open a database at all, so the whole API silently degrades to an
// in-memory store that lasts for the session. Recording still works; the page
// warns that it will not survive being closed.

const DB_NAME = 'trails';
const DB_VERSION = 1;

let db = null;
let memory = null; // populated only when IndexedDB is unavailable

/** Resolves true when flights persist, false when this session is in-memory only. */
export const storageReady = openDatabase();

function openDatabase() {
    return new Promise((resolve) => {
        let request;
        try {
            if (!self.indexedDB) throw new Error('no indexedDB');
            request = self.indexedDB.open(DB_NAME, DB_VERSION);
        } catch {
            memory = emptyMemory();
            resolve(false);
            return;
        }

        request.onupgradeneeded = () => {
            const idb = request.result;
            if (!idb.objectStoreNames.contains('flights')) {
                const flights = idb.createObjectStore('flights', { keyPath: 'id' });
                flights.createIndex('by-startedAt', 'startedAt');
            }
            if (!idb.objectStoreNames.contains('points')) {
                const points = idb.createObjectStore('points', { autoIncrement: true });
                points.createIndex('by-flight', 'flightId');
            }
            if (!idb.objectStoreNames.contains('meta')) {
                idb.createObjectStore('meta');
            }
        };
        request.onsuccess = () => {
            db = request.result;
            // Safari can drop a connection out from under a long session.
            db.onclose = () => { db = null; memory = memory || emptyMemory(); };
            resolve(true);
        };
        request.onerror = () => { memory = emptyMemory(); resolve(false); };
        request.onblocked = () => { memory = emptyMemory(); resolve(false); };
    });
}

const emptyMemory = () => ({ flights: new Map(), points: [], meta: new Map() });

/** Run `fn` against a store and resolve with its result, or null on any failure. */
function tx(store, mode, fn) {
    return new Promise((resolve) => {
        if (!db) { resolve(null); return; }
        let request;
        try {
            const transaction = db.transaction(store, mode);
            transaction.onabort = () => resolve(null);
            transaction.onerror = () => resolve(null);
            request = fn(transaction.objectStore(store));
        } catch {
            resolve(null);
            return;
        }
        if (!request) { resolve(null); return; }
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
    });
}

// --- flights ---------------------------------------------------------------

/** Store a new flight and return it. */
export async function createFlight(flight) {
    await storageReady;
    if (memory) { memory.flights.set(flight.id, { ...flight }); return flight; }
    await tx('flights', 'readwrite', (s) => s.put(flight));
    return flight;
}

/** Merge `patch` into a stored flight, stamping updatedAt. Returns the new row. */
export async function updateFlight(id, patch) {
    await storageReady;
    const current = await getFlight(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: patch.updatedAt ?? Date.now() };
    if (memory) { memory.flights.set(id, next); return next; }
    await tx('flights', 'readwrite', (s) => s.put(next));
    return next;
}

/** One flight by id, or null. */
export async function getFlight(id) {
    await storageReady;
    if (memory) return memory.flights.get(id) || null;
    return (await tx('flights', 'readonly', (s) => s.get(id))) || null;
}

/** Every flight, tombstones included. Sync needs the tombstones; the UI does not. */
export async function listAllFlights() {
    await storageReady;
    const all = memory
        ? [...memory.flights.values()]
        : (await tx('flights', 'readonly', (s) => s.getAll())) || [];
    return all.sort((a, b) => b.startedAt - a.startedAt);
}

/** Every flight that has not been deleted, newest first. */
export async function listFlights() {
    return (await listAllFlights()).filter((f) => !f.deletedAt);
}

/**
 * Tombstone a flight. The row survives so the next sync can tell the server
 * it was deleted; a row simply vanishing would be re-downloaded forever.
 */
export async function markDeleted(id) {
    return updateFlight(id, { deletedAt: Date.now() });
}

/** Remove a flight and its whole track for good. */
export async function purgeFlight(id) {
    await storageReady;
    if (memory) {
        memory.flights.delete(id);
        memory.points = memory.points.filter((p) => p.flightId !== id);
        return;
    }
    await tx('flights', 'readwrite', (s) => s.delete(id));
    await deletePointsOf(id);
}

function deletePointsOf(flightId) {
    return new Promise((resolve) => {
        if (!db) { resolve(); return; }
        try {
            const transaction = db.transaction('points', 'readwrite');
            const cursor = transaction.objectStore('points').index('by-flight')
                .openCursor(IDBKeyRange.only(flightId));
            cursor.onsuccess = () => {
                const c = cursor.result;
                if (!c) return;
                c.delete();
                c.continue();
            };
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => resolve();
            transaction.onabort = () => resolve();
        } catch { resolve(); }
    });
}

// --- points ----------------------------------------------------------------

/**
 * Append one fix. Deliberately one tiny transaction per fix (about one every
 * three seconds) rather than a buffered batch, so a crash loses nothing.
 */
export async function appendPoint(point) {
    await storageReady;
    if (memory) { memory.points.push(point); return; }
    await tx('points', 'readwrite', (s) => s.add(point));
}

/** A flight's whole track in time order. */
export async function getPoints(flightId) {
    await storageReady;
    let rows;
    if (memory) {
        rows = memory.points.filter((p) => p.flightId === flightId);
    } else {
        rows = await new Promise((resolve) => {
            if (!db) { resolve([]); return; }
            try {
                const transaction = db.transaction('points', 'readonly');
                const request = transaction.objectStore('points').index('by-flight')
                    .getAll(IDBKeyRange.only(flightId));
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => resolve([]);
            } catch { resolve([]); }
        });
    }
    // Insertion order already matches time, but a resumed flight can interleave.
    return rows.sort((a, b) => a.t - b.t);
}

/** Replace a flight's track wholesale, used when pulling one from the server. */
export async function replacePoints(flightId, points) {
    await storageReady;
    if (memory) {
        memory.points = memory.points.filter((p) => p.flightId !== flightId);
        memory.points.push(...points.map((p) => ({ ...p, flightId })));
        return;
    }
    await deletePointsOf(flightId);
    await new Promise((resolve) => {
        if (!db) { resolve(); return; }
        try {
            const transaction = db.transaction('points', 'readwrite');
            const store = transaction.objectStore('points');
            for (const p of points) store.add({ ...p, flightId });
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => resolve();
            transaction.onabort = () => resolve();
        } catch { resolve(); }
    });
}

// --- meta ------------------------------------------------------------------

/** A small keyed value: which flight is recording, when sync last ran. */
export async function getMeta(key) {
    await storageReady;
    if (memory) return memory.meta.get(key) ?? null;
    const value = await tx('meta', 'readonly', (s) => s.get(key));
    return value === undefined ? null : value;
}

export async function setMeta(key, value) {
    await storageReady;
    if (memory) { memory.meta.set(key, value); return; }
    await tx('meta', 'readwrite', (s) => s.put(value, key));
}
