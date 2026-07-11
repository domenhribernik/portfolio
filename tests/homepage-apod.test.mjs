import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyAspect, resolveMedia } from '../views/homepage/apod-logic.js';

test('a square-ish image is classified square', () => {
    assert.equal(classifyAspect(1000, 1000), 'square');
});

test('a taller-than-wide image is classified portrait', () => {
    assert.equal(classifyAspect(800, 1200), 'portrait');
});

test('a wider-than-tall image is classified landscape', () => {
    assert.equal(classifyAspect(1600, 900), 'landscape');
});

test('a very wide image is classified panorama', () => {
    assert.equal(classifyAspect(3000, 1000), 'panorama');
});

test('bucket boundaries: 0.8 is square, just under is portrait', () => {
    assert.equal(classifyAspect(80, 100), 'square');   // r = 0.8
    assert.equal(classifyAspect(79, 100), 'portrait'); // r = 0.79
});

test('bucket boundaries: 2.2 is landscape, just over is panorama', () => {
    assert.equal(classifyAspect(220, 100), 'landscape'); // r = 2.2
    assert.equal(classifyAspect(221, 100), 'panorama');  // r = 2.21
});

test('missing or zero dimensions fall back to landscape, never NaN', () => {
    assert.equal(classifyAspect(0, 0), 'landscape');
    assert.equal(classifyAspect(1000, 0), 'landscape');
    assert.equal(classifyAspect(undefined, undefined), 'landscape');
});

test('an image day resolves to an image with the HD url as the full-size link', () => {
    const media = resolveMedia({ media_type: 'image', url: 'pic.jpg', hdurl: 'pic-hd.jpg' });
    assert.deepEqual(media, { kind: 'image', src: 'pic.jpg', full: 'pic-hd.jpg' });
});

test('an image with no hdurl falls back to the standard url for the full link', () => {
    const media = resolveMedia({ media_type: 'image', url: 'pic.jpg' });
    assert.equal(media.full, 'pic.jpg');
});

test('a video day resolves to a video embed', () => {
    const media = resolveMedia({ media_type: 'video', url: 'https://youtube.com/embed/x' });
    assert.deepEqual(media, { kind: 'video', src: 'https://youtube.com/embed/x', full: 'https://youtube.com/embed/x' });
});

test('an unknown media_type is treated as an image so the page never breaks', () => {
    const media = resolveMedia({ url: 'pic.jpg' });
    assert.equal(media.kind, 'image');
});
