// The Drawing Room's DOM-free decision logic: everything script.js needs to
// think (codes, names, stroke packing, the event reducer, poll pacing) with
// no browser APIs, so node --test tests/ can exercise it directly.

// ------------------------------------------------------------------
//  Inks
// ------------------------------------------------------------------

// One ink per guest, assigned by the server as palette indexes 0..9.
// Index -1 is the india rubber: it paints with the paper color, so erasing
// is just another stroke and replays like one.
export const INKS = [
    '#2b3a67', // indigo
    '#b2332e', // carmine
    '#2d6a4f', // viridian
    '#7d3c98', // violet
    '#b9770e', // ochre
    '#14757a', // peacock
    '#b74d6d', // rose madder
    '#5e7b1e', // moss
    '#7a4a1f', // sepia
    '#3f88c5', // cerulean
];

// The sheet color. The canvas is filled with this, so must anything that
// wants to look like "no ink" (the eraser).
export const PAPER = '#f6efdc';

export function inkColor(index) {
    if (index === -1) return PAPER;
    return INKS[index] ?? INKS[0];
}

// ------------------------------------------------------------------
//  Codes and names
// ------------------------------------------------------------------

export function normalizeCode(raw) {
    return String(raw ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}

export function isValidCode(code) {
    return /^[A-Z]{4}$/.test(code ?? '');
}

// Mirrors validateGuestName in parlour-controller.php.
export function cleanName(raw) {
    return String(raw ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function isValidName(raw) {
    const n = Array.from(cleanName(raw)).length;
    return n >= 1 && n <= 20;
}

export function initials(name) {
    const words = cleanName(name).split(' ').filter(Boolean);
    if (words.length === 0) return '?';
    const first = Array.from(words[0])[0];
    const last = words.length > 1 ? Array.from(words[words.length - 1])[0] : '';
    return (first + last).toUpperCase();
}

// ------------------------------------------------------------------
//  The shared sheet and stroke packing
// ------------------------------------------------------------------

// Logical sheet size; every client letterboxes this into its own canvas so
// all guests see the identical picture. Must match parlour-controller.php.
export const SHEET_W = 1500;
export const SHEET_H = 1000;
const MAX_CHUNK_POINTS = 600;
const THIN_DIST_SQ = 2 * 2;

/**
 * Prepares one flush of pen movement for the wire: drops points closer than
 * ~2 sheet units to the last kept one (the eye cannot tell), keeps the final
 * resting point, clamps everything onto the sheet, and rounds to integers.
 * In and out are flat [x0, y0, x1, y1, ...] arrays.
 */
export function packChunk(rawPts) {
    const kept = [];
    let lastX = null;
    let lastY = null;
    const pairs = Math.min(Math.floor(rawPts.length / 2), MAX_CHUNK_POINTS);
    for (let i = 0; i < pairs; i++) {
        const x = rawPts[i * 2];
        const y = rawPts[i * 2 + 1];
        const isLast = i === pairs - 1;
        if (lastX !== null && !isLast) {
            const dx = x - lastX;
            const dy = y - lastY;
            if (dx * dx + dy * dy < THIN_DIST_SQ) continue;
        }
        kept.push(
            Math.max(0, Math.min(SHEET_W, Math.round(x))),
            Math.max(0, Math.min(SHEET_H, Math.round(y))),
        );
        lastX = x;
        lastY = y;
    }
    return kept;
}

// ------------------------------------------------------------------
//  The reducer: poll events in, paint instructions out
// ------------------------------------------------------------------

export function createModel() {
    return { status: 'lobby', lastSeq: 0, strokes: new Map(), order: [] };
}

/** Registers ink you just put down yourself, so the server echo is a no-op. */
export function addLocalChunk(model, { sid, ink, size, pts, end }) {
    appendChunk(model, { sid, ink, size, pts, end, local: true });
}

function appendChunk(model, { sid, ink, size, pts, end, local = false }) {
    let s = model.strokes.get(sid);
    if (!s) {
        s = { sid, ink, size, pts: [], end: false, local };
        model.strokes.set(sid, s);
        model.order.push(sid);
    }
    const from = s.pts.length;
    s.pts.push(...pts);
    if (end) s.end = true;
    return from;
}

/**
 * Folds one page of poll events into the model and returns paint ops for the
 * renderer: {op:'draw', sid, from} means "stroke sid grew, paint it from
 * point-array index from", plus {op:'clear'} and {op:'start'}. Events of
 * unknown type are ignored (a newer server may speak more of them), but the
 * cursor still advances past everything.
 */
export function applyEvents(model, events, selfId) {
    const ops = [];
    for (const ev of events) {
        model.lastSeq = Math.max(model.lastSeq, ev.seq);
        if (ev.type === 'stroke') {
            const d = ev.data ?? {};
            const mine = ev.guest === selfId;
            const existing = model.strokes.get(d.sid);
            if (mine && existing?.local) {
                // Our own ink coming back around; it is already on the canvas.
                if (d.end) existing.end = true;
                continue;
            }
            const from = appendChunk(model, d);
            ops.push({ op: 'draw', sid: d.sid, from });
        } else if (ev.type === 'clear') {
            model.strokes.clear();
            model.order.length = 0;
            ops.push({ op: 'clear' });
        } else if (ev.type === 'start') {
            model.status = 'live';
            ops.push({ op: 'start' });
        }
    }
    return ops;
}

// ------------------------------------------------------------------
//  Poll pacing
// ------------------------------------------------------------------

/**
 * How long to wait before the next poll. Fast while ink is flying, lazier
 * in the lobby or when nobody has drawn for a while, slow for hidden tabs,
 * and exponentially patient (capped) when requests are failing.
 */
export function pollDelay({ status, hidden, msSinceActivity, failures }) {
    if (failures > 0) return Math.min(10000, 800 * 2 ** failures);
    if (hidden) return 3000;
    if (status !== 'live') return 1000;
    return msSinceActivity < 20000 ? 450 : 1600;
}
