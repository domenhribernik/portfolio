// Unit tests for the Botaniq watering-schedule logic (views/botaniq/logic.js).
// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getWateringStatus, formatTemp, wateringFrequencyText } from '../views/botaniq/logic.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LAST = '2026-01-01T00:00:00';

// A plant last watered at LAST, with a 5-7 day window unless overridden.
const plant = (over = {}) => ({
    last_watered: LAST,
    watering_min_days: 5,
    watering_max_days: 7,
    ...over,
});

// `days` after LAST, as a Date, so the schedule math is deterministic.
const at = (days) => new Date(new Date(LAST).getTime() + days * DAY_MS);

test('a plant that was never watered is overdue', () => {
    const status = getWateringStatus(plant({ last_watered: null }), at(3));
    assert.equal(status.statusClass, 'status-overdue');
    assert.equal(status.text, 'Never watered');
});

test('freshly watered: counts whole days left until the window opens (ok)', () => {
    const status = getWateringStatus(plant(), at(0));
    assert.equal(status.statusClass, 'status-ok');
    assert.equal(status.text, '5 days left');
});

test('one day is singular in the days-left countdown', () => {
    // 4 days in, min 5 → exactly 1 day (24h) until the window opens.
    const status = getWateringStatus(plant(), at(4));
    assert.equal(status.statusClass, 'status-ok');
    assert.equal(status.text, '1 day left');
});

test('under a day before the window opens switches to an hours countdown (soon)', () => {
    // 4.5 days in, min 5 → 12 hours left.
    const status = getWateringStatus(plant(), at(4.5));
    assert.equal(status.statusClass, 'status-soon');
    assert.equal(status.text, '12 hours left');
});

test('inside the window reports days remaining until the outer bound (soon)', () => {
    // 5.5 days in, window 5-7 → ceil(7 - 5.5) = 2 days.
    const status = getWateringStatus(plant(), at(5.5));
    assert.equal(status.statusClass, 'status-soon');
    assert.equal(status.text, 'Water within 2 days');
});

test('one day or less left in the window reads "today or tomorrow"', () => {
    const status = getWateringStatus(plant(), at(6));
    assert.equal(status.statusClass, 'status-soon');
    assert.equal(status.text, 'Water today or tomorrow');
});

test('exactly at the outer bound is due today (overdue)', () => {
    const status = getWateringStatus(plant(), at(7));
    assert.equal(status.statusClass, 'status-overdue');
    assert.equal(status.text, 'Water today!');
});

test('past the outer bound counts overdue days, singular at one', () => {
    const one = getWateringStatus(plant(), at(8));
    assert.equal(one.statusClass, 'status-overdue');
    assert.equal(one.text, 'Overdue by 1 day');

    const many = getWateringStatus(plant(), at(9.9));
    assert.equal(many.statusClass, 'status-overdue');
    assert.equal(many.text, 'Overdue by 2 days');
});

test('wateringFrequencyText reads a min/max window as a range', () => {
    assert.equal(wateringFrequencyText(5, 7), 'Every 5 to 7 days');
});

test('wateringFrequencyText collapses an equal window to one interval', () => {
    assert.equal(wateringFrequencyText(7, 7), 'Every 7 days');
});

test('wateringFrequencyText says "Every day" for a one-day window', () => {
    assert.equal(wateringFrequencyText(1, 1), 'Every day');
    assert.equal(wateringFrequencyText(1, 3), 'Every 1 to 3 days');
});

test('formatTemp appends °C only when no degree unit is present', () => {
    assert.equal(formatTemp('18-25'), '18-25°C');
    assert.equal(formatTemp('18°C'), '18°C');
    assert.equal(formatTemp('  20 '), '20°C');
    assert.equal(formatTemp(''), '');
    assert.equal(formatTemp(null), '');
});
