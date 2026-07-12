// Tests for views/pricing/logic.js, the DOM-free half of the pricing
// calculator: tier selection, page-count mapping, price calculation and form
// validation. Line items and errors come back as i18n keys (not English
// strings) so script.js can localize them; see tests/pricing-i18n.test.mjs
// for the contract that every key here has an en and sl translation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageCount, suggestTier, calculatePrice, validateForm } from '../views/pricing/logic.js';

test('pageCount: maps each radio value to a page number', () => {
    assert.equal(pageCount('1'), 1);
    assert.equal(pageCount('2-3'), 3);
    assert.equal(pageCount('4-6'), 6);
    assert.equal(pageCount('7-12'), 12);
    assert.equal(pageCount('13+'), 13);
});

test('pageCount: unknown or missing value defaults to 1', () => {
    assert.equal(pageCount(undefined), 1);
    assert.equal(pageCount('bogus'), 1);
});

test('suggestTier: an empty selection defaults to BASIC', () => {
    assert.equal(suggestTier({}), 'BASIC');
});

test('suggestTier: a web app always escalates to CUSTOM', () => {
    assert.equal(suggestTier({ purpose: ['app'] }), 'CUSTOM');
});

test('suggestTier: booking, accounts, or API features escalate to CUSTOM', () => {
    assert.equal(suggestTier({ features: ['booking'] }), 'CUSTOM');
    assert.equal(suggestTier({ features: ['accounts'] }), 'CUSTOM');
    assert.equal(suggestTier({ features: ['api'] }), 'CUSTOM');
});

test('suggestTier: any shop selection escalates to CUSTOM', () => {
    assert.equal(suggestTier({ shop: ['payments'] }), 'CUSTOM');
});

test('suggestTier: full custom design, 2+ languages, or self-service CMS reach PREMIUM', () => {
    assert.equal(suggestTier({ design: 'full' }), 'PREMIUM');
    assert.equal(suggestTier({ languages: '2' }), 'PREMIUM');
    assert.equal(suggestTier({ languages: '3+' }), 'PREMIUM');
    assert.equal(suggestTier({ cms: 'yes' }), 'PREMIUM');
});

test('suggestTier: a blog, a logo, semi-custom design, or 4+ pages reach PLUS', () => {
    assert.equal(suggestTier({ features: ['blog'] }), 'PLUS');
    assert.equal(suggestTier({ logo: true }), 'PLUS');
    assert.equal(suggestTier({ design: 'semi' }), 'PLUS');
    assert.equal(suggestTier({ pages: '4-6' }), 'PLUS');
    assert.equal(suggestTier({ pages: '13+' }), 'PLUS');
});

test('suggestTier: MINI needs both a single page and self-hosted domain', () => {
    assert.equal(suggestTier({ pages: '1', hosting: 'own' }), 'MINI');
    assert.equal(suggestTier({ pages: '1', hosting: 'included' }), 'BASIC');
});

test('suggestTier: CUSTOM triggers outrank every other signal', () => {
    assert.equal(suggestTier({ purpose: ['app'], pages: '1', hosting: 'own' }), 'CUSTOM');
    assert.equal(suggestTier({ shop: ['setup'], design: 'full' }), 'CUSTOM');
});

test('calculatePrice: a lone MINI selection is just the base line item', () => {
    const result = calculatePrice({ pages: '1', hosting: 'own' });
    assert.equal(result.tier, 'MINI');
    assert.equal(result.total, 300);
    assert.equal(result.hasCustom, false);
    assert.deepEqual(result.lineItems, [
        { key: 'base', price: 300, params: { tier: 'MINI' }, isBase: true },
    ]);
});

test('calculatePrice: the BASIC default selection is just the base line item', () => {
    const result = calculatePrice({});
    assert.equal(result.tier, 'BASIC');
    assert.equal(result.total, 490);
    assert.deepEqual(result.lineItems, [
        { key: 'base', price: 490, params: { tier: 'BASIC' }, isBase: true },
    ]);
});

