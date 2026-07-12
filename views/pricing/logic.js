'use strict';

// Pure, DOM-free pricing logic for the quote calculator: tier selection,
// price calculation and form validation. Imported by script.js and by
// tests/pricing-logic.test.mjs. Text never lives here: line items and
// validation errors come back as i18n keys (see views/pricing/lang/*.json
// under the "items" and "errors" namespaces) so the DOM layer can localize
// them via i18n.js.

export function pageCount(pagesValue) {
    const map = { '1': 1, '2-3': 3, '4-6': 6, '7-12': 12, '13+': 13 };
    return map[pagesValue] || 1;
}

// Escalation order matters: CUSTOM triggers outrank PREMIUM, which outranks
// PLUS, which outranks the MINI carve-out. Checked highest tier first.
export function suggestTier(s) {
    const features = s.features || [];
    const shop     = s.shop     || [];
    const purpose  = s.purpose  || [];

    // CUSTOM triggers
    if (purpose.includes('app')) return 'CUSTOM';
    if (features.includes('accounts') || features.includes('api') || features.includes('booking')) return 'CUSTOM';
    if (shop.length > 0) return 'CUSTOM';

    // PREMIUM triggers
    if (s.design === 'full')      return 'PREMIUM';
    if (s.languages && s.languages !== '1') return 'PREMIUM';
    if (s.cms === 'yes')          return 'PREMIUM';

    // PLUS triggers
    if (features.includes('blog')) return 'PLUS';
    if (s.logo)                    return 'PLUS';
    if (s.design === 'semi')       return 'PLUS';
    if (s.pages === '4-6' || s.pages === '7-12' || s.pages === '13+') return 'PLUS';

    // MINI trigger: only if 1 page, no domain/hosting
    if (s.pages === '1' && s.hosting === 'own') return 'MINI';

    return 'BASIC';
}

// Source of truth for every base price and à-la-carte add-on.
export const PRICES = {
    baseMini:    300,
    baseBasic:   490,
    designSemi:  180,
    designFull:  350,
    logo:        120,
    extraPage:   40,
    copywriting: 40, // per page
    language:    120,
    cms:         180,
    map:         30,
    gallery:     60,
    blog:        150,
    newsletter:  60,
    chat:        50,
    booking:     400, // minimum, custom quote
    accounts:    500, // minimum, custom quote
    api:         250, // minimum, custom quote
    shopSetup:   600,
    payments:    150,
    orders:      200,
    extraProduct: 3,
    seo:         180,
    analytics:   60,
    speed:       100,
    security:    80,
};

// The "which features" checkbox group, in PRICES lookup terms. Features
// whose real cost needs a manual quote (CUSTOM_FEATURES) have PRICES hold
// only their floor.
const FEATURE_KEYS = ['map', 'gallery', 'blog', 'newsletter', 'chat', 'booking', 'accounts', 'api'];
const CUSTOM_FEATURES = new Set(['booking', 'accounts', 'api']);

// The "online shop details" checkbox group. Every shop add-on needs a real
// scoping conversation, so all of them are custom-quote floors. The 'setup'
// checkbox value maps to the shopSetup price/translation key; the rest are
// already 1:1 with PRICES.
const SHOP_PRICE_KEYS = { setup: 'shopSetup', payments: 'payments', orders: 'orders' };

const MARKETING_KEYS = ['seo', 'analytics', 'speed', 'security'];

// Pages included free in each tier's base price.
export const PAGES_INCLUDED = { MINI: 1, BASIC: 3, PLUS: 6, PREMIUM: 12, CUSTOM: 999 };

// Marketing anchor prices shown on the package cards ("FROM €X"). These are
// round, sales-facing numbers, not a sum of PRICES: see /plan.md for the
// decoy-pricing rationale (Mini/Basic bait, Plus the hero, Premium the
// anchor, Custom uncapped).
export const PACKAGE_FROM = { MINI: 300, BASIC: 490, PLUS: 890, PREMIUM: 1600, CUSTOM: 2500 };

// Monthly ongoing-support retainer prices, offered once a quote is ready.
export const SUPPORT_PRICES = { basic: 25, advanced: 60 };

