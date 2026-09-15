// views/list: every decision the list makes, with no DOM in sight.
//
// script.js renders what this file decides. Held by tests/list-logic.test.mjs,
// which also greps app/controllers/list-controller.php for the two rules that
// exist in both languages (nameKey and the default vocabulary).
//
// Named .js, not .mjs, on purpose: Apache serves .mjs without a MIME type and
// browsers refuse to execute it.

/**
 * The starting vocabulary offered by "Dodaj privzete oznake". Mirrors
 * DEFAULT_LABELS in list-controller.php, which is what actually writes them.
 * Sections are in STORE-WALK ORDER, and that order is also the order the list
 * is drawn in, so the page reads like a route through the shop.
 */
export const DEFAULT_LABELS = {
    section: [
        'sadje', 'zelenjava', 'pekarna', 'mlečni izdelki', 'meso in ribe',
        'delikatesa', 'zamrznjeno', 'suha hrana', 'konzerve in omake',
        'prigrizki', 'pijača', 'gospodinjstvo', 'higiena',
    ],
    shop: ['Hofer', 'Lidl', 'Špar', 'Mercator', 'Tuš', 'DM'],
};

/**
 * The identity of a written name: lowercased and whitespace-collapsed, with
 * diacritics KEPT. Mirrors nameKey() in list-controller.php, which writes
 * list_purchases.name_key; if the two drift, "Mleko" and "mleko " stop being
 * one entry in the history.
 */
export function nameKey(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Diacritics stripped, for MATCHING ONLY. Someone typing on a phone keyboard
 * reaches for "spar" and "mlecni", and must land on Špar and mlečni izdelki.
 * Never use this to store or compare a name: see nameKey.
 */
export function fold(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .trim();
}

/**
 * The one label of `kind` that a typed fragment means, or null.
 * Exact match first, then shortest prefix, so a vocabulary containing both
 * "Mer" and "Mercator" resolves "mer" to the one the user actually spelled out.
 */
export function matchLabels(query, labels, kind) {
    const q = fold(query);
    if (!q) return null;
    const pool = (labels || []).filter((l) => l.kind === kind);

    const exact = pool.find((l) => fold(l.name) === q);
    if (exact) return exact;

    const prefixed = pool
        .filter((l) => fold(l.name).startsWith(q))
        .sort((a, b) => a.name.length - b.name.length || a.sort_order - b.sort_order);
    return prefixed[0] || null;
}

/**
 * Reads "mleko #mle #lidl" as a name plus its labels.
 *
 * A token that matches nothing STAYS IN THE NAME: "#2" is a quantity, and
 * silently eating text somebody typed is worse than failing to label. Only one
 * section can win, so the last one named does.
 */
export function parseAddInput(text, labels) {
    const raw = String(text ?? '');
    const kept = [];
    const unmatched = [];
    let sectionId = null;
    const shopIds = [];

    for (const word of raw.split(/\s+/)) {
        if (!word) continue;
        if (!word.startsWith('#') || word.length === 1) {
            kept.push(word);
            continue;
        }
        const query = word.slice(1);
        const shopHit = matchLabels(query, labels, 'shop');
        if (shopHit) {
            if (!shopIds.includes(shopHit.id)) shopIds.push(shopHit.id);
            continue;
        }
        const sectionHit = matchLabels(query, labels, 'section');
        if (sectionHit) {
            sectionId = sectionHit.id;
            continue;
        }
        kept.push(word);
        unmatched.push(query);
    }

    return { name: kept.join(' ').trim(), sectionId, shopIds, unmatched };
}

/**
 * Where a new item's labels come from, in order of how much the person meant
 * them: what they typed or tapped, then what this list bought under that name
 * last time, then the aisle they are standing in (the active filter).
 */
export function resolveNewItemLabels({ typed = {}, memory = null, filter = {} } = {}) {
    const typedShops = Array.isArray(typed.shopIds) ? typed.shopIds : [];
    const memShops = memory && Array.isArray(memory.shopIds) ? memory.shopIds : [];

    let sectionId = typed.sectionId ?? null;
    if (sectionId === null && memory && memory.sectionId != null) sectionId = memory.sectionId;
    if (sectionId === null && filter.sectionId != null) sectionId = filter.sectionId;

    let shopIds = typedShops.length ? typedShops.slice() : [];
    if (!shopIds.length && memShops.length) shopIds = memShops.slice();
    if (!shopIds.length && filter.shopId != null) shopIds = [filter.shopId];

    return { sectionId, shopIds };
}

/**
 * What stays on screen under the active filter.
 *
 * THE RULE THE WHOLE FILTER RESTS ON: a shop filter also shows items that name
 * no shop. An item with no shop means "anywhere", and hiding it while you are
 * standing in Hofer is exactly how you get home without it. A section filter
 * has no such reading (an unplaced item has no aisle), so it is exact.
 */
export function applyFilter(items, { shopId = null, sectionId = null } = {}) {
    return (items || []).filter((item) => {
        if (shopId != null) {
            const shops = item.shops || [];
            if (shops.length && !shops.some((s) => s.id === shopId)) return false;
        }
        if (sectionId != null) {
            if (!item.section || item.section.id !== sectionId) return false;
        }
        return true;
    });
}

/**
 * The order the list is walked in: by aisle, in store order, with unplaced
 * items last, and oldest first inside an aisle. Sorting by when it was typed
 * would scatter one shop's worth of items across the whole page.
 */
export function sortItems(items) {
    const rank = (item) => (item.section ? item.section.sort_order ?? 0 : Number.MAX_SAFE_INTEGER);
    return (items || []).slice().sort((a, b) => {
        const byAisle = rank(a) - rank(b);
        if (byAisle !== 0) return byAisle;
        const byAge = String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
        if (byAge !== 0) return byAge;
        return (a.id ?? 0) - (b.id ?? 0);
    });
}

/**
 * The labels worth offering as filter chips: the ones at least one item still
 * to buy actually carries. Printing the whole vocabulary would put nineteen
 * permanent chips above a four-line list, which is the overstimulating version
 * this is designed against.
 */
export function usedLabels(items, labels) {
    const open = (items || []).filter((i) => !i.checked);
    const sectionIds = new Set();
    const shopIds = new Set();
    for (const item of open) {
        if (item.section) sectionIds.add(item.section.id);
        for (const shop of item.shops || []) shopIds.add(shop.id);
    }
    const pick = (kind, ids) => (labels || [])
        .filter((l) => l.kind === kind && ids.has(l.id))
        .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);

    return { sections: pick('section', sectionIds), shops: pick('shop', shopIds) };
}

