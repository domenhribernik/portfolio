// Unit tests for the shared Beseda logic (components/beseda/logic.js), which
// the full page and the iliana widget both run. Anything about which word today
// is, or how long a streak is, lives there precisely so the two surfaces cannot
// disagree, and these tests are what hold that.
//
// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    todayIso, dayNumber, wordOfTheDay, streakStats,
    addDay, mergeDays, validDays, glossSegments,
} from '../components/beseda/logic.js';

const daily = (days) => ({ epoch: '2026-08-01', days });

test('today is the local calendar day, not the UTC one', () => {
    // Half past midnight on 6 August. Anywhere east of UTC this instant is
    // still 5 August in UTC, so the toISOString().slice(0, 10) shortcut would
    // hand back yesterday for the first hours of every CET morning and quietly
    // break a streak.
    assert.equal(todayIso(new Date(2026, 7, 6, 0, 30)), '2026-08-06');
});

test('single digit months and days are padded', () => {
    assert.equal(todayIso(new Date(2026, 0, 9, 12, 0)), '2026-01-09');
});

test('counting days from the epoch is unaffected by daylight saving', () => {
    // Central European clocks jump on 29 March 2026. Counting in local time
    // would make that a 23 hour day and lose one from the total.
    assert.equal(dayNumber('2026-08-01', '2026-08-01'), 0);
    assert.equal(dayNumber('2026-08-02', '2026-08-01'), 1);
    assert.equal(dayNumber('2026-04-01', '2026-03-01'), 31);
    assert.equal(dayNumber('2027-08-01', '2026-08-01'), 365);
});

test('a date before the epoch counts backwards', () => {
    assert.equal(dayNumber('2026-07-31', '2026-08-01'), -1);
});

test('each day reads its own slot in the schedule', () => {
    const schedule = daily([[10, [1]], [20, [2]], [30, [3]]]);
    assert.deepEqual(wordOfTheDay(schedule, '2026-08-01'), { wordIndex: 10, sentences: [1] });
    assert.deepEqual(wordOfTheDay(schedule, '2026-08-03'), { wordIndex: 30, sentences: [3] });
});

test('appending future days leaves today alone', () => {
    // The whole point of indexing the schedule directly: a rebuild that adds
    // another year must not re-date the word someone saw this morning.
    const before = wordOfTheDay(daily([[10, [1]], [20, [2]]]), '2026-08-02');
    const after = wordOfTheDay(daily([[10, [1]], [20, [2]], [30, [3]], [40, [4]]]), '2026-08-02');
    assert.deepEqual(before, after);
});

test('running off the end of the schedule wraps instead of breaking', () => {
    // Only reachable if the schedule is never rebuilt again; a repeat word
    // beats an empty page, and every client wraps identically.
    assert.deepEqual(wordOfTheDay(daily([[10, [1]], [20, [2]]]), '2026-08-03'),
                     { wordIndex: 10, sentences: [1] });
});

test('a streak counts the run of days ending today', () => {
    const stats = streakStats(['2026-08-04', '2026-08-05', '2026-08-06'], '2026-08-06');
    assert.equal(stats.current, 3);
    assert.equal(stats.activeToday, true);
});

test('a streak stays alive all day until midnight', () => {
    // Practised yesterday but not yet today: the streak is still standing and
    // the page should say 2, not 0, or it reads as already lost by breakfast.
    const stats = streakStats(['2026-08-04', '2026-08-05'], '2026-08-06');
    assert.equal(stats.current, 2);
    assert.equal(stats.activeToday, false);
});

test('a missed day ends the streak', () => {
    const stats = streakStats(['2026-08-01', '2026-08-02', '2026-08-06'], '2026-08-06');
    assert.equal(stats.current, 1);
    assert.equal(stats.longest, 2);
});

test('the longest streak is remembered after the current one breaks', () => {
    const days = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-08-06'];
    assert.equal(streakStats(days, '2026-08-06').longest, 4);
});

test('a streak that ended before yesterday is over', () => {
    const stats = streakStats(['2026-08-01', '2026-08-02'], '2026-08-06');
    assert.equal(stats.current, 0);
    assert.equal(stats.longest, 2);
});

test('no practice at all is a streak of nothing', () => {
    assert.deepEqual(streakStats([], '2026-08-06'), { current: 0, longest: 0, activeToday: false });
});

test('duplicate and unsorted days do not inflate a streak', () => {
    const stats = streakStats(['2026-08-06', '2026-08-04', '2026-08-06', '2026-08-05'], '2026-08-06');
    assert.equal(stats.current, 3);
});

test('marking a day is idempotent and keeps the list sorted', () => {
    assert.deepEqual(addDay(['2026-08-06', '2026-08-04'], '2026-08-05'),
                     ['2026-08-04', '2026-08-05', '2026-08-06']);
    assert.deepEqual(addDay(['2026-08-06'], '2026-08-06'), ['2026-08-06']);
});

test('signing in unions the browser history with the account history', () => {
    // Someone who practised signed out on the widget keeps those days when
    // they finally log in; neither side wins, both are kept.
    assert.deepEqual(mergeDays(['2026-08-01', '2026-08-03'], ['2026-08-02', '2026-08-03']),
                     ['2026-08-01', '2026-08-02', '2026-08-03']);
});

test('rubbish from localStorage cannot become a streak', () => {
    const days = ['2026-08-05', 'yesterday', '2026-13-01', '2026-02-31', '', null, 42];
    assert.deepEqual(validDays(days, '2026-08-06'), ['2026-08-05']);
});

test('days in the future are dropped', () => {
    // Tomorrow is allowed: a learner whose clock is ahead of the server is
    // legitimately already on the next day.
    assert.deepEqual(validDays(['2026-08-06', '2026-08-07', '2026-09-01'], '2026-08-06'),
                     ['2026-08-06', '2026-08-07']);
});

test('a non-array is not a streak', () => {
    assert.deepEqual(validDays(undefined, '2026-08-06'), []);
    assert.deepEqual(validDays('2026-08-06', '2026-08-06'), []);
});

test('a sentence renders back exactly, punctuation and all', () => {
    // The segments are concatenated straight into the page, so anything the
    // spans drop is a word missing on screen.
    const sentence = ['Danes je lep dan.', 'Today is a nice day.',
                      [[0, 5, 7], [6, 8, 1], [9, 12, 4], [13, 16, 2]]];
    const segments = glossSegments(sentence);
    assert.equal(segments.map((s) => s.text).join(''), 'Danes je lep dan.');
    assert.deepEqual(segments.filter((s) => s.wordIndex !== null).map((s) => s.wordIndex),
                     [7, 1, 4, 2]);
});

test('a word with no gloss is still text on the page', () => {
    const segments = glossSegments(['Zdravo xyzzy!', 'Hello xyzzy!', [[0, 6, 3], [7, 12, -1]]]);
    assert.equal(segments.map((s) => s.text).join(''), 'Zdravo xyzzy!');
    assert.deepEqual(segments.map((s) => s.wordIndex), [3, null, null, null]);
});

test('a sentence with no spans is still readable', () => {
    assert.deepEqual(glossSegments(['Zdravo!', 'Hello!', []]),
                     [{ text: 'Zdravo!', wordIndex: null }]);
});

test('there is nothing to show before the epoch or without a schedule', () => {
    assert.equal(wordOfTheDay(daily([[10, [1]]]), '2026-07-31'), null);
    assert.equal(wordOfTheDay(daily([]), '2026-08-01'), null);
    assert.equal(wordOfTheDay(daily([[10, [1]]]), 'nonsense'), null);
});
