// Unit tests for the Beseda drill logic (views/beseda/logic.js): building
// multiple-choice questions and cloze gaps out of the committed vocabulary.
//
// The failure that matters here is a question with two right answers, which
// makes a learner doubt something they actually knew. Randomness is injected
// so every case is reproducible.
//
// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickDistractors, buildQuiz, buildCloze } from '../views/beseda/logic.js';

/** Deterministic stand-in for Math.random. */
function seeded(seed) {
    let t = seed;
    return () => {
        t += 0x6d2b79f5;
        let x = Math.imul(t ^ (t >>> 15), 1 | t);
        x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

// index: [lemma, gloss, pos, gender, rank]
const words = [
    ['pes', 'dog', 'noun', 'm', 959],
    ['mačka', 'cat', 'noun', 'f', 1200],
    ['konj', 'horse', 'noun', 'm', 2100],
    ['krava', 'cow', 'noun', 'f', 3000],
    ['ptica', 'bird', 'noun', 'f', 2500],
    ['hiša', 'house', 'noun', 'f', 700],
    ['pes', 'dog', 'noun', 'm', 4000],   // a duplicate meaning, on purpose
];
const animals = [0, 1, 2, 3, 4];

test('a wrong answer is never the right answer', () => {
    const rng = seeded(1);
    for (let i = 0; i < 50; i += 1) {
        const distractors = pickDistractors(0, animals, words, 3, rng);
        assert.equal(distractors.length, 3);
        assert.ok(!distractors.includes(0));
    }
});

test('no two options can mean the same thing', () => {
    // words[6] is another "dog". Offering it beside words[0] would make two
    // options correct and the learner wrong whichever they pick.
    const distractors = pickDistractors(0, [0, 1, 2, 3, 6], words, 3, seeded(2));
    const glosses = distractors.map((i) => words[i][1]);
    assert.ok(!glosses.includes('dog'));
    assert.equal(new Set(glosses).size, glosses.length);
});

test('a topic too small to fill the options borrows from the wider vocabulary', () => {
    const distractors = pickDistractors(0, [0, 1], words, 3, seeded(3));
    assert.equal(distractors.length, 3);
    assert.ok(!distractors.includes(0));
});

test('the same seed produces the same quiz', () => {
    const a = buildQuiz(animals, words, 5, seeded(7));
    const b = buildQuiz(animals, words, 5, seeded(7));
    assert.deepEqual(a, b);
});

test('a quiz asks in both directions and always contains its answer', () => {
    const quiz = buildQuiz(animals, words, 5, seeded(11));
    assert.equal(quiz.length, 5);
    for (const question of quiz) {
        assert.ok(question.options.includes(question.answer));
        assert.equal(question.options.length, 4);
        assert.equal(new Set(question.options).size, 4);
        assert.ok(['slToEn', 'enToSl'].includes(question.direction));
    }
    assert.ok(new Set(quiz.map((q) => q.direction)).size > 1, 'should not be all one direction');
});

test('a quiz never asks the same word twice', () => {
    const quiz = buildQuiz(animals, words, 5, seeded(13));
    assert.equal(new Set(quiz.map((q) => q.answer)).size, quiz.length);
});

test('a quiz cannot be longer than the words available', () => {
    assert.equal(buildQuiz([0, 1], words, 10, seeded(17)).length, 2);
    assert.deepEqual(buildQuiz([], words, 10, seeded(17)), []);
});

test('a cloze blanks one glossed word and offers it back', () => {
    const sentence = ['Danes je lep dan.', 'Today is a nice day.',
                      [[0, 5, 0], [6, 8, 1], [9, 12, 2], [13, 16, 3]]];
    const cloze = buildCloze(sentence, [0, 1, 2, 3, 4], words, seeded(19));
    assert.ok(cloze.options.includes(cloze.answer));
    assert.equal(cloze.options.length, 4);
    // Exactly one span is blanked, and the rest of the sentence survives
    // intact, so filling the gap back in restores what the corpus said. Note
    // the blanked segment holds the inflected form as it appears in the
    // sentence, which is not the lemma the options are labelled with.
    const blanks = cloze.segments.filter((s) => s.blank);
    assert.equal(blanks.length, 1);
    assert.equal(cloze.segments.map((s) => s.text).join(''), 'Danes je lep dan.');
    assert.ok(['Danes', 'je', 'lep', 'dan'].includes(blanks[0].text));
});

test('a sentence with nothing glossed cannot become a cloze', () => {
    assert.equal(buildCloze(['Xyzzy!', 'Xyzzy!', [[0, 5, -1]]], [0, 1], words, seeded(23)), null);
});
