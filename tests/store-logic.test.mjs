/* Unit tests for views/store/logic.js (the Everbloom storefront's pure logic).
   Run with: node --test tests/ */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    LIMITS,
    PLAN_KEYS,
    PRICING,
    HERO_ORDER,
    MAX_STEMS,
    validateSignup,
    spotsLine,
    annualSavingsPercent,
} from '../views/store/logic.js';

test('validateSignup accepts a clean signup and trims fields', () => {
    const r = validateSignup({
        email: '  ana@example.com ',
        plan: 'petal-post',
        note: '  my girlfriend in Ljubljana  ',
    });
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, {});
    assert.equal(r.clean.email, 'ana@example.com');
    assert.equal(r.clean.note, 'my girlfriend in Ljubljana');
});

test('validateSignup allows an empty note', () => {
    const r = validateSignup({ email: 'a@b.co', plan: 'forever', note: '' });
    assert.equal(r.valid, true);
});

test('validateSignup rejects missing and malformed emails', () => {
    assert.equal(validateSignup({ email: '', plan: 'forever' }).valid, false);
    assert.equal(validateSignup({ email: 'nope', plan: 'forever' }).valid, false);
    assert.equal(validateSignup({ email: 'a b@c.d', plan: 'forever' }).valid, false);
    const long = 'a'.repeat(LIMITS.email) + '@x.co';
    assert.equal(validateSignup({ email: long, plan: 'forever' }).valid, false);
});

test('validateSignup rejects unknown plans and missing plan', () => {
    assert.equal(validateSignup({ email: 'a@b.co', plan: 'premium' }).valid, false);
    assert.equal(validateSignup({ email: 'a@b.co' }).valid, false);
    for (const plan of PLAN_KEYS) {
        assert.equal(validateSignup({ email: 'a@b.co', plan }).valid, true, plan);
    }
});

test('validateSignup caps the note length', () => {
    const r = validateSignup({ email: 'a@b.co', plan: 'curious', note: 'x'.repeat(LIMITS.note + 1) });
    assert.equal(r.valid, false);
    assert.ok(r.errors.note);
});

test('validateSignup survives junk input', () => {
    assert.equal(validateSignup(undefined).valid, false);
    assert.equal(validateSignup(null).valid, false);
    assert.equal(validateSignup({ email: 42, plan: ['petal-post'] }).valid, false);
});

test('HERO_ORDER respects the builder contract', () => {
    const known = ['rose', 'peony', 'sunflower', 'lily', 'poppy', 'tulip', 'daisy', 'carnation', 'dandelion', 'lavender'];
    const total = HERO_ORDER.reduce((n, o) => n + o.count, 0);
    assert.ok(total >= 1 && total <= MAX_STEMS, `total ${total} within cap`);
    for (const { type, count } of HERO_ORDER) {
        assert.ok(known.includes(type), `known species: ${type}`);
        assert.ok(count >= 1);
    }
});

test('spotsLine hides low counts, shows real progress, flips when full', () => {
    assert.match(spotsLine(0).text, /100 founding spots/);
    assert.equal(spotsLine(0).full, false);
    assert.match(spotsLine(3).text, /100 founding spots/); // below threshold: no sad counter
    assert.match(spotsLine(42).text, /42 of 100/);
    assert.equal(spotsLine(100).full, true);
    assert.equal(spotsLine(140).full, true);
});

test('spotsLine tolerates garbage counts', () => {
    assert.equal(spotsLine(NaN).full, false);
    assert.equal(spotsLine(undefined).full, false);
    assert.equal(spotsLine(-5).full, false);
});

test('annualSavingsPercent matches the published prices', () => {
    assert.equal(annualSavingsPercent(), 25);
    assert.equal(annualSavingsPercent(PRICING.monthly, PRICING.annual), 25);
    assert.equal(annualSavingsPercent(0, 36), 0);
});