// The loading-screen terminal transcript: delay in ms from the start of the
// sequence, message key under lang/<code>.json's loading.steps, and whether
// it renders as a "$ " prompt line or an indented continuation line.
export const LOADING_STEPS = [
    { key: 'analysing',            delay: 0,     type: 'prompt' },
    { key: 'readingScope',         delay: 1200,  type: 'line' },
    { key: 'checkingDeps',         delay: 2400,  type: 'line' },
    { key: 'selecting',            delay: 3800,  type: 'prompt' },
    { key: 'comparing',            delay: 5200,  type: 'line' },
    { key: 'escalation',           delay: 6800,  type: 'line' },
    { key: 'calculatingBreakdown', delay: 8200,  type: 'prompt' },
    { key: 'summing',              delay: 9600,  type: 'line' },
    { key: 'minimums',             delay: 11000, type: 'line' },
    { key: 'finalising',           delay: 12500, type: 'prompt' },
    { key: 'receipt',              delay: 14000, type: 'line' },
];

// Each line item is { key, price, isBase?, isCustom?, params? }. `key` names
// a translation under the "items" namespace in lang/<code>.json; `params`
// carries values for keys that need format() substitution (see i18n.js).
// isCustom marks a feature whose real cost needs a manual quote: the price
// shown is a floor, and it's still summed into the total.
export function calculatePrice(s) {
    const tier = suggestTier(s);
    let total = 0;
    const lineItems = [];

    const base = tier === 'MINI' ? PRICES.baseMini : PRICES.baseBasic;
    total += base;
    lineItems.push({ key: 'base', price: base, params: { tier: tier === 'MINI' ? 'MINI' : 'BASIC' }, isBase: true });

    if (s.design === 'semi') {
        total += PRICES.designSemi;
        lineItems.push({ key: 'designSemi', price: PRICES.designSemi });
    } else if (s.design === 'full') {
        total += PRICES.designFull;
        lineItems.push({ key: 'designFull', price: PRICES.designFull });
    }

    if (s.logo) {
        total += PRICES.logo;
        lineItems.push({ key: 'logo', price: PRICES.logo });
    }

    const pages      = pageCount(s.pages);
    const included   = PAGES_INCLUDED[tier] ?? 3;
    const extraPages = Math.max(0, pages - included);
    if (extraPages > 0) {
        const cost = extraPages * PRICES.extraPage;
        total += cost;
        lineItems.push({ key: 'extraPages', price: cost, params: { count: extraPages, unit: PRICES.extraPage } });
    }

    if (s.content === 'written') {
        const cost = pages * PRICES.copywriting;
        total += cost;
        lineItems.push({ key: 'copywriting', price: cost, params: { count: pages, unit: PRICES.copywriting } });
    }

    if (s.languages === '2') {
        total += PRICES.language;
        lineItems.push({ key: 'languages2', price: PRICES.language });
    } else if (s.languages === '3+') {
        const cost = PRICES.language * 2;
        total += cost;
        lineItems.push({ key: 'languages3plus', price: cost });
    }

    if (s.cms === 'yes') {
        total += PRICES.cms;
        lineItems.push({ key: 'cms', price: PRICES.cms });
    }

    let hasCustom = false;
    for (const f of s.features || []) {
        if (!FEATURE_KEYS.includes(f)) continue;
        const price = PRICES[f];
        total += price;
        if (CUSTOM_FEATURES.has(f)) {
            hasCustom = true;
            lineItems.push({ key: f, price, isCustom: true });
        } else {
            lineItems.push({ key: f, price });
        }
    }

    for (const item of s.shop || []) {
        const key = SHOP_PRICE_KEYS[item];
        if (!key) continue;
        const price = PRICES[key];
        total += price;
        hasCustom = true;
        lineItems.push({ key, price, isCustom: true });
    }

    if (s.extra_products > 0) {
        const cost = s.extra_products * PRICES.extraProduct;
        total += cost;
        lineItems.push({ key: 'extraProducts', price: cost, params: { count: s.extra_products, unit: PRICES.extraProduct } });
    }

    for (const m of s.marketing || []) {
        if (!MARKETING_KEYS.includes(m)) continue;
        const price = PRICES[m];
        total += price;
        lineItems.push({ key: m, price });
    }

    return { tier, total, lineItems, hasCustom };
}

// Required-question check, in question order. Purpose, logo and features are
// opt-in and never required. Returns i18n keys under the "errors" namespace,
// not text, so the DOM layer can localize whichever one it shows.
export function validateForm(s) {
    const errors = [];
    if (!s.pages)     errors.push('errors.pages');
    if (!s.content)   errors.push('errors.content');
    if (!s.design)    errors.push('errors.design');
    if (!s.languages) errors.push('errors.languages');
    if (!s.cms)       errors.push('errors.cms');
    if (!s.hosting)   errors.push('errors.hosting');
    return errors;
}
