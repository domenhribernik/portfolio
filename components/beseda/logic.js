/**
 * DOM-free logic shared by the Beseda page (views/beseda) and the widget
 * embedded on views/iliana. Both surfaces must always agree on which word
 * today is and how long the streak is, which only holds if there is one
 * implementation, so keep this file free of browser globals: node imports it
 * directly in tests/beseda-logic.test.mjs.
 *
 * `now` is an injected, defaulted parameter throughout so the date maths is
 * deterministic under test.
 */

const pad2 = (n) => String(n).padStart(2, '0');

/** Today as ISO yyyy-mm-dd in the learner's own timezone, never UTC. */
export function todayIso(now = new Date()) {
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse yyyy-mm-dd to a UTC timestamp, or NaN if it is not a real date. */
function utcOf(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return NaN;
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const stamp = Date.UTC(year, month - 1, day);
    // Date.UTC rolls 2026-02-31 forward into March; reject rather than accept.
    const back = new Date(stamp);
    if (back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return NaN;
    return stamp;
}

/**
 * Whole days from `epochIso` to `iso`, negative before the epoch.
 * Anchored in UTC so a daylight saving change cannot swallow a day.
 */
export function dayNumber(iso, epochIso) {
    return Math.round((utcOf(iso) - utcOf(epochIso)) / DAY_MS);
}

/**
 * Cut a sentence into renderable pieces: [{ text, wordIndex }], where a null
 * wordIndex means plain text with no tooltip.
 *
 * The gaps between spans (spaces, punctuation) are emitted too, so joining
 * every `text` reproduces the sentence exactly. Anything dropped here is a
 * missing word on the page.
 */
export function glossSegments(sentence) {
    const [text, , spans = []] = sentence;
    const segments = [];
    let cursor = 0;
    for (const [start, end, wordIndex] of spans) {
        if (start > cursor) segments.push({ text: text.slice(cursor, start), wordIndex: null });
        segments.push({ text: text.slice(start, end), wordIndex: wordIndex === -1 ? null : wordIndex });
        cursor = end;
    }
    if (cursor < text.length) segments.push({ text: text.slice(cursor), wordIndex: null });
    return segments;
}

/** How far ahead of the reference day a stored day may legitimately be. */
const FUTURE_TOLERANCE_DAYS = 1;
/** Roughly three years; longer than anyone's streak and short enough to stay small. */
const MAX_AGE_DAYS = 1100;

/**
 * Keep only the entries that are real, sorted, deduplicated dates.
 *
 * Applied to whatever comes back from localStorage and from the server, since
 * both can hold anything: hand-edited storage, a stale schema, or a clock that
 * has since been corrected. A day slightly in the future is kept because a
 * learner whose device is ahead of the server really is on the next day.
 */
export function validDays(days, today) {
    if (!Array.isArray(days)) return [];
    const seen = new Set();
    for (const day of days) {
        if (typeof day !== 'string' || !Number.isFinite(utcOf(day))) continue;
        const offset = dayNumber(day, today);
        if (offset > FUTURE_TOLERANCE_DAYS || offset < -MAX_AGE_DAYS) continue;
        seen.add(day);
    }
    return [...seen].sort();
}

/** Mark a day as practised. */
export function addDay(days, day) {
    return [...new Set([...days, day])].sort();
}

/** Union of two histories, for merging the browser's days into the account's. */
export function mergeDays(a, b) {
    return [...new Set([...(a || []), ...(b || [])])].sort();
}

/**
 * Current streak, longest streak, and whether today is already done.
 *
 * The current streak is the unbroken run ending today, or ending yesterday if
 * today has not been practised yet: a streak is not lost until the day is,
 * otherwise the page would announce a broken streak every morning.
 */
export function streakStats(days, today) {
    const unique = [...new Set(days)].filter((d) => Number.isFinite(utcOf(d))).sort();
    if (!unique.length) return { current: 0, longest: 0, activeToday: false };

    let longest = 1;
    let run = 1;
    for (let i = 1; i < unique.length; i += 1) {
        run = dayNumber(unique[i], unique[i - 1]) === 1 ? run + 1 : 1;
        if (run > longest) longest = run;
    }

    const last = unique[unique.length - 1];
    const sinceLast = dayNumber(today, last);
    let current = 0;
    if (sinceLast === 0 || sinceLast === 1) {
        current = 1;
        for (let i = unique.length - 1; i > 0; i -= 1) {
            if (dayNumber(unique[i], unique[i - 1]) !== 1) break;
            current += 1;
        }
    }
    return { current, longest, activeToday: sinceLast === 0 };
}

/**
 * The word scheduled for `iso`, as { wordIndex, sentences }, or null if there
 * is nothing to show.
 *
 * The schedule is indexed directly rather than cycled, which is what stops a
 * rebuild that appends more days from re-dating words people have already
 * seen. Wrapping is the last resort for a schedule that ran out; every client
 * holds the same file and so wraps to the same word.
 */
export function wordOfTheDay(daily, iso) {
    const days = (daily && daily.days) || [];
    if (!days.length) return null;
    const n = dayNumber(iso, daily.epoch);
    if (!Number.isFinite(n) || n < 0) return null;
    const [wordIndex, sentences] = days[n < days.length ? n : n % days.length];
    return { wordIndex, sentences: sentences || [] };
}
