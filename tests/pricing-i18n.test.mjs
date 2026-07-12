// Tests for views/pricing/i18n.js (language pick order, dictionary lookup,
// template fill) plus the contract that matters most for a page whose copy
// doubles as sales material: every price the calculator can produce, and
// every validation error it can raise, must resolve to real text in both
// the en and sl dictionaries, not fall back to a raw dotted key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickLanguage, lookup, format, SUPPORTED, FALLBACK } from '../views/pricing/i18n.js';
import { calculatePrice, validateForm, PRICES, PACKAGE_FROM, LOADING_STEPS } from '../views/pricing/logic.js';

const dictionary = (code) => JSON.parse(
    readFileSync(new URL(`../views/pricing/lang/${code}.json`, import.meta.url), 'utf8'),
);

test('pickLanguage: a saved dropdown choice beats the system list', () => {
    assert.equal(pickLanguage('sl', ['en-US', 'en']), 'sl');
    assert.equal(pickLanguage('en', ['sl-SI']), 'en');
});

test('pickLanguage: slovenian system locales map to sl in any spelling', () => {
    assert.equal(pickLanguage(null, ['sl-SI', 'en-US']), 'sl');
    assert.equal(pickLanguage(null, ['sl']), 'sl');
    assert.equal(pickLanguage(null, ['SL-si']), 'sl');
});

test('pickLanguage: nothing usable falls back to english', () => {
    assert.equal(pickLanguage(null, ['de-DE', 'fr-FR']), FALLBACK);
    assert.equal(pickLanguage(null, []), FALLBACK);
});

test('lookup: dotted paths and missing keys', () => {
    const dict = { a: { b: 'hit' } };
    assert.equal(lookup(dict, 'a.b'), 'hit');
    assert.equal(lookup(dict, 'a.missing'), 'a.missing');
});

test('format: fills named slots and leaves unknown ones visible', () => {
    assert.equal(format('{count} × €{unit}', { count: 3, unit: 40 }), '3 × €40');
    assert.equal(format('{oops}', {}), '{oops}');
});

test('dictionaries: en and sl have identical key shapes', () => {
    const shape = (node, prefix = '') => {
        if (Array.isArray(node)) return [`${prefix}[${node.length}]`];
        if (node === null || typeof node !== 'object') return [prefix];
        return Object.keys(node).sort().flatMap(
            (key) => shape(node[key], prefix ? `${prefix}.${key}` : key),
        );
    };
    assert.deepEqual(shape(dictionary('sl')), shape(dictionary('en')));
});

// Every line item calculatePrice can emit must resolve to real copy, in both
// languages, not fall back to the raw "items.foo" key.
test('dictionaries: every line item calculatePrice can produce has an items.* translation', () => {
    const everything = {
        purpose: ['business', 'blog', 'shop', 'app'],
        pages: '13+',
        content: 'written',
        design: 'full',
        logo: true,
        languages: '3+',
        cms: 'yes',
        features: ['map', 'gallery', 'blog', 'newsletter', 'chat', 'booking', 'accounts', 'api'],
        shop: ['setup', 'payments', 'orders'],
        extra_products: 5,
        marketing: ['seo', 'analytics', 'speed', 'security'],
        hosting: 'included',
    };
    const { lineItems } = calculatePrice(everything);
    assert.ok(lineItems.length > 10, 'sanity check: the kitchen-sink state should produce many line items');

    for (const code of SUPPORTED) {
        const dict = dictionary(code);
        for (const item of lineItems) {
            const translated = lookup(dict, `items.${item.key}`);
            assert.notEqual(translated, `items.${item.key}`, `${code} missing items.${item.key}`);
        }
    }
});

test('dictionaries: every validateForm error key has an errors.* translation', () => {
    const keys = validateForm({}); // every required question left blank
    assert.ok(keys.length > 0, 'sanity check: an empty form should raise errors');
    for (const code of SUPPORTED) {
        const dict = dictionary(code);
        for (const key of keys) {
            assert.notEqual(lookup(dict, key), key, `${code} missing ${key}`);
        }
    }
});

// A translator dropping a {placeholder} wouldn't throw (format() leaves
// unknown slots verbatim), it would just silently show "0 × €0" forever.
test('dictionaries: templated item labels keep their placeholders in both languages', () => {
    const templated = {
        base:          ['{tier}'],
        extraPages:    ['{count}', '{unit}'],
        copywriting:   ['{count}', '{unit}'],
        extraProducts: ['{count}', '{unit}'],
    };
    for (const code of SUPPORTED) {
        const dict = dictionary(code);
        for (const [key, placeholders] of Object.entries(templated)) {
            const template = lookup(dict, `items.${key}`);
            for (const placeholder of placeholders) {
                assert.ok(template.includes(placeholder), `${code} items.${key} should contain ${placeholder}, got "${template}"`);
            }
        }
    }
});

test('dictionaries: every package tier has a description and a non-empty items list', () => {
    for (const code of SUPPORTED) {
        const dict = dictionary(code);
        for (const tier of ['MINI', 'BASIC', 'PLUS', 'PREMIUM', 'CUSTOM']) {
            const pkg = dict.packages[tier];
            assert.equal(typeof pkg.description, 'string');
            assert.ok(pkg.description.length > 0, `${code} packages.${tier}.description is empty`);
            assert.ok(Array.isArray(pkg.items) && pkg.items.length > 0, `${code} packages.${tier}.items is empty`);
        }
    }
});

// PRICES is the calculator's source of truth for numbers; this just confirms
// the dictionary wasn't written against a stale copy of it (e.g. a price
// renamed in logic.js but not in lang/*.json).
test('sanity: PRICES has no keys outside what the dictionaries know how to label', () => {
    const en = dictionary('en');
    const unlabeled = Object.keys(PRICES).filter((k) => !(k in en.items) && !['baseMini', 'baseBasic', 'extraPage', 'language', 'extraProduct'].includes(k));
    assert.deepEqual(unlabeled, []);
});

test('dictionaries: every loading-screen step has a translation, and every PACKAGE_FROM tier a package entry', () => {
    for (const code of SUPPORTED) {
        const dict = dictionary(code);
        for (const step of LOADING_STEPS) {
            assert.equal(typeof dict.loading.steps[step.key], 'string', `${code} missing loading.steps.${step.key}`);
        }
        for (const tier of Object.keys(PACKAGE_FROM)) {
            assert.ok(dict.packages[tier], `${code} missing packages.${tier}`);
        }
    }
});