test('calculatePrice: semi-custom design adds its upgrade cost', () => {
    const result = calculatePrice({ design: 'semi' });
    assert.equal(result.total, 670); // 490 base + 180
    assert.deepEqual(result.lineItems, [
        { key: 'base', price: 490, params: { tier: 'BASIC' }, isBase: true },
        { key: 'designSemi', price: 180 },
    ]);
});

test('calculatePrice: fully custom design adds its upgrade cost', () => {
    const result = calculatePrice({ design: 'full' });
    assert.equal(result.total, 840); // 490 base + 350
    assert.deepEqual(result.lineItems, [
        { key: 'base', price: 490, params: { tier: 'BASIC' }, isBase: true },
        { key: 'designFull', price: 350 },
    ]);
});

test('calculatePrice: a logo add-on is billed once', () => {
    const result = calculatePrice({ logo: true });
    assert.equal(result.total, 610); // 490 base + 120
    assert.deepEqual(result.lineItems, [
        { key: 'base', price: 490, params: { tier: 'BASIC' }, isBase: true },
        { key: 'logo', price: 120 },
    ]);
});

test('calculatePrice: pages beyond the tier allowance are billed per extra page', () => {
    const result = calculatePrice({ pages: '7-12', design: 'semi' }); // PLUS includes 6, asked for 12
    assert.equal(result.total, 910); // 490 base + 180 design + 6 × 40
    assert.deepEqual(result.lineItems, [
        { key: 'base', price: 490, params: { tier: 'BASIC' }, isBase: true },
        { key: 'designSemi', price: 180 },
        { key: 'extraPages', price: 240, params: { count: 6, unit: 40 } },
    ]);
});

test('calculatePrice: copywriting is billed per page when Domen writes the content', () => {
    const result = calculatePrice({ content: 'written', pages: '2-3' }); // 3 pages, all included in BASIC
    assert.equal(result.total, 610); // 490 base + 3 × 40
    assert.deepEqual(result.lineItems, [
        { key: 'base', price: 490, params: { tier: 'BASIC' }, isBase: true },
        { key: 'copywriting', price: 120, params: { count: 3, unit: 40 } },
    ]);
});

test('calculatePrice: one extra language beyond the first is billed once', () => {
    const result = calculatePrice({ languages: '2' });
    assert.equal(result.total, 610); // 490 base + 120
    assert.deepEqual(result.lineItems, [
        { key: 'base', price: 490, params: { tier: 'BASIC' }, isBase: true },
        { key: 'languages2', price: 120 },
    ]);
});

test('calculatePrice: three or more languages double the language add-on', () => {
    const result = calculatePrice({ languages: '3+' });
    assert.equal(result.total, 730); // 490 base + 240
    assert.deepEqual(result.lineItems, [
        { key: 'base', price: 490, params: { tier: 'BASIC' }, isBase: true },
        { key: 'languages3plus', price: 240 },
    ]);
});

test('calculatePrice: self-service CMS adds its cost', () => {
    const result = calculatePrice({ cms: 'yes' });
    assert.equal(result.total, 670); // 490 base + 180
    assert.deepEqual(result.lineItems, [
        { key: 'base', price: 490, params: { tier: 'BASIC' }, isBase: true },
        { key: 'cms', price: 180 },
    ]);
});

test('calculatePrice: ordinary features are billed in the order selected', () => {
    const result = calculatePrice({ features: ['map', 'gallery'] });
    assert.equal(result.total, 580); // 490 base + 30 + 60
    assert.equal(result.hasCustom, false);
    assert.deepEqual(result.lineItems, [
        { key: 'base', price: 490, params: { tier: 'BASIC' }, isBase: true },
        { key: 'map', price: 30 },
        { key: 'gallery', price: 60 },
    ]);
});

test('calculatePrice: booking/accounts/api features are flagged as a custom quote floor', () => {
    const result = calculatePrice({ features: ['booking'] });
    assert.equal(result.tier, 'CUSTOM');
    assert.equal(result.total, 890); // 490 base + 400 floor, still summed
    assert.equal(result.hasCustom, true);
    assert.deepEqual(result.lineItems, [
        { key: 'base', price: 490, params: { tier: 'BASIC' }, isBase: true },
        { key: 'booking', price: 400, isCustom: true },
    ]);
});

