/* Everbloom storefront: pure decision logic, no DOM, so it can be unit-tested
   (tests/store-logic.test.mjs) and shared by script.js. The PHP endpoint
   (app/proxys/store.php) mirrors the signup rules; client checks are only a
   courtesy, the server is the real gate. */

import { MAX_STEMS } from '../flowers/logic.js';

export const LIMITS = { email: 255, note: 500 };

export const PLAN_KEYS = ['forever', 'petal-post', 'curious'];

/* One source of truth for every number the page prints. */
export const PRICING = {
    forever: 9,        // EUR, one-time
    monthly: 4,        // EUR/mo, founding price
    monthlyAfter: 6,   // EUR/mo once founding spots are gone
    annual: 36,        // EUR/yr
    foundingCap: 100,  // founding subscriptions at the locked price
};

/* The hero bouquet. Kept here (not in script.js) so a test can hold it to the
   builder's contract: known species only, total within MAX_STEMS. */
export const HERO_ORDER = [
    { type: 'rose', count: 3 },
    { type: 'peony', count: 2 },
    { type: 'daisy', count: 2 },
    { type: 'lavender', count: 2 },
];

export { MAX_STEMS };

// Same deliberately loose shape as the homepage contact form: one @, a dot in
// the domain, no spaces. Delivery proves validity, not regex.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateSignup(input) {
    const clean = {
        email: String(input?.email ?? '').trim(),
        plan: String(input?.plan ?? '').trim(),
        note: String(input?.note ?? '').trim(),
    };
    const errors = {};

    if (!clean.email) {
        errors.email = 'Add an email so I can save your spot.';
    } else if (clean.email.length > LIMITS.email || !EMAIL_RE.test(clean.email)) {
        errors.email = 'That email looks off, mind checking it?';
    }

    if (!PLAN_KEYS.includes(clean.plan)) {
        errors.plan = 'Pick one of the three.';
    }

    if (clean.note.length > LIMITS.note) {
        errors.note = `Keep it under ${LIMITS.note} characters.`;
    }

    return { valid: Object.keys(errors).length === 0, errors, clean };
}

/* Honest scarcity: the founding line only counts what the server actually
   counted. Below `visibleFrom` claimed spots we don't print a number at all
   (a near-zero counter reads worse than none), and a full list flips the copy
   instead of pretending spots remain. */
export function spotsLine(count, cap = PRICING.foundingCap, visibleFrom = 10) {
    const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (n >= cap) {
        return { text: 'Founding spots are gone. Join the list for the open price.', full: true };
    }
    if (n >= visibleFrom) {
        return { text: `${n} of ${cap} founding spots claimed.`, full: false };
    }
    return { text: `${cap} founding spots. ${PRICING.monthly} EUR/mo, locked for life.`, full: false };
}

/* 4 EUR/mo vs 36 EUR/yr -> 25 (percent saved going annual). */
export function annualSavingsPercent(monthly = PRICING.monthly, annual = PRICING.annual) {
    if (monthly <= 0) return 0;
    return Math.round((1 - annual / (monthly * 12)) * 100);
}
