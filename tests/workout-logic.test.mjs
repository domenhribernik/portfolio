// Unit tests for the workout view's decision logic (views/workout/logic.js).
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parsePace, formatPace, formatSeconds, formatDistance, formatWeight,
    targetLabel, metricLabel, setKey, stepValue, defaultActuals, initState,
    restoreState, progress, exerciseDone, buildSetPayload, summaryLines,
    countdownRemaining, validateWorkoutDraft, validateExerciseDraft,
} from '../views/workout/logic.js';

const repsItem = { exercise_id: 1, name: 'Push-ups', type: 'reps', target_reps: 15 };
const weightedItem = { exercise_id: 2, name: 'Bench press', type: 'weighted', target_reps: 10, target_weight_kg: 30 };
const timeItem = { exercise_id: 3, name: 'Plank', type: 'time', target_seconds: 45 };
const distanceItem = { exercise_id: 4, name: 'Run', type: 'distance', target_distance_m: 500, target_pace_s_per_km: 275 };

// --- Pace and formatting ---

test('parsePace reads m:ss and mm:ss', () => {
    assert.equal(parsePace('4:35'), 275);
    assert.equal(parsePace('12:00'), 720);
    assert.equal(parsePace(' 5:05 '), 305);
});

test('parsePace rejects malformed input', () => {
    assert.equal(parsePace('4:5'), null);
    assert.equal(parsePace('4:65'), null);
    assert.equal(parsePace('abc'), null);
    assert.equal(parsePace(''), null);
    assert.equal(parsePace(null), null);
    assert.equal(parsePace(275), null);
});

test('formatPace round-trips with parsePace', () => {
    assert.equal(formatPace(275), '4:35');
    assert.equal(parsePace(formatPace(305)), 305);
    assert.equal(formatPace(null), '');
    assert.equal(formatPace(0), '');
});

test('formatSeconds handles minutes and hours', () => {
    assert.equal(formatSeconds(45), '0:45');
    assert.equal(formatSeconds(90), '1:30');
    assert.equal(formatSeconds(3900), '1:05:00');
    assert.equal(formatSeconds(-1), '');
});

test('formatDistance switches to km at 1000 m', () => {
    assert.equal(formatDistance(500), '500 m');
    assert.equal(formatDistance(1000), '1 km');
    assert.equal(formatDistance(1200), '1.2 km');
});

test('formatWeight drops trailing zeros', () => {
    assert.equal(formatWeight(30), '30');
    assert.equal(formatWeight(32.5), '32.5');
});

test('targetLabel covers all four types', () => {
    assert.equal(targetLabel(repsItem), '15 reps');
    assert.equal(targetLabel(weightedItem), '10 x 30 kg');
    assert.equal(targetLabel(timeItem), '0:45');
    assert.equal(targetLabel(distanceItem), '500 m @ 4:35/km');
    assert.equal(targetLabel({ type: 'distance', target_distance_m: 500, target_pace_s_per_km: null }), '500 m');
});

// --- Steppers ---

test('stepValue applies per-field increments', () => {
    assert.equal(stepValue('reps', 15, 1), 16);
    assert.equal(stepValue('weight_kg', 30, 1), 32.5);
    assert.equal(stepValue('weight_kg', 32.5, -1), 30);
    assert.equal(stepValue('seconds', 45, -1), 40);
    assert.equal(stepValue('distance_m', 500, 1), 550);
    assert.equal(stepValue('pace_s_per_km', 275, -1), 270);
});

test('stepValue clamps at bounds', () => {
    assert.equal(stepValue('reps', 1, -1), 1);
    assert.equal(stepValue('weight_kg', 0, -1), 0);
    assert.equal(stepValue('seconds', 5, -1), 5);
    assert.equal(stepValue('distance_m', 50, -1), 50);
    assert.equal(stepValue('pace_s_per_km', 120, -1), 120);
    assert.equal(stepValue('pace_s_per_km', 3600, 1), 3600);
});

// --- Player state ---

test('defaultActuals prefills from targets, pace stays optional', () => {
    assert.deepEqual(defaultActuals(weightedItem), { reps: 10, weight_kg: 30 });
    assert.deepEqual(defaultActuals({ ...distanceItem, target_pace_s_per_km: null }),
        { distance_m: 500, pace_s_per_km: null });
    assert.deepEqual(defaultActuals({ exercise_id: 9, type: 'reps', target_reps: null }), { reps: 1 });
});

test('initState creates one entry per item per round', () => {
    const state = initState([repsItem, timeItem], 3);
    assert.equal(Object.keys(state).length, 6);
    assert.deepEqual(state[setKey(1, 2)], { done: false, actuals: { reps: 15 } });
});

test('progress counts done sets across rounds', () => {
    const items = [repsItem, timeItem];
    const state = initState(items, 3);
    assert.deepEqual(progress(state, items, 3), { done: 0, total: 6, pct: 0 });
    state[setKey(1, 1)].done = true;
    state[setKey(3, 1)].done = true;
    state[setKey(3, 2)].done = true;
    assert.deepEqual(progress(state, items, 3), { done: 3, total: 6, pct: 50 });
    assert.equal(progress({}, [], 3).pct, 0);
});

