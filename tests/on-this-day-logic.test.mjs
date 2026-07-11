// Unit tests for the On This Day page's decision logic (views/on-this-day/logic.js).
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitFeatured, splitEntry, pickPageUrl, pickExtractHtml, dayOfYear, pad2 } from '../views/on-this-day/logic.js';

const item = (year, extra = {}) => ({ year, text: `${year} something`, ...extra });
const withImage = (year) => item(year, { pages: [{ thumbnail: { source: 'x.jpg' } }] });

test('splitFeatured promotes the first illustrated dispatch to the lead', () => {
    const a = item(1901);                 // no image
    const b = withImage(1912);            // has an image
    const c = item(1945);
    const { lead, rest } = splitFeatured([a, b, c]);
    assert.equal(lead, b);
    assert.deepEqual(rest, [a, c]);       // remaining keep their original order
});

test('splitFeatured leads with the first dispatch when none is illustrated', () => {
    const a = item(1901), b = item(1912);
    const { lead, rest } = splitFeatured([a, b]);
    assert.equal(lead, a);
    assert.deepEqual(rest, [b]);
});

test('splitFeatured returns an empty shape for no dispatches', () => {
    assert.deepEqual(splitFeatured([]), { lead: null, rest: [] });
    assert.deepEqual(splitFeatured(null), { lead: null, rest: [] });
});

test('splitEntry breaks a headline off its context on the first comma', () => {
    assert.deepEqual(
        splitEntry('Neil Armstrong, American astronaut'),
        { title: 'Neil Armstrong', description: 'American astronaut' }
    );
});

test('splitEntry falls back to the whole line as the headline', () => {
    assert.deepEqual(splitEntry('A single unbroken headline'), { title: 'A single unbroken headline', description: '' });
    assert.deepEqual(splitEntry(''), { title: '', description: '' });
});

test('pickPageUrl prefers the desktop page url', () => {
    const pages = [{ title: 'Moon', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Moon' } } }];
    assert.equal(pickPageUrl(pages), 'https://en.wikipedia.org/wiki/Moon');
});

test('pickPageUrl builds a wiki url from the title when no url is given', () => {
    assert.equal(pickPageUrl([{ title: 'Apollo_11' }]), 'https://en.wikipedia.org/wiki/Apollo_11');
    assert.equal(pickPageUrl([]), null);
    assert.equal(pickPageUrl(null), null);
});

test('pickExtractHtml returns the first page summary or null', () => {
    assert.equal(pickExtractHtml([{ extract_html: '<p>hi</p>' }]), '<p>hi</p>');
    assert.equal(pickExtractHtml([{}]), null);
    assert.equal(pickExtractHtml(null), null);
});

test('dayOfYear counts from 1 on January 1st', () => {
    assert.equal(dayOfYear(new Date(2024, 0, 1)), 1);
    assert.equal(dayOfYear(new Date(2024, 1, 1)), 32);   // 31 days in Jan + 1
    assert.equal(dayOfYear(new Date(2023, 11, 31)), 365);
});

test('pad2 zero-pads to two digits', () => {
    assert.equal(pad2(0), '00');
    assert.equal(pad2(6), '06');
    assert.equal(pad2(15), '15');
});
