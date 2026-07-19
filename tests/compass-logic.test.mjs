// Unit tests for the Compass logic (views/compass/logic.js), the private
// No More Mr. Nice Guy practice tracker. Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    PRACTICES, PATTERNS, ACTIVITIES, CHAPTERS,
    dateKey, shiftKey, dayScore, GOAL, streak, lastNDays, practiceRates, catchCounts, activityProgress,
} from '../views/compass/logic.js';

test('PRACTICES holds six daily practices with unique keys and full copy', () => {
    assert.equal(PRACTICES.length, 6);
    const keys = PRACTICES.map(p => p.key);
    assert.equal(new Set(keys).size, 6, 'practice keys are unique');
    for (const p of PRACTICES) {
        assert.ok(/^[a-z]+$/.test(p.key), `${p.key} is a stable lowercase key`);
        assert.ok(p.label.length > 0, `${p.key} has a label`);
        assert.ok(p.detail.length > 0, `${p.key} says what doing it looks like`);
        assert.ok(p.why.length > 0, `${p.key} explains why (book concept)`);
    }
});

test('PRACTICES cover the relationship-facing and self-facing halves', () => {
    const keys = new Set(PRACTICES.map(p => p.key));
    // Her side: feeling seen, presence, leading. His side: directness,
    // no covert contracts, a life of his own.
    for (const key of ['seen', 'present', 'direct', 'nostrings', 'self', 'lead']) {
        assert.ok(keys.has(key), `practice "${key}" exists`);
    }
});

test('PATTERNS name the eight catchable Nice Guy behaviors from the book', () => {
    assert.equal(PATTERNS.length, 8);
    const keys = PATTERNS.map(p => p.key);
    assert.equal(new Set(keys).size, 8, 'pattern keys are unique');
    for (const key of ['approval', 'covert', 'caretake', 'hide', 'deer', 'victim', 'avoid', 'settle']) {
        assert.ok(keys.includes(key), `pattern "${key}" exists`);
    }
    for (const p of PATTERNS) {
        assert.ok(p.label.length > 0, `${p.key} has a label`);
        assert.ok(p.hint.length > 0, `${p.key} has a recognition hint`);
    }
});

test('ACTIVITIES is the full Breaking Free workbook: 46 numbered exercises', () => {
    assert.equal(ACTIVITIES.length, 46);
    const nums = ACTIVITIES.map(a => a.num);
    assert.deepEqual(nums, Array.from({ length: 46 }, (_, i) => i + 1), 'numbered 1..46 in order');
    for (const a of ACTIVITIES) {
        assert.ok(a.chapter >= 1 && a.chapter <= 9, `activity ${a.num} has a book chapter`);
        assert.ok(a.title.length > 0, `activity ${a.num} has a title`);
        assert.ok(a.prompt.length > 0, `activity ${a.num} has a prompt`);
    }
});

test('ACTIVITIES chapters run in book order and match known anchors', () => {
    for (let i = 1; i < ACTIVITIES.length; i++) {
        assert.ok(ACTIVITIES[i].chapter >= ACTIVITIES[i - 1].chapter,
            `activity ${ACTIVITIES[i].num} does not jump back a chapter`);
    }
    // Spot-check anchors against the book.
    assert.equal(ACTIVITIES[0].chapter, 1);   // safe people list
    assert.equal(ACTIVITIES[15].chapter, 4);  // #16: put yourself first for a week
    assert.equal(ACTIVITIES[29].chapter, 7);  // #30: enmesher or avoider
    assert.equal(ACTIVITIES[39].chapter, 9);  // #40: face a named fear
    assert.equal(ACTIVITIES[45].chapter, 9);  // #46: write your own rules
});

