// Unit tests for the Medication logic (views/medication/logic.js), the private
// admin-only medication tracker. Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    todayIso, shiftIso, parseDateInput, toDateInput, fmtDate,
    FORMS, formLabel, isActiveOn, activeMeds,
    takenSlots, nextSlotToTake, slotToUntake, filledNotches, lastTakenAt, fmtClock,
    dayProgress, buildDay, describeSchedule, buildHistory, streak, validateMed,
} from '../views/medication/logic.js';

test('todayIso reads the local day, not the UTC one', () => {
    // 01:30 on 9 September in CEST (UTC+2) is still 23:30 on the 8th in UTC.
    // Slicing an ISO string would file this dose under yesterday and break the
    // streak every morning, so the local getters are load-bearing.
    const earlyMorning = new Date(2026, 8, 9, 1, 30, 0);
    assert.equal(todayIso(earlyMorning), '2026-09-09');
    assert.notEqual(todayIso(earlyMorning), earlyMorning.toISOString().slice(0, 10));
});

test('todayIso pads single-digit months and days', () => {
    assert.equal(todayIso(new Date(2026, 0, 5, 12, 0, 0)), '2026-01-05');
});

test('shiftIso steps days without drifting across a DST boundary', () => {
    assert.equal(shiftIso('2026-09-08', -1), '2026-09-07');
    assert.equal(shiftIso('2026-09-08', 1), '2026-09-09');
    assert.equal(shiftIso('2026-03-01', -1), '2026-02-28');
    // CEST ends on 25 October 2026; a local-time step would land back on the 25th.
    assert.equal(shiftIso('2026-10-25', 1), '2026-10-26');
    assert.equal(shiftIso('2026-01-01', -1), '2025-12-31');
});

test('parseDateInput accepts the day-first form the field asks for', () => {
    assert.equal(parseDateInput('08.09.2026'), '2026-09-08');
    assert.equal(parseDateInput('8.9.2026'), '2026-09-08');
    assert.equal(parseDateInput(' 8 / 9 / 2026 '), '2026-09-08');
    assert.equal(parseDateInput('08092026'), '2026-09-08', 'a bare digit run from a numeric keypad');
    assert.equal(parseDateInput('2026-09-08'), '2026-09-08', 'a pasted machine date still lands');
});

test('parseDateInput rejects a day that does not exist rather than rolling it', () => {
    assert.equal(parseDateInput('31.02.2026'), null);
    assert.equal(parseDateInput('32.01.2026'), null);
    assert.equal(parseDateInput('01.13.2026'), null);
    assert.equal(parseDateInput(''), null);
    assert.equal(parseDateInput('tomorrow'), null);
    assert.equal(parseDateInput(null), null);
});

test('toDateInput renders the padded form the field carries, and round-trips', () => {
    assert.equal(toDateInput('2026-09-08'), '08.09.2026');
    assert.equal(toDateInput('2026-09-08 00:00:00'), '08.09.2026', 'a DATETIME from the wire');
    assert.equal(toDateInput(null), '');
    assert.equal(toDateInput('nonsense'), '');
    assert.equal(parseDateInput(toDateInput('2026-01-05')), '2026-01-05');
});

test('fmtDate reads as prose, unpadded', () => {
    assert.equal(fmtDate('2026-09-08'), '8. 9. 2026');
    assert.equal(fmtDate(null), '');
});

test('FORMS is a closed allowlist the server can mirror', () => {
    assert.ok(FORMS.length >= 5, 'enough shapes to cover a real shelf');
    assert.deepEqual(
        FORMS.map((f) => f.key),
        ['tablet', 'capsule', 'drops', 'spray', 'injection', 'other'],
    );
    for (const f of FORMS) {
        assert.match(f.key, /^[a-z]+$/, `${f.key} is a plain slug`);
        assert.ok(f.label && f.icon, `${f.key} carries a label and an icon`);
    }
    assert.equal(formLabel('drops'), 'Drops');
    assert.equal(formLabel('nonsense'), 'Other', 'an unknown form degrades, never blanks the row');
});

