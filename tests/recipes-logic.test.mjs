// Unit tests for the recipes view's decision logic (views/recipes/logic.js).
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseTokens, usedIngredientKeys, nextIngKey, replaceTokenWithText,
    stripDanglingTokens, validateDraft, buildPayload, fmtTimer, timerState,
    createCookSession, advance, back, isLastStep, starFill, avgLabel,
} from '../views/recipes/logic.js';

// --- Tokens ---

test('parseTokens splits text and ingredient tokens in order', () => {
    assert.deepEqual(parseTokens('Whisk the {ing:2} into the {ing:1} gently'), [
        { type: 'text', text: 'Whisk the ' },
        { type: 'ing', key: 2 },
        { type: 'text', text: ' into the ' },
        { type: 'ing', key: 1 },
        { type: 'text', text: ' gently' },
    ]);
});

test('parseTokens treats malformed tokens as plain text', () => {
    assert.deepEqual(parseTokens('{ing:} and {ing:9x} and {ing 3}'), [
        { type: 'text', text: '{ing:} and {ing:9x} and {ing 3}' },
    ]);
    assert.deepEqual(parseTokens(''), []);
    assert.deepEqual(parseTokens(null), []);
    assert.deepEqual(parseTokens('{ing:7}'), [{ type: 'ing', key: 7 }]);
});

test('usedIngredientKeys collects keys across all steps', () => {
    const steps = [
        { body: 'Mix {ing:1} and {ing:3}' },
        { body: 'Rest the dough' },
        { body: 'Fold in {ing:3} again' },
    ];
    assert.deepEqual([...usedIngredientKeys(steps)].sort(), [1, 3]);
    assert.equal(usedIngredientKeys([]).size, 0);
});

test('nextIngKey is one past the highest key, even after deletions', () => {
    assert.equal(nextIngKey([]), 1);
    assert.equal(nextIngKey([{ key: 1 }, { key: 2 }]), 3);
    // Ingredient 3 was deleted, but its key must not be reused.
    assert.equal(nextIngKey([{ key: 1 }, { key: 4 }]), 5);
});

test('replaceTokenWithText swaps every token of that key for the plain name', () => {
    assert.equal(
        replaceTokenWithText('Add {ing:2}, then more {ing:2}. Keep {ing:1}.', 2, 'flour'),
        'Add flour, then more flour. Keep {ing:1}.'
    );
});

test('stripDanglingTokens removes only unknown keys', () => {
    const valid = new Set([1, 2]);
    assert.equal(stripDanglingTokens('Use {ing:1} and {ing:9}', valid), 'Use {ing:1} and ');
    assert.equal(stripDanglingTokens('No tokens here', valid), 'No tokens here');
});

// --- Draft validation and payload ---

const validDraft = () => ({
    title: 'Cinnamon buns',
    description: 'Soft and sweet.',
    ingredients: [
        { key: 1, name: 'Flour', quantity: '500 g' },
        { key: 2, name: 'Milk', quantity: '250 ml' },
    ],
    steps: [
        { body: 'Warm the {ing:2}', minutes: '2' },
        { body: 'Knead with {ing:1}', minutes: '' },
    ],
});

test('validateDraft passes a complete draft', () => {
    assert.deepEqual(validateDraft(validDraft()), []);
});

test('validateDraft requires title, an ingredient, and a step', () => {
    const errors = validateDraft({ title: ' ', ingredients: [], steps: [] });
    assert.equal(errors.length, 3);
});

test('validateDraft ignores blank rows when counting', () => {
    const draft = validDraft();
    draft.ingredients.push({ key: 3, name: '   ', quantity: '' });
    draft.steps.push({ body: '', minutes: '' });
    assert.deepEqual(validateDraft(draft), []);
});

test('validateDraft bounds step durations', () => {
    const draft = validDraft();
    draft.steps[0].minutes = '0';
    assert.equal(validateDraft(draft).length, 1);
    draft.steps[0].minutes = '2000';
    assert.equal(validateDraft(draft).length, 1);
    draft.steps[0].minutes = '1440';
    assert.deepEqual(validateDraft(draft), []);
});

test('buildPayload converts minutes to seconds and skips blank rows', () => {
    const draft = validDraft();
    draft.ingredients.push({ key: 3, name: ' ', quantity: '' });
    draft.steps.push({ body: '  ', minutes: '5' });
    const payload = buildPayload(draft);
    assert.equal(payload.ingredients.length, 2);
    assert.equal(payload.steps.length, 2);
    assert.equal(payload.steps[0].duration_seconds, 120);
    assert.equal(payload.steps[1].duration_seconds, null);
});

test('buildPayload strips tokens that point at skipped blank ingredients', () => {
    const draft = validDraft();
    draft.ingredients[1].name = '  '; // milk row went blank; its token must not survive
    const payload = buildPayload(draft);
    assert.equal(payload.steps[0].body, 'Warm the ');
});

// --- Timers ---

test('fmtTimer renders MM:SS, clamping at zero and rolling into hours', () => {
    assert.equal(fmtTimer(0), '00:00');
    assert.equal(fmtTimer(-3), '00:00');
    assert.equal(fmtTimer(65), '01:05');
    assert.equal(fmtTimer(600), '10:00');
    assert.equal(fmtTimer(3725), '1:02:05');
});

test('timerState counts down against an absolute end time', () => {
    const endAt = 100_000;
    assert.deepEqual(timerState(endAt, 40_000), { remaining: 60, done: false });
    assert.deepEqual(timerState(endAt, 99_500), { remaining: 1, done: false });
    assert.deepEqual(timerState(endAt, 100_000), { remaining: 0, done: true });
    assert.deepEqual(timerState(endAt, 200_000), { remaining: 0, done: true });
});

// --- Cooking session ---

test('cook session advances and backs within bounds', () => {
    let s = createCookSession([{}, {}, {}]);
    assert.equal(s.index, 0);
    assert.equal(isLastStep(s), false);
    s = back(s);
    assert.equal(s.index, 0);
    s = advance(advance(s));
    assert.equal(s.index, 2);
    assert.equal(isLastStep(s), true);
    s = advance(s);
    assert.equal(s.index, 2);
});

test('cook session with a single step is immediately the last step', () => {
    assert.equal(isLastStep(createCookSession([{}])), true);
});

// --- Stars ---

test('starFill rounds the average to the nearest half star', () => {
    assert.deepEqual(starFill(0), ['empty', 'empty', 'empty', 'empty', 'empty']);
    assert.deepEqual(starFill(5), ['full', 'full', 'full', 'full', 'full']);
    assert.deepEqual(starFill(4.5), ['full', 'full', 'full', 'full', 'half']);
    assert.deepEqual(starFill(4.24), ['full', 'full', 'full', 'full', 'empty']);
    assert.deepEqual(starFill(3.75), ['full', 'full', 'full', 'full', 'empty']);
    assert.deepEqual(starFill(null), ['empty', 'empty', 'empty', 'empty', 'empty']);
});

test('avgLabel formats the compact rating text', () => {
    assert.equal(avgLabel(null, 0), 'No ratings yet');
    assert.equal(avgLabel(4, 3), '4 (3)');
    assert.equal(avgLabel(4.33, 3), '4.3 (3)');
});
