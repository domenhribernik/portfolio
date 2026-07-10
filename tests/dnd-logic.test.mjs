import test from 'node:test';
import assert from 'node:assert/strict';
import { CLASSES, QUESTIONS, scoreQuiz, recommend, toRoman } from '../views/dnd/logic.js';

const CLASS_IDS = Object.keys(CLASSES);

test('there are exactly twelve classes with complete entries', () => {
    assert.equal(CLASS_IDS.length, 12);
    for (const [id, cls] of Object.entries(CLASSES)) {
        for (const field of ['name', 'epithet', 'role', 'ability', 'hitDie', 'blurb', 'tip', 'icon']) {
            assert.ok(cls[field], `${id} is missing ${field}`);
        }
        assert.ok(cls.complexity >= 1 && cls.complexity <= 3, `${id} complexity out of range`);
        assert.equal(cls.goodIf.length, 3, `${id} should have three goodIf entries`);
    }
});

test('every answer weight references a real class and a positive score', () => {
    for (const q of QUESTIONS) {
        assert.ok(q.answers.length >= 3, `${q.id} needs at least three answers`);
        for (const a of q.answers) {
            assert.ok(a.id.startsWith(q.id), `${a.id} should be prefixed by ${q.id}`);
            const entries = Object.entries(a.weights);
            assert.ok(entries.length > 0, `${a.id} has no weights`);
            for (const [classId, weight] of entries) {
                assert.ok(CLASS_IDS.includes(classId), `${a.id} weights unknown class ${classId}`);
                assert.ok(Number.isInteger(weight) && weight > 0, `${a.id} weight for ${classId} must be a positive integer`);
            }
        }
    }
});

test('answer ids are globally unique', () => {
    const ids = QUESTIONS.flatMap(q => q.answers.map(a => a.id));
    assert.equal(new Set(ids).size, ids.length);
});

test('scoreQuiz ranks all classes, sums weights, and sorts descending', () => {
    const ranked = scoreQuiz(['q1a', 'q5b']); // barbarian 3 + 3, fighter 2
    assert.equal(ranked.length, 12);
    assert.equal(ranked[0].id, 'barbarian');
    assert.equal(ranked[0].score, 6);
    assert.equal(ranked[1].id, 'fighter');
    assert.equal(ranked[1].score, 2);
    for (let i = 1; i < ranked.length; i++) {
        assert.ok(ranked[i - 1].score >= ranked[i].score, 'scores must be descending');
    }
});

test('scoreQuiz is deterministic on ties, following registry order', () => {
    const ranked = scoreQuiz([]); // all zeros
    assert.deepEqual(ranked.map(r => r.id), CLASS_IDS);
    assert.ok(ranked.every(r => r.score === 0));
});

test('scoreQuiz ignores unknown answer ids and handles missing input', () => {
    assert.deepEqual(scoreQuiz(['nonsense', 'q99z']), scoreQuiz([]));
    assert.equal(scoreQuiz(undefined).length, 12);
});

test('recommend returns a top class and two distinct runners-up', () => {
    const { top, runnersUp } = recommend(['q4d', 'q6b', 'q2b', 'q1b']);
    assert.equal(top, 'wizard');
    assert.equal(runnersUp.length, 2);
    assert.ok(!runnersUp.includes(top));
    assert.ok(runnersUp.every(id => CLASS_IDS.includes(id)));
});

test('every class can win the quiz with some answer set', () => {
    // Greedy check: for each class, pick the answer with its highest weight
    // in every question and confirm it lands on top.
    for (const classId of CLASS_IDS) {
        const picks = [];
        for (const q of QUESTIONS) {
            let best = null;
            let bestWeight = 0;
            for (const a of q.answers) {
                const w = a.weights[classId] || 0;
                if (w > bestWeight) {
                    best = a.id;
                    bestWeight = w;
                }
            }
            if (best) picks.push(best);
        }
        const ranked = scoreQuiz(picks);
        assert.equal(ranked[0].id, classId, `${classId} cannot win its own greedy answer set (top was ${ranked[0].id})`);
    }
});

test('toRoman covers the question counter range', () => {
    assert.equal(toRoman(1), 'I');
    assert.equal(toRoman(4), 'IV');
    assert.equal(toRoman(8), 'VIII');
    assert.equal(toRoman(9), 'IX');
    assert.equal(toRoman(14), 'XIV');
});
