// Unit tests for the massage routine logic (views/masaza/logic.js).
// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    ROUTINE, TEHNIKE, VRSTNI_RED, NE_MASIRAMO, PRIPRAVA,
    buildSchedule, flipIndex, formatTime, segmentAt,
    startSession, elapsedSeconds, pauseSession, resumeSession, skipToNext,
} from '../views/masaza/logic.js';

const T0 = 1_750_000_000_000; // arbitrary epoch ms anchor for session tests

test('ROUTINE has 10 segments totalling 60 minutes, split 30/30 front/back', () => {
    assert.equal(ROUTINE.length, 10);
    const total = ROUTINE.reduce((sum, s) => sum + s.minutes, 0);
    assert.equal(total, 60);
    const front = ROUTINE.filter(s => s.side === 'front').reduce((sum, s) => sum + s.minutes, 0);
    const back = ROUTINE.filter(s => s.side === 'back').reduce((sum, s) => sum + s.minutes, 0);
    assert.equal(front, 30);
    assert.equal(back, 30);
});

test('ROUTINE starts with the face, ends with the feet, back is 15 min', () => {
    assert.equal(ROUTINE[0].id, 'obraz');
    assert.equal(ROUTINE[ROUTINE.length - 1].id, 'stopala');
    const hrbet = ROUTINE.find(s => s.id === 'hrbet');
    assert.ok(hrbet, 'hrbet segment exists');
    assert.equal(hrbet.minutes, 15);
});

test('ROUTINE sides are contiguous: all front segments before all back segments', () => {
    const firstBack = ROUTINE.findIndex(s => s.side === 'back');
    assert.ok(firstBack > 0, 'there is a back part');
    for (let i = 0; i < ROUTINE.length; i++) {
        assert.equal(ROUTINE[i].side, i < firstBack ? 'front' : 'back');
    }
});

test('TEHNIKE holds exactly the five course techniques with unique ids', () => {
    assert.equal(TEHNIKE.length, 5);
    const ids = TEHNIKE.map(t => t.id);
    assert.equal(new Set(ids).size, 5);
    for (const t of TEHNIKE) {
        assert.ok(t.name.length > 0, `${t.id} has a name`);
        assert.ok(t.alias.length > 0, `${t.id} has a course alias`);
        assert.ok(t.summary.length > 0, `${t.id} has a summary`);
        assert.ok(Array.isArray(t.cues) && t.cues.length >= 2, `${t.id} has at least 2 cues`);
    }
});

test('every ROUTINE segment lists resolvable techniques and at least one cue', () => {
    const known = new Set(TEHNIKE.map(t => t.id));
    for (const seg of ROUTINE) {
        assert.ok(seg.techniques.length > 0, `${seg.id} lists techniques`);
        for (const id of seg.techniques) {
            assert.ok(known.has(id), `${seg.id} technique "${id}" resolves in TEHNIKE`);
        }
        assert.ok(Array.isArray(seg.cues) && seg.cues.length > 0, `${seg.id} has cues`);
    }
});

test('VRSTNI_RED has the 8 course steps, each titled', () => {
    assert.equal(VRSTNI_RED.length, 8);
    for (const step of VRSTNI_RED) {
        assert.ok(step.title.length > 0);
        assert.ok(step.note.length > 0);
    }
});

test('NE_MASIRAMO carries zones and the course motto', () => {
    assert.ok(NE_MASIRAMO.zones.length >= 5);
    assert.ok(NE_MASIRAMO.motto.includes('NE MASIRAJ'));
    assert.ok(NE_MASIRAMO.latin.toLowerCase().includes('primum non nocere'));
});

test('PRIPRAVA checklist is non-empty', () => {
    assert.ok(PRIPRAVA.length >= 5);
    for (const item of PRIPRAVA) assert.ok(item.length > 0);
});

test('buildSchedule produces contiguous second offsets totalling 3600', () => {
    const schedule = buildSchedule();
    assert.equal(schedule.length, ROUTINE.length);
    assert.equal(schedule[0].start, 0);
    for (let i = 0; i < schedule.length; i++) {
        assert.equal(schedule[i].duration, schedule[i].minutes * 60);
        assert.equal(schedule[i].end, schedule[i].start + schedule[i].duration);
        if (i > 0) assert.equal(schedule[i].start, schedule[i - 1].end);
    }
    assert.equal(schedule[schedule.length - 1].end, 3600);
});

test('flipIndex finds the first back segment, at the 30-minute mark', () => {
    const schedule = buildSchedule();
    assert.equal(flipIndex(schedule), 6);
    assert.equal(schedule[6].start, 1800);
    assert.equal(flipIndex(buildSchedule(ROUTINE.filter(s => s.side === 'front'))), -1);
});

test('segmentAt locates the running segment mid-way', () => {
    const schedule = buildSchedule();
    const atStart = segmentAt(schedule, 0);
    assert.equal(atStart.done, false);
    assert.equal(atStart.index, 0);
    assert.equal(atStart.segment.id, 'obraz');
    assert.equal(atStart.segmentElapsed, 0);
    assert.equal(atStart.segmentRemaining, 300);

    const midFace = segmentAt(schedule, 150);
    assert.equal(midFace.index, 0);
    assert.equal(midFace.segmentElapsed, 150);
    assert.equal(midFace.segmentRemaining, 150);

    const inBack = segmentAt(schedule, 1900);
    assert.equal(inBack.segment.id, 'hrbet');
    assert.equal(inBack.segmentElapsed, 100);
    assert.equal(inBack.segmentRemaining, 800);
});