/** Up to two initials, from a display name or failing that an email. */
export function initials(user) {
    if (!user) return '';
    const source = String(user.display_name || '').trim() || String(user.email || '').split('@')[0] || '';
    const words = source.split(/[\s._-]+/).filter(Boolean);
    if (!words.length) return '';
    if (words.length === 1) return words[0].charAt(0).toUpperCase();
    // First and last, the way a person's initials are normally read, so a
    // middle name never displaces the surname.
    return (words[0].charAt(0) + words[words.length - 1].charAt(0)).toUpperCase();
}

/**
 * Who a row is signed with: the buyer once it is ticked, the person who added it
 * before that. Every row is signed, your own too, so every row has the same two
 * lines and the names line up; an unsigned row was one line tall and sat higher.
 * A first name is enough on a household list, and the title keeps the full one.
 */
export function attribution(item) {
    const bought = item && item.checked && String(item.checked_by || '').trim();
    const full = bought || String((item && item.added_by) || '').trim();
    if (!full) return null;
    // Older rows stored the email instead of a display name.
    const source = full.includes('@') ? full.split('@')[0] : full;
    const first = source.split(/[\s._-]+/).filter(Boolean)[0] || full;
    const who = full.includes('@') ? first.charAt(0).toUpperCase() + first.slice(1) : first;
    return { who, title: `${bought ? 'Kupil/a' : 'Dodal/a'} ${full}` };
}

/**
 * Reads a MySQL DATETIME(3) as LOCAL time.
 * `new Date('2026-09-11 23:30:00')` is parsed inconsistently across browsers
 * and as UTC in some, which files a late-evening shop under the wrong day.
 */
function parseSqlDateTime(value) {
    const m = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}

function isoDay(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Today in LOCAL time. The UTC slice is a day behind every CET/CEST morning. */
export function todayIso(now = new Date()) {
    return isoDay(now);
}

/**
 * Day-first, always: "danes", "včeraj", "9. 9.", "24. 12. 2025". Month-first
 * would read as a different date to half of Europe, which is the same reason
 * this repo bans the native date input.
 */
export function formatDaySl(value, today) {
    const date = parseSqlDateTime(value);
    if (!date) return '';
    const day = isoDay(date);
    if (day === today) return 'danes';

    const yesterday = new Date(`${today}T12:00:00`);
    yesterday.setDate(yesterday.getDate() - 1);
    if (day === isoDay(yesterday)) return 'včeraj';

    const sameYear = date.getFullYear() === Number(String(today).slice(0, 4));
    return sameYear
        ? `${date.getDate()}. ${date.getMonth() + 1}.`
        : `${date.getDate()}. ${date.getMonth() + 1}. ${date.getFullYear()}`;
}

/** 24 hour, minutes zero-padded. */
export function formatTimeSl(value) {
    const date = parseSqlDateTime(value);
    if (!date) return '';
    return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** History as trips: one group per day, newest first, order within preserved. */
export function groupByDay(purchases, today) {
    const days = [];
    const index = new Map();
    for (const purchase of purchases || []) {
        const date = parseSqlDateTime(purchase.bought_at);
        const key = date ? isoDay(date) : 'unknown';
        if (!index.has(key)) {
            const group = { key, label: formatDaySl(purchase.bought_at, today), purchases: [] };
            index.set(key, group);
            days.push(group);
        }
        index.get(key).purchases.push(purchase);
    }
    return days;
}

/**
 * Drops a filter whose label nobody is using any more, so the list cannot sit
 * empty for a reason that has scrolled off the side of the chip row.
 *
 * `loaded` is the whole point of the signature. On the first paint after a
 * reload the items have not arrived, every label looks unused, and pruning
 * then would wipe the filter the person deliberately left running.
 */
export function pruneFilter(filter, used, { loaded = true } = {}) {
    const next = { shopId: filter.shopId ?? null, sectionId: filter.sectionId ?? null };
    if (!loaded) return next;
    if (next.shopId != null && !(used.shops || []).some((l) => l.id === next.shopId)) next.shopId = null;
    if (next.sectionId != null && !(used.sections || []).some((l) => l.id === next.sectionId)) next.sectionId = null;
    return next;
}

/** A remembered filter belongs to one list, never to the app as a whole. */
export function filterStorageKey(collection) {
    return `list:filter:${nameKey(collection)}`;
}
