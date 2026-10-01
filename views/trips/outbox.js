// The drain loop for queued creates. The rules (what runs next, what an answer
// means, how long to wait) are logic.js and tested there; this file only
// moves ops between storage and the network.
//
// One request at a time, which is right for photos on a weak connection, and
// one drainer across tabs (navigator.locks where it exists; the server's
// idempotency covers the rest). Local data is deleted only for an op the
// server has confirmed, or told us is already gone.

import { nextRunnable, classifyResponse, applyOutcome } from './logic.js';
import { call } from './api.js';
import * as store from './storage.js';

/**
 * @param {object} hooks
 * @param {() => number|null} hooks.viewerId   who is signed in now
 * @param {(event) => void} hooks.onChange     after every change to the queue
 */
export function createOutbox({ viewerId, onChange }) {
    let draining = false;
    let timer = null;
    let authPaused = false;

    async function send(op) {
        if (op.kind === 'photo') {
            const blob = await store.getBlob(op.uuid);
            if (!blob) return { ok: false, status: 422, code: 'invalid', offline: false };
            const form = new FormData();
            for (const [k, v] of Object.entries(op.body)) {
                if (v !== null && v !== undefined) form.append(k, String(v));
            }
            form.append('photo', blob, `${op.uuid}.jpg`);
            return call({ resource: 'photo' }, { method: 'POST', form, timeoutMs: 120000 });
        }
        return call({ resource: op.kind }, { method: 'POST', json: op.body });
    }

    async function drainOnce() {
        clearTimeout(timer);
        timer = null;
        for (;;) {
            const viewer = viewerId();
            if (viewer === null || authPaused) return;
            const ops = await store.ops();
            const op = nextRunnable(ops, { now: Date.now(), viewerId: viewer });
            if (!op) {
                schedule(ops, viewer);
                return;
            }
            const res = await send(op);
            const outcome = classifyResponse(res);
            if (outcome === 'auth') {
                authPaused = true;
                onChange({ kind: 'auth' });
                return;
            }
            const { ops: after, removed } = applyOutcome(ops, op.seq, outcome, Date.now(), Math.random());
            if (removed.length) await store.deleteOp(op);
            for (const o of after) {
                const was = ops.find((x) => x.seq === o.seq);
                if (was !== o) await store.putOp(o);
            }
            onChange({ kind: outcome, op, data: res.data, error: res.data?.error ?? null });
            // No connection: every other op would fail the same way. The timer
            // or the next 'online' event picks the queue up again.
            if (res.offline) {
                schedule(after, viewer);
                return;
            }
        }
    }

    function schedule(ops, viewer) {
        const due = ops
            .filter((o) => o.state === 'pending' && o.userId === viewer && o.nextAt > Date.now())
            .map((o) => o.nextAt);
        if (due.length) timer = setTimeout(kick, Math.max(1000, Math.min(...due) - Date.now()));
    }

    async function kick() {
        if (draining) return;
        draining = true;
        try {
            if (navigator.locks?.request) {
                await navigator.locks.request('trips-outbox', { ifAvailable: true }, async (lock) => {
                    if (lock) await drainOnce();
                });
            } else {
                await drainOnce();
            }
        } catch {
            // Storage or network trouble: leave everything queued for next time.
        } finally {
            draining = false;
        }
    }

    return {
        kick,

        /** Queue a create. `blob` is the photo for a photo op. */
        async enqueue(op, blob = null) {
            const full = { state: 'pending', attempts: 0, nextAt: 0, createdAt: Date.now(), ...op };
            await store.addOp(full, blob);
            onChange({ kind: 'queued', op: full });
            kick();
        },

        /** The person asked to try a stalled, failed or blocked op again. */
        async retry(uuid) {
            for (const o of await store.ops()) {
                if (o.uuid === uuid || (o.kind === 'photo' && o.state === 'blocked')) {
                    await store.putOp({ ...o, state: 'pending', attempts: 0, nextAt: 0 });
                }
            }
            authPaused = false;
            onChange({ kind: 'retry' });
            kick();
        },

        /** The person gave up on a queued create. Its photo goes with it. */
        async discard(uuid) {
            const op = (await store.ops()).find((o) => o.uuid === uuid);
            if (op) await store.deleteOp(op);
            onChange({ kind: 'discarded', op });
        },

        async replaceAll(next) {
            for (const o of next) await store.putOp(o);
            onChange({ kind: 'rehomed' });
            kick();
        },

        resumeAfterSignIn() {
            authPaused = false;
            kick();
        },
    };
}
