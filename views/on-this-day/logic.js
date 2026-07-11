// DOM-free decision logic for the On This Day almanac page, unit-tested by
// tests/on-this-day-logic.test.mjs (node --test tests/). The page's script.js
// imports this as an ES module.

// Split the featured "front page" dispatches into a single lead story plus the
// rest that flow into the slider beneath it. The lead is the first dispatch
// that carries an image (so the big broadsheet slot is always illustrated);
// if none has one, the first dispatch leads. The remaining dispatches keep
// their original chronological order. Never mutates the input.
export function splitFeatured(items) {
    if (!Array.isArray(items) || items.length === 0) return { lead: null, rest: [] };
    const leadIndex = Math.max(0, items.findIndex((it) => pickImage(it && it.pages)));
    const lead = items[leadIndex];
    const rest = items.filter((_, i) => i !== leadIndex);
    return { lead, rest };
}

// First usable thumbnail across a dispatch's linked Wikipedia pages, or null.
export function pickImage(pages) {
    if (!Array.isArray(pages)) return null;
    const withImage = pages.find((p) => p && p.thumbnail && p.thumbnail.source);
    return withImage ? withImage.thumbnail.source : null;
}

// Canonical Wikipedia URL for a dispatch: the API's desktop page link when
// present, otherwise one reconstructed from the first page's title. Null when
// the dispatch links nowhere.
export function pickPageUrl(pages) {
    if (!Array.isArray(pages) || pages.length === 0) return null;
    const page = pages[0];
    if (!page) return null;
    const direct = page.content_urls && page.content_urls.desktop && page.content_urls.desktop.page;
    if (direct) return direct;
    return page.title ? `https://en.wikipedia.org/wiki/${page.title}` : null;
}

// The first page's rich summary HTML for a dispatch, or null.
export function pickExtractHtml(pages) {
    if (!Array.isArray(pages) || pages.length === 0) return null;
    return (pages[0] && pages[0].extract_html) || null;
}

// A record entry ("Neil Armstrong, American astronaut") reads as a bold
// headline followed by one line of context. Split on the first natural break
// (comma, colon, or a trailing parenthetical), falling back to the whole line
// as the headline when nothing separates them.
const ENTRY_PATTERNS = [/^([^,]+),\s*(.+)$/, /^([^:]+):\s*(.+)$/, /^(.+?\([^)]+\))\s*,?\s*(.+)$/];
export function splitEntry(text) {
    const line = (text || '').trim();
    for (const pattern of ENTRY_PATTERNS) {
        const match = line.match(pattern);
        if (match) return { title: match[1].trim(), description: match[2].trim() };
    }
    return { title: line, description: '' };
}

// Ordinal day within the year (Jan 1 = 1), for the masthead's "Day 158 / 365".
export function dayOfYear(date) {
    const startOfYear = new Date(date.getFullYear(), 0, 0);
    return Math.floor((date - startOfYear) / 86400000);
}

// Zero-pad a small count to two digits ("06"), for the hero + tab counters.
export function pad2(n) {
    return String(n ?? 0).padStart(2, '0');
}
