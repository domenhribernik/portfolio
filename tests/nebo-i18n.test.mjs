// Tests for views/nebo/i18n.js, the DOM-free half of the language system:
// language pick order, dictionary lookup, template fill, and the contract
// that the en and sl dictionaries stay key-for-key parallel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickLanguage, lookup, format, SUPPORTED, FALLBACK } from '../views/nebo/i18n.js';
import { phaseName } from '../views/nebo/logic.js';

const dictionary = (code) => JSON.parse(
    readFileSync(new URL(`../views/nebo/lang/${code}.json`, import.meta.url), 'utf8'),
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

test('pickLanguage: first supported system language wins', () => {
    assert.equal(pickLanguage(null, ['de-DE', 'sl-SI', 'en-GB']), 'sl');
    assert.equal(pickLanguage(null, ['de-DE', 'en-GB', 'sl-SI']), 'en');
});

test('pickLanguage: nothing usable falls back to english', () => {
    assert.equal(pickLanguage(null, ['de-DE', 'fr-FR']), FALLBACK);
    assert.equal(pickLanguage(null, []), FALLBACK);
    assert.equal(pickLanguage(null, undefined), FALLBACK);
});

test('pickLanguage: a stale saved value outside SUPPORTED is ignored', () => {
    assert.equal(pickLanguage('xx', ['sl-SI']), 'sl');
});

test('lookup: dotted paths, arrays, and missing keys', () => {
    const dict = { a: { b: 'hit' }, compass: ['N', 'NNE'] };
    assert.equal(lookup(dict, 'a.b'), 'hit');
    assert.deepEqual(lookup(dict, 'compass'), ['N', 'NNE']);
    assert.equal(lookup(dict, 'a.missing'), 'a.missing');
    assert.equal(lookup(dict, 'a.b.too.deep'), 'a.b.too.deep');
    assert.equal(lookup(null, 'a.b'), 'a.b');
});

test('format: fills named slots and leaves unknown ones visible', () => {
    assert.equal(format('{alt}° up', { alt: 42 }), '42° up');
    assert.equal(format('{phase} · {pct} % lit', { phase: 'Full Moon', pct: 100 }), 'Full Moon · 100 % lit');
    assert.equal(format('{oops}', {}), '{oops}');
});

// A dictionary that drifts leaves raw keys on the page after a mid-session
// switch, so en and sl must expose exactly the same shape (arrays included).
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

test('dictionaries: compass roses have 16 winds and cardinals 4 points', () => {
    for (const code of SUPPORTED) {
        const dict = dictionary(code);
        assert.equal(dict.compass.length, 16, `${code} compass`);
        assert.equal(dict.sky.cardinals.length, 4, `${code} cardinals`);
    }
});

test('dictionaries: every phase name logic.js can emit has a translation', () => {
    const names = new Set();
    for (let i = 0; i <= 100; i++) {
        names.add(phaseName(i / 100, true));
        names.add(phaseName(i / 100, false));
    }
    for (const code of SUPPORTED) {
        const phases = dictionary(code).phases;
        for (const name of names) {
            assert.equal(typeof phases[name], 'string', `${code} missing phase "${name}"`);
        }
    }
});
