// Unit tests for the YouTube downloader's decision logic (views/download/logic.js).
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractVideoId, addHistoryEntry, isProbablyExpired, errorMessage, formatDuration, formatSize } from '../views/download/logic.js';

const entry = (id, extra = {}) => ({
    id,
    videoId: 'jNQXAC9IVRw',
    format: 'mp3',
    filename: `${id}.mp3`,
    size: 1000,
    createdAt: 1,
    ...extra,
});

test('extractVideoId reads a standard watch URL', () => {
    assert.equal(extractVideoId('https://www.youtube.com/watch?v=jNQXAC9IVRw'), 'jNQXAC9IVRw');
});

test('extractVideoId accepts every link shape the proxy accepts', () => {
    assert.equal(extractVideoId('https://youtu.be/jNQXAC9IVRw'), 'jNQXAC9IVRw');
    assert.equal(extractVideoId('https://youtu.be/jNQXAC9IVRw?t=10'), 'jNQXAC9IVRw');
    assert.equal(extractVideoId('https://www.youtube.com/shorts/jNQXAC9IVRw'), 'jNQXAC9IVRw');
    assert.equal(extractVideoId('https://www.youtube.com/live/jNQXAC9IVRw'), 'jNQXAC9IVRw');
    assert.equal(extractVideoId('https://www.youtube.com/embed/jNQXAC9IVRw'), 'jNQXAC9IVRw');
    assert.equal(extractVideoId('https://m.youtube.com/watch?v=jNQXAC9IVRw'), 'jNQXAC9IVRw');
    assert.equal(extractVideoId('https://music.youtube.com/watch?v=jNQXAC9IVRw'), 'jNQXAC9IVRw');
    assert.equal(extractVideoId('youtube.com/watch?v=jNQXAC9IVRw'), 'jNQXAC9IVRw');
    assert.equal(extractVideoId('  https://youtu.be/jNQXAC9IVRw  '), 'jNQXAC9IVRw');
});

test('extractVideoId rejects everything that is not a YouTube video link', () => {
    assert.equal(extractVideoId('https://vimeo.com/123456789'), null);
    assert.equal(extractVideoId('https://example.com/watch?v=jNQXAC9IVRw'), null);
    assert.equal(extractVideoId('https://youtube.com.evil.com/watch?v=jNQXAC9IVRw'), null);
    assert.equal(extractVideoId('https://www.youtube.com/watch?v=tooShort00'), null);
    assert.equal(extractVideoId('https://www.youtube.com/watch?v=waaaayTooLong0'), null);
    assert.equal(extractVideoId('https://www.youtube.com/@somechannel'), null);
    assert.equal(extractVideoId('https://www.youtube.com/playlist?list=PL123'), null);
    assert.equal(extractVideoId('javascript:alert(1)'), null);
    assert.equal(extractVideoId(''), null);
    assert.equal(extractVideoId('   '), null);
    assert.equal(extractVideoId(undefined), null);
    assert.equal(extractVideoId(42), null);
});

test('addHistoryEntry puts the newest rip first', () => {
    const list = addHistoryEntry(addHistoryEntry([], entry('aaa')), entry('bbb'));
    assert.deepEqual(list.map((e) => e.id), ['bbb', 'aaa']);
});

test('addHistoryEntry replaces a repeat rip and moves it to the front', () => {
    let list = [entry('bbb'), entry('aaa')];
    list = addHistoryEntry(list, entry('aaa', { createdAt: 99 }));
    assert.deepEqual(list.map((e) => e.id), ['aaa', 'bbb']);
    assert.equal(list[0].createdAt, 99);
    assert.equal(list.length, 2);
});

test('addHistoryEntry caps the list at 8 and does not mutate its input', () => {
    const input = Array.from({ length: 8 }, (_, i) => entry('old' + i));
    const inputCopy = structuredClone(input);
    const list = addHistoryEntry(input, entry('new'));
    assert.equal(list.length, 8);
    assert.equal(list[0].id, 'new');
    assert.equal(list.at(-1).id, 'old6');
    assert.deepEqual(input, inputCopy);
});

test('isProbablyExpired mirrors the server\'s 3 hour cache window', () => {
    const now = Date.parse('2026-07-11T12:00:00Z');
    assert.equal(isProbablyExpired(Date.parse('2026-07-11T11:00:00Z'), now), false);
    assert.equal(isProbablyExpired(Date.parse('2026-07-11T09:00:01Z'), now), false);
    assert.equal(isProbablyExpired(Date.parse('2026-07-11T08:59:59Z'), now), true);
    assert.equal(isProbablyExpired(undefined, now), true);
});

test('errorMessage maps proxy codes to human text and falls back generically', () => {
    assert.match(errorMessage('invalid_url'), /youtube/i);
    assert.match(errorMessage('ytdlp_missing'), /server/i);
    assert.match(errorMessage('video_rejected'), /2 hours|500 MB/);
    assert.match(errorMessage('busy'), /minute/i);
    const generic = errorMessage(undefined);
    assert.equal(typeof generic, 'string');
    assert.equal(errorMessage('some_new_code'), generic);
});

test('formatDuration renders m:ss and grows an hour part when needed', () => {
    assert.equal(formatDuration(19), '0:19');
    assert.equal(formatDuration(185), '3:05');
    assert.equal(formatDuration(3727), '1:02:07');
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(undefined), '0:00');
});

test('formatSize renders KB under a megabyte, MB above, empty when unknown', () => {
    assert.equal(formatSize(331053), '324 KB');
    assert.equal(formatSize(629172), '615 KB');
    assert.equal(formatSize(12 * 1024 * 1024), '12.0 MB');
    assert.equal(formatSize(0), '');
    assert.equal(formatSize(undefined), '');
});
