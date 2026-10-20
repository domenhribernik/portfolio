// views/wishlist: every decision the wish list makes, with no DOM in sight.
//
// script.js renders what this file decides. Held by tests/wishlist-logic.test.mjs.
//
// Named .js, not .mjs, on purpose: Apache serves .mjs without a MIME type and
// browsers refuse to execute it.

/**
 * Field caps. Mirrored as constants in wishlist-controller.php, which is what
 * actually enforces them; tests/wishlist-logic.test.mjs fails if they drift.
 */
export const NAME_MAX = 160;
export const NOTE_MAX = 2000;
export const URL_MAX = 2048;
export const QTY_MAX = 20;

/**
 * What an editor is allowed to save, normalised the way the controller will
 * store it. A link becomes a tappable href for every guest, so anything other
 * than http(s) is refused rather than escaped; a bare "shop.de/thing" is read
 * as https because that is what a person pasting it meant.
 *
 * Returns { ok, errors: { field: message }, value }.
 */
export function validateDraft(draft) {
    const errors = {};

    const name = String(draft.name ?? '').trim();
    if (!name) errors.name = 'Give it a name.';
    else if (name.length > NAME_MAX) errors.name = `Keep the name under ${NAME_MAX} characters.`;

    let url = String(draft.url ?? '').trim() || null;
    if (url !== null) {
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
        if (!isWebLink(url)) errors.url = 'That doesn\'t look like a web link.';
        else if (url.length > URL_MAX) errors.url = 'That link is too long.';
    }

    const note = String(draft.note ?? '').trim() || null;
    if (note !== null && note.length > NOTE_MAX) {
        errors.note = `Keep the note under ${NOTE_MAX} characters.`;
    }

    const quantity = draft.quantity === undefined || draft.quantity === '' ? 1 : Number(draft.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > QTY_MAX) {
        errors.quantity = `Between 1 and ${QTY_MAX}.`;
    }

    return {
        ok: Object.keys(errors).length === 0,
        errors,
        value: { name, url, note, quantity },
    };
}

/** "amazon.de" for a guest to see where a link goes, or '' if it is not one. */
export function domainLabel(url) {
    try {
        return new URL(url).hostname.replace(/^(www|m)\./i, '');
    } catch {
        return '';
    }
}

/**
 * A shop's page title cut down to a name. Shop titles are keyword lists
 * ("Nudelsieb - Nudelsieb Edelstahl als Abgiesshilfe ... - Flaches ..."), so
 * the name is the first phrase: everything before the first spaced dash, bar,
 * colon or comma. A hyphen inside a word ("Kontakt- und") is not a separator.
 * The editor can still rewrite whatever this suggests.
 */
export function shortTitle(title) {
    let text = String(title ?? '').replace(/\s+/g, ' ').trim();
    text = text.replace(/^amazon\.[a-z.]+\s*:\s*/i, '');
    const first = text.split(/\s[-\u2013\u2014|:]\s|,\s/)[0].trim();
    if (first.length >= 3) text = first;
    if (text.length <= NAME_MAX) return text;
    const cut = text.slice(0, NAME_MAX + 1);
    const space = cut.lastIndexOf(' ');
    return (space > 0 ? cut.slice(0, space) : cut.slice(0, NAME_MAX)).trim();
}

function isWebLink(value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        return false;
    }
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
        && parsed.hostname.includes('.')
        && !/\s/.test(value);
}

/**
 * How much of an item is still wanted, and whether this browser holds one of
 * its claims. An item asks for `quantity` units and every claim covers exactly
 * one, so a pair of jar sets stays open until two people have said they will
 * bring one.
 *
 * `tokens` is this browser's { claimId: token } map. Claims are anonymous, so
 * holding the token is the whole of "mine": it is what lets Undo work without
 * an editor. `mine` is that claim's id, or null.
 */
export function itemState(item, tokens = {}) {
    const claims = item.claims || [];
    const wanted = Math.max(1, item.quantity | 0);
    const taken = Math.min(wanted, claims.length);
    const remaining = wanted - taken;
    const mine = claims.find((id) => Object.hasOwn(tokens, id)) ?? null;
    return { wanted, taken, remaining, open: remaining > 0, mine };
}

/**
 * This browser's remembered claims, minus any that no longer exist. An editor
 * can reset a claim, and a token for a claim that is gone would otherwise sit
 * in storage forever. Only call it with a FULL list from the server: a claim
 * missing from a partial list is not a reset one.
 */
export function pruneTokens(tokens, items) {
    const live = new Set(items.flatMap((item) => (item.claims || []).map(String)));
    return Object.fromEntries(Object.entries(tokens).filter(([id]) => live.has(id)));
}

/**
 * The list as a guest reads it: what still needs someone first, in the order
 * the editor set, and what is already covered below it, with the things this
 * browser is bringing at the top of that.
 *
 * `keep` holds ids claimed on this page view. They stay where they were until
 * the next visit: an item that jumped to the bottom the moment it was tapped
 * would vanish from under the thumb that tapped it, Undo and all.
 */
export function groupForDisplay(items, tokens = {}, keep = new Set()) {
    const needed = [];
    const mine = [];
    const others = [];
    for (const item of items) {
        const state = itemState(item, tokens);
        if (state.open || keep.has(item.id)) needed.push(item);
        else (state.mine !== null ? mine : others).push(item);
    }
    return { needed, taken: [...mine, ...others] };
}

/** The header tally. Counts items, not units: a pair of jars is one line. */
export function neededCount(items) {
    return {
        needed: items.filter((item) => itemState(item).open).length,
        total: items.length,
    };
}