test('exerciseDone requires every round', () => {
    const state = initState([repsItem], 2);
    state[setKey(1, 1)].done = true;
    assert.equal(exerciseDone(state, 1, 2), false);
    state[setKey(1, 2)].done = true;
    assert.equal(exerciseDone(state, 1, 2), true);
});

test('restoreState marks logged sets done with saved actuals', () => {
    const open = {
        rounds: 3,
        sets: [
            { exercise_id: 2, type: 'weighted', round_number: 1, actual_reps: 8, actual_weight_kg: 35 },
            { exercise_id: 99, type: 'reps', round_number: 1, actual_reps: 5 }, // no longer in workout
        ],
    };
    const state = restoreState(open, [repsItem, weightedItem]);
    assert.deepEqual(state[setKey(2, 1)], { done: true, actuals: { reps: 8, weight_kg: 35 } });
    assert.equal(state[setKey(2, 2)].done, false);
    assert.equal(state[setKey(1, 1)].done, false);
    assert.equal(Object.keys(state).length, 6);
});

test('buildSetPayload sends only the fields the type uses', () => {
    assert.deepEqual(buildSetPayload(timeItem, 2, { seconds: 50, reps: 99 }),
        { exercise_id: 3, round_number: 2, actual_seconds: 50 });
    assert.deepEqual(buildSetPayload(distanceItem, 1, { distance_m: 600, pace_s_per_km: null }),
        { exercise_id: 4, round_number: 1, actual_distance_m: 600 });
});

test('summaryLines reports per-round actuals and skipped exercises', () => {
    const items = [weightedItem, repsItem];
    const state = initState(items, 2);
    state[setKey(2, 1)] = { done: true, actuals: { reps: 10, weight_kg: 30 } };
    state[setKey(2, 2)] = { done: true, actuals: { reps: 8, weight_kg: 32.5 } };
    assert.deepEqual(summaryLines(items, state, 2), [
        { name: 'Bench press', detail: '10 x 30 kg / 8 x 32.5 kg' },
        { name: 'Push-ups', detail: 'skipped' },
    ]);
});

test('metricLabel works on unprefixed actuals', () => {
    assert.equal(metricLabel('distance', { distance_m: 500, pace_s_per_km: 275 }, ''), '500 m @ 4:35/km');
});

test('countdownRemaining floors elapsed and clamps at zero', () => {
    assert.equal(countdownRemaining(0, 30, 4900), 26);
    assert.equal(countdownRemaining(0, 30, 30000), 0);
    assert.equal(countdownRemaining(0, 30, 999999), 0);
});

// --- Draft validation ---

const validDraft = () => ({
    name: 'Push day',
    description: '',
    rounds: 3,
    items: [{ ...weightedItem }, { ...timeItem }],
});

test('validateWorkoutDraft passes a good draft', () => {
    assert.deepEqual(validateWorkoutDraft(validDraft()), []);
});

test('validateWorkoutDraft catches structural problems', () => {
    assert.ok(validateWorkoutDraft({ ...validDraft(), name: ' ' }).includes('Name is required'));
    assert.ok(validateWorkoutDraft({ ...validDraft(), rounds: 0 }).some(e => e.includes('Rounds')));
    assert.ok(validateWorkoutDraft({ ...validDraft(), rounds: 2.5 }).some(e => e.includes('Rounds')));
    assert.ok(validateWorkoutDraft({ ...validDraft(), items: [] }).some(e => e.includes('at least one')));
});

test('validateWorkoutDraft catches duplicate exercises', () => {
    const draft = validDraft();
    draft.items.push({ ...weightedItem });
    assert.ok(validateWorkoutDraft(draft).some(e => e.includes('more than once')));
});

test('validateWorkoutDraft enforces per-type targets', () => {
    const draft = validDraft();
    draft.items[0].target_weight_kg = null;
    assert.ok(validateWorkoutDraft(draft).some(e => e.startsWith('Bench press: Weight')));
    const draft2 = validDraft();
    draft2.items[1].target_seconds = 0;
    assert.ok(validateWorkoutDraft(draft2).some(e => e.startsWith('Plank: Duration')));
    const draft3 = validDraft();
    draft3.items.push({ exercise_id: 4, name: 'Run', type: 'distance', target_distance_m: 500, target_pace_s_per_km: 50 });
    assert.ok(validateWorkoutDraft(draft3).some(e => e.includes('Pace')));
});

test('validateExerciseDraft mirrors server rules', () => {
    assert.deepEqual(validateExerciseDraft({ name: 'Squat', type: 'weighted', icon: 'fas fa-dumbbell', note: '' }), []);
    assert.ok(validateExerciseDraft({ name: '', type: 'reps' }).includes('Name is required'));
    assert.ok(validateExerciseDraft({ name: 'X', type: 'nope' }).includes('Pick a type'));
    assert.ok(validateExerciseDraft({ name: 'X', type: 'reps', icon: '<script>' }).some(e => e.includes('Icon')));
});