test('dateKey formats a Date as the LOCAL calendar day', () => {
    // Construct via local components so this holds in any timezone.
    assert.equal(dateKey(new Date(2026, 0, 5)), '2026-01-05');
    assert.equal(dateKey(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
});

test('shiftKey moves a day key across month and year boundaries', () => {
    assert.equal(shiftKey('2026-07-19', -1), '2026-07-18');
    assert.equal(shiftKey('2026-03-01', -1), '2026-02-28');
    assert.equal(shiftKey('2026-01-01', -1), '2025-12-31');
    assert.equal(shiftKey('2026-07-19', 0), '2026-07-19');
});

test('dayScore counts kept practices and a day is "kept" at the GOAL', () => {
    assert.equal(dayScore({}), 0);
    assert.equal(dayScore({ seen: true, present: false, direct: true }), 2);
    assert.equal(dayScore({ seen: true, present: true, direct: true, nostrings: true, self: true, lead: true }), 6);
    // Unknown keys never inflate the score.
    assert.equal(dayScore({ seen: true, hacked: true, extra: true }), 1);
    assert.ok(GOAL >= 3 && GOAL <= PRACTICES.length, 'GOAL is a reachable bar');
});

const kept = { seen: true, present: true, direct: true, nostrings: true, self: false, lead: false };
const missed = { seen: true, present: false, direct: false, nostrings: false, self: false, lead: false };
const day = (d, practices) => ({ day: d, practices });

test('streak counts consecutive kept days ending today', () => {
    assert.equal(streak([], '2026-07-19'), 0);
    const checkins = [
        day('2026-07-19', kept),
        day('2026-07-18', kept),
        day('2026-07-17', kept),
        // gap on the 16th
        day('2026-07-15', kept),
    ];
    assert.equal(streak(checkins, '2026-07-19'), 3);
});

test('streak is not broken by a today that simply is not over yet', () => {
    // Nothing logged today: yesterday-ending run still counts.
    assert.equal(streak([day('2026-07-18', kept), day('2026-07-17', kept)], '2026-07-19'), 2);
    // Today logged but under the goal so far: same grace.
    assert.equal(streak([day('2026-07-19', missed), day('2026-07-18', kept)], '2026-07-19'), 1);
});

test('streak breaks on a past day under the goal and crosses month edges', () => {
    assert.equal(streak([day('2026-07-19', kept), day('2026-07-18', missed), day('2026-07-17', kept)], '2026-07-19'), 1);
    assert.equal(streak([day('2026-03-01', kept), day('2026-02-28', kept)], '2026-03-01'), 2);
    // A run that ended before yesterday is over.
    assert.equal(streak([day('2026-07-16', kept), day('2026-07-15', kept)], '2026-07-19'), 0);
});

test('lastNDays returns an oldest-to-newest series ending today, null when unlogged', () => {
    const checkins = [day('2026-07-19', kept), day('2026-07-17', missed)];
    const series = lastNDays(checkins, '2026-07-19', 4);
    assert.deepEqual(series, [
        { day: '2026-07-16', score: null },
        { day: '2026-07-17', score: 1 },
        { day: '2026-07-18', score: null },
        { day: '2026-07-19', score: 4 },
    ]);
});

test('practiceRates reports done/logged per practice over the window, logged days only', () => {
    const checkins = [
        day('2026-07-19', { seen: true, present: true }),
        day('2026-07-18', { seen: true, present: false }),
        day('2026-06-01', { seen: true }), // outside a 7-day window
    ];
    const rates = practiceRates(checkins, '2026-07-19', 7);
    assert.equal(rates.length, PRACTICES.length, 'one entry per practice, in PRACTICES order');
    const seen = rates.find(r => r.key === 'seen');
    const present = rates.find(r => r.key === 'present');
    const lead = rates.find(r => r.key === 'lead');
    assert.deepEqual({ done: seen.done, days: seen.days }, { done: 2, days: 2 });
    assert.deepEqual({ done: present.done, days: present.days }, { done: 1, days: 2 });
    assert.deepEqual({ done: lead.done, days: lead.days }, { done: 0, days: 2 });
    assert.equal(seen.label, 'Make her feel seen', 'entries carry the label for rendering');
});

test('catchCounts tallies logged patterns inside the window, in PATTERNS order', () => {
    const catches = [
        { pattern: 'covert', caught_at: '2026-07-19 21:15:00' },
        { pattern: 'covert', caught_at: '2026-07-15 09:00:00' },
        { pattern: 'deer', caught_at: '2026-07-13 12:00:00' },   // day floor of a 7-day window
        { pattern: 'victim', caught_at: '2026-07-12 23:59:00' }, // just outside
        { pattern: 'nonsense', caught_at: '2026-07-19 10:00:00' }, // unknown keys ignored
    ];
    const counts = catchCounts(catches, '2026-07-19', 7);
    assert.equal(counts.length, PATTERNS.length);
    const byKey = Object.fromEntries(counts.map(c => [c.key, c.count]));
    assert.equal(byKey.covert, 2);
    assert.equal(byKey.deer, 1);
    assert.equal(byKey.victim, 0);
    assert.equal(counts.reduce((sum, c) => sum + c.count, 0), 3);
    assert.ok(counts[0].label.length > 0, 'entries carry labels for rendering');
});

test('activityProgress summarizes the workbook against all 46 exercises', () => {
    assert.deepEqual(activityProgress([]), { done: 0, doing: 0, total: 46, pct: 0 });
    const states = [
        { num: 1, status: 'done' },
        { num: 2, status: 'done' },
        { num: 3, status: 'doing' },
        { num: 4, status: 'todo' },
        { num: 99, status: 'done' }, // out-of-range rows never count
    ];
    assert.deepEqual(activityProgress(states), { done: 2, doing: 1, total: 46, pct: 4 });
});

test('CHAPTERS titles every chapter the workbook references', () => {
    const used = new Set(ACTIVITIES.map(a => a.chapter));
    for (const ch of used) {
        assert.ok(CHAPTERS[ch] && CHAPTERS[ch].length > 0, `chapter ${ch} has a title`);
    }
    assert.equal(Object.keys(CHAPTERS).length, 9);
});