test('calculatePrice: ordinary and custom-quote features can mix in one order', () => {
    const result = calculatePrice({ features: ['map', 'booking'] });
    assert.equal(result.total, 920); // 490 base + 30 + 400
    assert.equal(result.hasCustom, true);
    assert.deepEqual(result.lineItems, [
        { key: 'base', price: 490, params: { tier: 'BASIC' }, isBase: true },
        { key: 'map', price: 30 },
        { key: 'booking', price: 400, isCustom: true },
    ]);
});

test('calculatePrice: shop add-ons are always flagged as a custom quote', () => {
    const result = calculatePrice({ shop: ['setup', 'payments'] });
    assert.equal(result.tier, 'CUSTOM');
    assert.equal(result.total, 1240); // 490 base + 600 + 150
    assert.equal(result.hasCustom, true);
    assert.deepEqual(result.lineItems, [
        { key: 'base', price: 490, params: { tier: 'BASIC' }, isBase: true },
        { key: 'shopSetup', price: 600, isCustom: true },
        { key: 'payments', price: 150, isCustom: true },
    ]);
});

test('calculatePrice: extra products beyond the shop plan are billed per item', () => {
    const result = calculatePrice({ extra_products: 5 });
    assert.equal(result.total, 505); // 490 base + 5 × 3
    assert.deepEqual(result.lineItems, [
        { key: 'base', price: 490, params: { tier: 'BASIC' }, isBase: true },
        { key: 'extraProducts', price: 15, params: { count: 5, unit: 3 } },
    ]);
});

test('calculatePrice: marketing add-ons are never flagged as custom', () => {
    const result = calculatePrice({ marketing: ['seo', 'analytics'] });
    assert.equal(result.total, 730); // 490 base + 180 + 60
    assert.equal(result.hasCustom, false);
    assert.deepEqual(result.lineItems, [
        { key: 'base', price: 490, params: { tier: 'BASIC' }, isBase: true },
        { key: 'seo', price: 180 },
        { key: 'analytics', price: 60 },
    ]);
});

test('calculatePrice: a full quote sums every category in a stable order', () => {
    const result = calculatePrice({
        pages: '13+',
        content: 'written',
        design: 'semi',
        logo: true,
        languages: '2',
        cms: 'yes',
        features: ['map', 'newsletter'],
        marketing: ['seo'],
        extra_products: 2,
    });
    assert.equal(result.tier, 'PREMIUM');
    assert.equal(result.total, 1926);
    assert.equal(result.hasCustom, false);
    assert.deepEqual(result.lineItems, [
        { key: 'base', price: 490, params: { tier: 'BASIC' }, isBase: true },
        { key: 'designSemi', price: 180 },
        { key: 'logo', price: 120 },
        { key: 'extraPages', price: 40, params: { count: 1, unit: 40 } },
        { key: 'copywriting', price: 520, params: { count: 13, unit: 40 } },
        { key: 'languages2', price: 120 },
        { key: 'cms', price: 180 },
        { key: 'map', price: 30 },
        { key: 'newsletter', price: 60 },
        { key: 'extraProducts', price: 6, params: { count: 2, unit: 3 } },
        { key: 'seo', price: 180 },
    ]);
});

test('validateForm: an untouched form flags every required question, in question order', () => {
    assert.deepEqual(validateForm({}), [
        'errors.pages', 'errors.content', 'errors.design', 'errors.languages', 'errors.cms', 'errors.hosting',
    ]);
});

test('validateForm: a fully answered form has no errors', () => {
    const errors = validateForm({
        pages: '1', content: 'own', design: 'template', languages: '1', cms: 'no', hosting: 'included',
    });
    assert.deepEqual(errors, []);
});

test('validateForm: purpose, logo, and features are never required', () => {
    const errors = validateForm({
        pages: '1', content: 'own', design: 'template', languages: '1', cms: 'no', hosting: 'included',
        purpose: [], features: [], logo: false,
    });
    assert.deepEqual(errors, []);
});