test('isActiveOn treats a course with no dates as always running', () => {
    const med = { starts_on: null, ends_on: null, created_on: '2026-09-01' };
    assert.equal(isActiveOn(med, '2026-09-08'), true);
    assert.equal(isActiveOn(med, '2030-01-01'), true);
});

test('isActiveOn honours an explicit start and end, inclusive on both edges', () => {
    const med = { starts_on: '2026-09-05', ends_on: '2026-09-10', created_on: '2026-09-01' };
    assert.equal(isActiveOn(med, '2026-09-04'), false, 'the day before it starts');
    assert.equal(isActiveOn(med, '2026-09-05'), true, 'the first day counts');
    assert.equal(isActiveOn(med, '2026-09-10'), true, 'the last day counts');
    assert.equal(isActiveOn(med, '2026-09-11'), false, 'the day after it ends');
});

test('isActiveOn falls back to the day the medication was created', () => {
    // Without this the 14-day history strip invents missed doses for days
    // before the medication existed, and the streak can never start.
    const med = { starts_on: null, ends_on: null, created_on: '2026-09-06' };
    assert.equal(isActiveOn(med, '2026-09-05'), false, 'it did not exist yet');
    assert.equal(isActiveOn(med, '2026-09-06'), true);
    assert.equal(isActiveOn(med, '2026-09-07'), true);
});

test('an explicit start wins over the created fallback, in both directions', () => {
    const backdated = { starts_on: '2026-09-01', ends_on: null, created_on: '2026-09-06' };
    assert.equal(isActiveOn(backdated, '2026-09-03'), true, 'a course entered late is still backdated');

    const future = { starts_on: '2026-09-20', ends_on: null, created_on: '2026-09-06' };
    assert.equal(isActiveOn(future, '2026-09-10'), false, 'a course that has not begun');
});

test('activeMeds filters the shelf down to the given day', () => {
    const meds = [
        { id: 1, name: 'Magnesium', starts_on: null, ends_on: null, created_on: '2026-09-01' },
        { id: 2, name: 'Amoxicillin', starts_on: '2026-09-01', ends_on: '2026-09-07', created_on: '2026-09-01' },
    ];
    assert.deepEqual(activeMeds(meds, '2026-09-05').map((m) => m.id), [1, 2]);
    assert.deepEqual(activeMeds(meds, '2026-09-08').map((m) => m.id), [1], 'the course has finished');
    assert.deepEqual(activeMeds([], '2026-09-08'), []);
});

test('takenSlots collects one medication\'s slots, sorted, ignoring the rest', () => {
    const taken = [
        { med_id: 1, slot: 2, taken_at: '2026-09-08 20:00:00' },
        { med_id: 2, slot: 0, taken_at: '2026-09-08 09:00:00' },
        { med_id: 1, slot: 0, taken_at: '2026-09-08 08:00:00' },
    ];
    assert.deepEqual(takenSlots(taken, 1), [0, 2]);
    assert.deepEqual(takenSlots(taken, 2), [0]);
    assert.deepEqual(takenSlots(taken, 99), []);
});

test('nextSlotToTake fills the lowest free notch', () => {
    assert.equal(nextSlotToTake([], 3), 0);
    assert.equal(nextSlotToTake([0], 3), 1);
    assert.equal(nextSlotToTake([0, 1], 3), 2);
    assert.equal(nextSlotToTake([1], 3), 0, 'a gap is closed before a new slot is opened');
    assert.equal(nextSlotToTake([0, 2], 3), 1);
});

test('nextSlotToTake refuses to go past the day\'s dose count', () => {
    assert.equal(nextSlotToTake([0, 1, 2], 3), null);
    assert.equal(nextSlotToTake([0], 1), null);
    assert.equal(nextSlotToTake([0, 1, 2, 3], 2), null, 'already over cap after a schedule cut');
});

test('slotToUntake releases the highest taken notch, and is a no-op when empty', () => {
    assert.equal(slotToUntake([0, 1, 2]), 2);
    assert.equal(slotToUntake([0, 2]), 2, 'the orphan slot goes first');
    assert.equal(slotToUntake([0]), 0);
    assert.equal(slotToUntake([]), null);
});