test('segmentAt boundaries: start-inclusive, end-exclusive, done past 3600', () => {
    const schedule = buildSchedule();
    assert.equal(segmentAt(schedule, 299).index, 0);
    assert.equal(segmentAt(schedule, 299).segmentRemaining, 1);

    const handoff = segmentAt(schedule, 300);
    assert.equal(handoff.index, 1);
    assert.equal(handoff.segmentElapsed, 0);
    assert.equal(handoff.segmentRemaining, 300);

    const flip = segmentAt(schedule, 1800);
    assert.equal(flip.index, 6);
    assert.equal(flip.segment.id, 'hrbet');

    assert.equal(segmentAt(schedule, 3599).index, schedule.length - 1);

    for (const past of [3600, 5000]) {
        const done = segmentAt(schedule, past);
        assert.equal(done.done, true);
        assert.equal(done.index, schedule.length);
        assert.equal(done.segment, null);
        assert.equal(done.segmentRemaining, 0);
    }

    assert.equal(segmentAt(schedule, -5).index, 0);
    assert.equal(segmentAt(schedule, -5).segmentElapsed, 0);
});

test('formatTime renders M:SS, flooring floats and clamping negatives', () => {
    assert.equal(formatTime(0), '0:00');
    assert.equal(formatTime(59), '0:59');
    assert.equal(formatTime(60), '1:00');
    assert.equal(formatTime(75), '1:15');
    assert.equal(formatTime(900), '15:00');
    assert.equal(formatTime(3600), '60:00');
    assert.equal(formatTime(-5), '0:00');
    assert.equal(formatTime(89.9), '1:29');
});

test('a started session measures elapsed wall-clock seconds', () => {
    const session = startSession(T0);
    assert.equal(session.paused, false);
    assert.equal(elapsedSeconds(session, T0), 0);
    assert.equal(elapsedSeconds(session, T0 + 90_000), 90);
    assert.equal(elapsedSeconds(session, T0 + 90_500), 90.5);
});

test('pausing freezes elapsed time no matter how much later we look', () => {
    const running = startSession(T0);
    const paused = pauseSession(running, T0 + 120_000);
    assert.equal(paused.paused, true);
    assert.equal(elapsedSeconds(paused, T0 + 120_000), 120);
    assert.equal(elapsedSeconds(paused, T0 + 999_000), 120);
});

test('resume continues from the banked time; repeated cycles accumulate exactly', () => {
    let s = startSession(T0);
    s = pauseSession(s, T0 + 60_000);              // 60s in, pause
    s = resumeSession(s, T0 + 300_000);            // long break
    assert.equal(elapsedSeconds(s, T0 + 330_000), 90); // +30s running
    s = pauseSession(s, T0 + 360_000);             // +60s running => 120 banked
    s = resumeSession(s, T0 + 400_000);
    assert.equal(elapsedSeconds(s, T0 + 415_000), 135);
});

test('skipToNext jumps a running session to the current segment boundary', () => {
    const schedule = buildSchedule();
    let s = startSession(T0);
    // 2 minutes into the face segment; skipping lands exactly at its end (300s)
    s = skipToNext(s, schedule, T0 + 120_000);
    assert.equal(elapsedSeconds(s, T0 + 120_000), 300);
    const at = segmentAt(schedule, elapsedSeconds(s, T0 + 120_000));
    assert.equal(at.index, 1);
    assert.equal(at.segmentElapsed, 0);
    assert.equal(s.paused, false);
    // time keeps flowing after the skip
    assert.equal(elapsedSeconds(s, T0 + 130_000), 310);
});

test('skipToNext while paused stays paused at the boundary', () => {
    const schedule = buildSchedule();
    let s = startSession(T0);
    s = pauseSession(s, T0 + 30_000);
    s = skipToNext(s, schedule, T0 + 60_000);
    assert.equal(s.paused, true);
    assert.equal(elapsedSeconds(s, T0 + 999_000), 300);
});

test('skipToNext inside the last segment lands on done; when done it is a no-op', () => {
    const schedule = buildSchedule();
    let s = startSession(T0);
    s = skipToNext(s, schedule, T0 + 3_500_000); // inside stopala
    assert.equal(elapsedSeconds(s, T0 + 3_500_000), 3600);
    assert.equal(segmentAt(schedule, elapsedSeconds(s, T0 + 3_500_000)).done, true);

    const after = skipToNext(s, schedule, T0 + 3_600_000);
    assert.deepEqual(after, s);
});

test('pause on paused and resume on running are no-ops; inputs are not mutated', () => {
    const running = startSession(T0);
    const stillRunning = resumeSession(running, T0 + 50_000);
    assert.deepEqual(stillRunning, running);

    const paused = pauseSession(running, T0 + 10_000);
    const stillPaused = pauseSession(paused, T0 + 99_000);
    assert.deepEqual(stillPaused, paused);

    assert.deepEqual(running, { anchor: T0, banked: 0, paused: false });
    assert.equal(elapsedSeconds(paused, T0 + 500_000), 10);
});