test('filledNotches renders as a gapless counter, capped at the schedule', () => {
    // Slots are interchangeable, so the row is a counter with N notches rather
    // than N addressable checkboxes. A gap left by an old schedule must never
    // draw a hole, and an over-count must never draw a sixth notch on a
    // five-notch row.
    assert.equal(filledNotches([], 3), 0);
    assert.equal(filledNotches([0, 2], 3), 2, 'two doses taken reads as two full notches');
    assert.equal(filledNotches([0, 1, 2, 3], 2), 2, 'capped after the schedule was cut');
});

test('lastTakenAt is the most recent stamp for that medication', () => {
    const taken = [
        { med_id: 1, slot: 0, taken_at: '2026-09-08 08:12:00' },
        { med_id: 1, slot: 1, taken_at: '2026-09-08 20:04:00' },
        { med_id: 2, slot: 0, taken_at: '2026-09-08 23:00:00' },
    ];
    assert.equal(lastTakenAt(taken, 1), '2026-09-08 20:04:00');
    assert.equal(lastTakenAt(taken, 99), null);
});

test('fmtClock shows the wall time a dose was taken', () => {
    assert.equal(fmtClock('2026-09-08 08:12:00'), '08:12');
    assert.equal(fmtClock('2026-09-08 20:04:33'), '20:04');
    assert.equal(fmtClock(null), '');
    assert.equal(fmtClock('rubbish'), '');
});

const SHELF = [
    { id: 1, name: 'Magnesium', form: 'tablet', doses_per_day: 2, starts_on: null, ends_on: null, created_on: '2026-09-01' },
    { id: 2, name: 'Vitamin D', form: 'drops', doses_per_day: 1, starts_on: null, ends_on: null, created_on: '2026-09-01' },
    { id: 3, name: 'Amoxicillin', form: 'capsule', doses_per_day: 3, starts_on: '2026-09-01', ends_on: '2026-09-05', created_on: '2026-09-01' },
];

test('dayProgress counts only what is scheduled on that day', () => {
    assert.deepEqual(
        dayProgress(SHELF, [], '2026-09-08'),
        { taken: 0, planned: 3, complete: false },
        'the finished course is out of the denominator',
    );
    assert.deepEqual(
        dayProgress(SHELF, [], '2026-09-03'),
        { taken: 0, planned: 6, complete: false },
        'while the course runs it counts',
    );
});

test('dayProgress adds up taken doses and closes the day', () => {
    const taken = [
        { med_id: 1, slot: 0, taken_at: '2026-09-08 08:00:00' },
        { med_id: 1, slot: 1, taken_at: '2026-09-08 20:00:00' },
    ];
    assert.deepEqual(dayProgress(SHELF, taken, '2026-09-08'), { taken: 2, planned: 3, complete: false });

    const all = [...taken, { med_id: 2, slot: 0, taken_at: '2026-09-08 09:00:00' }];
    assert.deepEqual(dayProgress(SHELF, all, '2026-09-08'), { taken: 3, planned: 3, complete: true });
});

test('dayProgress ignores rows belonging to a medication not scheduled that day', () => {
    // The antibiotic finished on the 5th; a stray row on the 8th must not
    // inflate the count past what was actually planned.
    const taken = [{ med_id: 3, slot: 0, taken_at: '2026-09-08 08:00:00' }];
    assert.deepEqual(dayProgress(SHELF, taken, '2026-09-08'), { taken: 0, planned: 3, complete: false });
});

test('dayProgress never reports more taken than planned after a schedule cut', () => {
    const cut = [{ id: 1, name: 'Magnesium', form: 'tablet', doses_per_day: 1, starts_on: null, ends_on: null, created_on: '2026-09-01' }];
    const taken = [
        { med_id: 1, slot: 0, taken_at: '2026-09-08 08:00:00' },
        { med_id: 1, slot: 1, taken_at: '2026-09-08 20:00:00' },
    ];
    assert.deepEqual(dayProgress(cut, taken, '2026-09-08'), { taken: 1, planned: 1, complete: true });
});

test('an empty shelf is not a complete day', () => {
    assert.deepEqual(dayProgress([], [], '2026-09-08'), { taken: 0, planned: 0, complete: false });
});

test('buildDay hands the view one ready row per scheduled medication', () => {
    const taken = [{ med_id: 1, slot: 0, taken_at: '2026-09-08 08:12:00' }];
    const rows = buildDay(SHELF, taken, '2026-09-08');

    assert.deepEqual(rows.map((r) => r.id), [1, 2], 'the finished course is gone');
    assert.deepEqual(rows[0], {
        id: 1,
        name: 'Magnesium',
        form: 'tablet',
        formLabel: 'Tablet',
        formIcon: 'fa-solid fa-tablets',
        dosesPerDay: 2,
        schedule: 'Twice a day',
        slots: [0],
        filled: 1,
        done: false,
        lastAt: '08:12',
    });
    assert.equal(rows[1].done, false);
    assert.equal(rows[1].lastAt, '');
});

test('buildDay marks a medication done once its notches are full', () => {
    const taken = [{ med_id: 2, slot: 0, taken_at: '2026-09-08 09:00:00' }];
    const row = buildDay(SHELF, taken, '2026-09-08').find((r) => r.id === 2);
    assert.equal(row.done, true);
    assert.equal(row.filled, 1);
});

test('describeSchedule reads as English, not as a number', () => {
    assert.equal(describeSchedule(1), 'Once a day');
    assert.equal(describeSchedule(2), 'Twice a day');
    assert.equal(describeSchedule(3), '3 times a day');
    assert.equal(describeSchedule(12), '12 times a day');
});

// The server groups the window as one row per day per medication, and the
// capping and the denominator are worked out here, so the active-course rules
// live in exactly one place instead of being restated in SQL.
const HISTORY = [
    { day: '2026-09-06', med_id: 1, taken: 2 },
    { day: '2026-09-06', med_id: 2, taken: 1 },
    { day: '2026-09-07', med_id: 1, taken: 1 },
    { day: '2026-09-08', med_id: 1, taken: 2 },
    { day: '2026-09-08', med_id: 2, taken: 1 },
];

test('buildHistory returns the window oldest first, one entry per day', () => {
    const strip = buildHistory(SHELF, HISTORY, '2026-09-08', 4);
    assert.deepEqual(strip.map((d) => d.day), ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08']);
});

test('buildHistory scores each day against what was scheduled then', () => {
    const strip = buildHistory(SHELF, HISTORY, '2026-09-08', 4);
    const byDay = Object.fromEntries(strip.map((d) => [d.day, d]));

    assert.deepEqual(byDay['2026-09-05'], { day: '2026-09-05', taken: 0, planned: 6, complete: false },
        'the antibiotic was still running, so the denominator is 6');
    assert.deepEqual(byDay['2026-09-06'], { day: '2026-09-06', taken: 3, planned: 3, complete: true });
    assert.deepEqual(byDay['2026-09-07'], { day: '2026-09-07', taken: 1, planned: 3, complete: false });
    assert.deepEqual(byDay['2026-09-08'], { day: '2026-09-08', taken: 3, planned: 3, complete: true });
});

test('buildHistory caps a day at what was planned, and drops unscheduled rows', () => {
    const strip = buildHistory(SHELF, [
        { day: '2026-09-08', med_id: 1, taken: 9 },
        { day: '2026-09-08', med_id: 3, taken: 3 },
    ], '2026-09-08', 1);
    assert.equal(strip[0].taken, 2, 'capped at the two magnesium doses; the finished course does not count');
    assert.equal(strip[0].planned, 3);
});

test('streak counts back from today and stops at the first missed day', () => {
    assert.equal(streak(SHELF, HISTORY, '2026-09-08'), 1, 'the 7th was missed');
});

test('an unfinished today does not break the streak, a missed yesterday does', () => {
    // Opening the app at 09:00 with the evening dose still to come must not
    // read as a broken streak; that is the whole point of tracking it.
    const yesterdayOnly = [
        { day: '2026-09-06', med_id: 1, taken: 2 },
        { day: '2026-09-06', med_id: 2, taken: 1 },
        { day: '2026-09-07', med_id: 1, taken: 2 },
        { day: '2026-09-07', med_id: 2, taken: 1 },
    ];
    assert.equal(streak(SHELF, yesterdayOnly, '2026-09-08'), 2, 'the 6th and 7th, today still open');

    const takenToday = [...yesterdayOnly, { day: '2026-09-08', med_id: 1, taken: 2 }, { day: '2026-09-08', med_id: 2, taken: 1 }];
    assert.equal(streak(SHELF, takenToday, '2026-09-08'), 3, 'today closed and joins the run');
});

test('streak is zero on an empty shelf and on a fresh one', () => {
    assert.equal(streak([], [], '2026-09-08'), 0);
    assert.equal(streak(SHELF, [], '2026-09-08'), 0);
});

test('a day with nothing scheduled neither counts nor breaks the streak', () => {
    const course = [
        { id: 9, name: 'Amoxicillin', form: 'capsule', doses_per_day: 1, starts_on: '2026-09-01', ends_on: '2026-09-02', created_on: '2026-09-01' },
    ];
    const done = [
        { day: '2026-09-01', med_id: 9, taken: 1 },
        { day: '2026-09-02', med_id: 9, taken: 1 },
    ];
    assert.equal(streak(course, done, '2026-09-08'), 2, 'the finished course keeps its two days');
});

test('validateMed accepts a complete medication and normalises it', () => {
    const r = validateMed({ name: '  Magnesium  ', form: 'tablet', doses_per_day: '2', starts_on: '01.09.2026', ends_on: '' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, {});
    assert.deepEqual(r.value, {
        name: 'Magnesium',
        form: 'tablet',
        doses_per_day: 2,
        starts_on: '2026-09-01',
        ends_on: null,
    });
});

test('validateMed defaults a bare medication to one tablet a day, no dates', () => {
    const r = validateMed({ name: 'Vitamin D' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { name: 'Vitamin D', form: 'tablet', doses_per_day: 1, starts_on: null, ends_on: null });
});

test('validateMed requires a name and caps its length', () => {
    assert.deepEqual(validateMed({ name: '   ' }).errors.name, 'Give it a name.');
    assert.deepEqual(validateMed({}).errors.name, 'Give it a name.');
    const long = validateMed({ name: 'x'.repeat(101) });
    assert.equal(long.ok, false);
    assert.match(long.errors.name, /100/);
    assert.equal(validateMed({ name: 'x'.repeat(100) }).ok, true, 'exactly 100 is fine');
});

test('validateMed holds doses per day to a real schedule', () => {
    assert.match(validateMed({ name: 'A', doses_per_day: 0 }).errors.doses_per_day, /1 and 12/);
    assert.match(validateMed({ name: 'A', doses_per_day: 13 }).errors.doses_per_day, /1 and 12/);
    assert.match(validateMed({ name: 'A', doses_per_day: 2.5 }).errors.doses_per_day, /1 and 12/);
    assert.match(validateMed({ name: 'A', doses_per_day: 'lots' }).errors.doses_per_day, /1 and 12/);
    assert.equal(validateMed({ name: 'A', doses_per_day: 12 }).ok, true);
});

test('validateMed rejects a form outside the allowlist', () => {
    assert.match(validateMed({ name: 'A', form: 'suppository' }).errors.form, /form/i);
    for (const f of FORMS) {
        assert.equal(validateMed({ name: 'A', form: f.key }).ok, true, `${f.key} is accepted`);
    }
});

test('validateMed rejects an unreadable date rather than silently dropping it', () => {
    // Silently storing null would look like "no end date" and quietly keep a
    // finished course on the Today list for ever.
    assert.match(validateMed({ name: 'A', starts_on: '31.02.2026' }).errors.starts_on, /date/i);
    assert.match(validateMed({ name: 'A', ends_on: 'soon' }).errors.ends_on, /date/i);
});

test('validateMed rejects a course that ends before it starts', () => {
    const r = validateMed({ name: 'A', starts_on: '10.09.2026', ends_on: '05.09.2026' });
    assert.equal(r.ok, false);
    assert.match(r.errors.ends_on, /before/i);
    assert.equal(validateMed({ name: 'A', starts_on: '05.09.2026', ends_on: '05.09.2026' }).ok, true,
        'a one-day course is legitimate');
});
