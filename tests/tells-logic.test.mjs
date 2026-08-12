// Unit tests for the Tells field-guide logic (views/tells/logic.js): catalog
// validation, the quadrant grid, the drill builders and the review scheduler.
//
// The failures that matter here are content failures, because the catalog is
// hand-authored prose: a question with two defensible answers, a "confused
// with" pointer that only goes one way, an entry whose examples all come from
// the same scene (which teaches the scene, not the technique). Randomness is
// injected so every case is reproducible.
//
// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    validateCatalog,
    quadrantOf, QUADRANTS,
    indexCatalog,
    searchEntries,
    nextExample,
    pickDistractors,
    buildSpotQuiz,
    buildDiscriminationDrill,
    buildCounterDrill,
    buildAdversaryDrill,
    CONFIDENCE, gradeFrom, overconfident,
    newCard, schedule, dueCards,
    calibration,
    tellOfTheDay,
    addDays,
} from '../views/tells/logic.js';

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

/** A minimal entry that passes every rule; override one field per test. */
const entry = (over = {}) => ({
    id: 'strawman',
    no: 1,
    name: 'Strawman',
    aka: [],
    family: 'fallacy',
    axis: { site: 'argument', intent: 'accident' },
    gist: 'Refuting a weaker position than the one actually held.',
    how: 'The position is restated in a form that is easier to knock down, then knocked down.',
    tell: 'Their summary of your view is one you would not sign your name to.',
    examples: [
        { text: 'a', scene: 'standup', also: [] },
        { text: 'b', scene: 'politics', also: [] },
        { text: 'c', scene: 'standup', also: [] },
    ],
    counter: ['Ask them to restate your position before responding to it.'],
    confusedWith: [],
    exploitOf: null,
    parent: null,
    play: null,
    source: '',
    ...over,
});

/** A whole catalog around one or more entries. */
const catalog = (entries) => ({ version: 1, entries });

test('a well formed catalog has nothing wrong with it', () => {
    assert.deepEqual(validateCatalog(catalog([entry()])), []);
});

test('ids and plate numbers must be unique', () => {
    // The id is the URL hash and the deck key; the plate number is printed on
    // the card. Reusing either silently merges two entries in the UI.
    const dupeId = validateCatalog(catalog([entry(), entry({ no: 2 })]));
    assert.ok(dupeId.some((e) => /duplicate id: strawman/.test(e)), dupeId.join('; '));

    const dupeNo = validateCatalog(catalog([entry(), entry({ id: 'other' })]));
    assert.ok(dupeNo.some((e) => /duplicate plate number: 1/.test(e)), dupeNo.join('; '));
});

test('an entry needs a name, a family, a gist, a mechanism and a tell', () => {
    for (const field of ['name', 'family', 'gist', 'how', 'tell']) {
        const errors = validateCatalog(catalog([entry({ [field]: '' })]));
        assert.ok(errors.some((e) => e.includes(field)), `${field}: ${errors.join('; ')}`);
    }
    const badFamily = validateCatalog(catalog([entry({ family: 'vibes' })]));
    assert.ok(badFamily.some((e) => /bad family: vibes/.test(e)));
});

test('the gist stays one short sentence', () => {
    // It is printed on the grid cell and on the card back. Past ~140 chars it
    // wraps to three lines and stops being a gist.
    const errors = validateCatalog(catalog([entry({ gist: 'x'.repeat(141) })]));
    assert.ok(errors.some((e) => /gist is 141 chars/.test(e)), errors.join('; '));
});

test('no prose field may contain an em dash', () => {
    // The repo-wide writing rule, enforced mechanically rather than by memory:
    // 48 hand-written entries is exactly where it would quietly slip in.
    const errors = validateCatalog(catalog([entry({ gist: 'Refuting a weaker position — not the real one.' })]));
    assert.ok(errors.some((e) => /em dash/.test(e)), errors.join('; '));

    const inCounter = validateCatalog(catalog([entry({ counter: ['Ask them — politely.'] })]));
    assert.ok(inCounter.some((e) => /em dash/.test(e)), inCounter.join('; '));
});

test('examples must span at least two scenes', () => {
    // The transfer requirement. Debiasing training that never leaves one
    // setting teaches the setting: subjects learn "in a standup, this is
    // anchoring" and recognise nothing at a checkout. Three examples all
    // staged in the same place is the shape that failure takes in a catalog,
    // so the validator refuses it.
    const oneScene = validateCatalog(catalog([entry({
        examples: [
            { text: 'a', scene: 'standup', also: [] },
            { text: 'b', scene: 'standup', also: [] },
            { text: 'c', scene: 'standup', also: [] },
        ],
    })]));
    assert.ok(oneScene.some((e) => /at least 2 scenes/.test(e)), oneScene.join('; '));

    const tooFew = validateCatalog(catalog([entry({
        examples: [
            { text: 'a', scene: 'standup', also: [] },
            { text: 'b', scene: 'politics', also: [] },
        ],
    })]));
    assert.ok(tooFew.some((e) => /at least 3 examples/.test(e)), tooFew.join('; '));

    const badScene = validateCatalog(catalog([entry({
        examples: [
            { text: 'a', scene: 'standup', also: [] },
            { text: 'b', scene: 'politics', also: [] },
            { text: 'c', scene: 'the pub', also: [] },
        ],
    })]));
    assert.ok(badScene.some((e) => /bad scene: the pub/.test(e)), badScene.join('; '));
});

test('an entry must offer at least one counter', () => {
    // The field no other resource has. An entry without it is half a lesson.
    const errors = validateCatalog(catalog([entry({ counter: [] })]));
    assert.ok(errors.some((e) => /at least one counter/.test(e)), errors.join('; '));
});

//? A near-miss pair: strawman and steelman, each pointing at the other.
const pair = (overA = {}, overB = {}) => [
    entry({
        confusedWith: [{ id: 'nutpicking', because: 'both misrepresent', tell: 'a strawman invents, nutpicking selects' }],
        ...overA,
    }),
    entry({
        id: 'nutpicking', no: 2, name: 'Nutpicking',
        confusedWith: [{ id: 'strawman', because: 'both misrepresent', tell: 'nutpicking quotes someone real' }],
        ...overB,
    }),
];

test('a near-miss pointer must resolve and must point back', () => {
    assert.deepEqual(validateCatalog(catalog(pair())), []);

    const dangling = validateCatalog(catalog([entry({
        confusedWith: [{ id: 'ghost', because: 'x', tell: 'y' }],
    })]));
    assert.ok(dangling.some((e) => /unknown confusedWith: ghost/.test(e)), dangling.join('; '));

    // One-way pointers are the classic hand-authoring bug: you add "reminds me
    // of X" to one entry and never go back to X. The discrimination drill draws
    // from these pairs, so a one-way link means a drill that only ever runs in
    // one direction and a near-miss the other card never warns you about.
    const oneWay = validateCatalog(catalog(pair({}, { confusedWith: [] })));
    assert.ok(oneWay.some((e) => /nutpicking does not point back/.test(e)), oneWay.join('; '));
});

test('an exploit twin must sit on the other side of the intent axis', () => {
    // A bias is the vulnerability, a tactic is the exploit. Anchoring the bias
    // and anchoring the opening offer are the same phenomenon seen from both
    // ends, and the pairing is only meaningful if the two really do differ in
    // intent. Linking two accidents together means one of them is mislabelled.
    const good = [
        entry({ id: 'anchoring', no: 1, axis: { site: 'judgment', intent: 'accident' }, family: 'bias', exploitOf: 'anchor-opening' }),
        entry({ id: 'anchor-opening', no: 2, axis: { site: 'judgment', intent: 'deliberate' }, family: 'tactic', exploitOf: 'anchoring', play: 'You want their counter to land higher than it should.' }),
    ];
    assert.deepEqual(validateCatalog(catalog(good)), []);

    const sameIntent = [
        entry({ id: 'anchoring', no: 1, axis: { site: 'judgment', intent: 'accident' }, exploitOf: 'twin' }),
        entry({ id: 'twin', no: 2, axis: { site: 'judgment', intent: 'accident' }, exploitOf: 'anchoring' }),
    ];
    const errors = validateCatalog(catalog(sameIntent));
    assert.ok(errors.some((e) => /same intent/.test(e)), errors.join('; '));

    const oneWay = validateCatalog(catalog([
        entry({ id: 'anchoring', no: 1, axis: { site: 'judgment', intent: 'accident' }, exploitOf: 'twin' }),
        entry({ id: 'twin', no: 2, axis: { site: 'judgment', intent: 'deliberate' }, exploitOf: null, play: 'You want the number to stick.' }),
    ]));
    assert.ok(oneWay.some((e) => /twin does not point back/.test(e)), oneWay.join('; '));
});

test('a parent must be a heuristic, because heuristics sit above biases', () => {
    const good = [
        entry({ id: 'availability', no: 1, family: 'bias', axis: { site: 'judgment', intent: 'accident' }, parent: 'availability-heuristic' }),
        entry({ id: 'availability-heuristic', no: 2, family: 'heuristic', axis: { site: 'judgment', intent: 'accident' } }),
    ];
    assert.deepEqual(validateCatalog(catalog(good)), []);

    const notHeuristic = validateCatalog(catalog([
        entry({ id: 'availability', no: 1, parent: 'strawman' }),
        entry({ id: 'strawman', no: 2, family: 'fallacy' }),
    ]));
    assert.ok(notHeuristic.some((e) => /parent strawman is a fallacy/.test(e)), notHeuristic.join('; '));
});

test('an example may name other entries that also apply, and they must exist', () => {
    // `also` is what keeps the drill honest: it lists the labels that are ALSO
    // defensible for this example, so the option builder can refuse to offer
    // them beside the answer.
    const errors = validateCatalog(catalog([entry({
        examples: [
            { text: 'a', scene: 'standup', also: ['ghost'] },
            { text: 'b', scene: 'politics', also: [] },
            { text: 'c', scene: 'standup', also: [] },
        ],
    })]));
    assert.ok(errors.some((e) => /unknown also: ghost/.test(e)), errors.join('; '));

    const selfRef = validateCatalog(catalog([entry({
        examples: [
            { text: 'a', scene: 'standup', also: ['strawman'] },
            { text: 'b', scene: 'politics', also: [] },
            { text: 'c', scene: 'standup', also: [] },
        ],
    })]));
    assert.ok(selfRef.some((e) => /also lists its own entry/.test(e)), selfRef.join('; '));
});

//? ── The grid ────────────────────────────────────────────────────────────────

test('every combination of the two axes lands in its own quadrant', () => {
    assert.equal(quadrantOf(entry({ axis: { site: 'argument', intent: 'accident' } })), 'fallacy');
    assert.equal(quadrantOf(entry({ axis: { site: 'argument', intent: 'deliberate' } })), 'rhetoric');
    assert.equal(quadrantOf(entry({ axis: { site: 'judgment', intent: 'accident' } })), 'bias');
    assert.equal(quadrantOf(entry({ axis: { site: 'judgment', intent: 'deliberate' } })), 'exploit');
});

test('an entry that straddles the intent axis lands on the seam, not in a cell', () => {
    // Survivorship bias is honestly both: usually the missing data is just
    // invisible, sometimes someone chose the sample. Forcing it into one cell
    // would teach a distinction the entry itself says does not hold.
    assert.equal(quadrantOf(entry({ axis: { site: 'judgment', intent: 'both' } })), 'seam-judgment');
    assert.equal(quadrantOf(entry({ axis: { site: 'argument', intent: 'both' } })), 'seam-argument');
});

test('every quadrant key the grid can produce has a label to print', () => {
    for (const key of ['fallacy', 'rhetoric', 'bias', 'exploit', 'seam-argument', 'seam-judgment']) {
        assert.ok(QUADRANTS[key]?.label, `no label for ${key}`);
    }
});

//? ── The index ───────────────────────────────────────────────────────────────

//? A small catalog with one of everything the index has to resolve. Counters
//? are distinct per entry because the counter drill offers other entries'
//? counters as the wrong answers, and two identical options is no question.
const world = () => catalog([
    entry({ id: 'strawman', no: 1, name: 'Strawman', exploitOf: 'strawmanning',
        counter: ['Ask them to restate your position first.'],
        confusedWith: [{ id: 'cherry', because: 'b', tell: 't' }] }),
    entry({ id: 'strawmanning', no: 2, name: 'Strawmanning', family: 'rhetoric',
        axis: { site: 'argument', intent: 'deliberate' }, exploitOf: 'strawman',
        play: 'You want the audience to watch you win, and the real claim is harder to beat.',
        counter: ['Correct the summary once, then name the pattern.'] }),
    entry({ id: 'anchoring', no: 3, name: 'Anchoring', family: 'bias', aka: ['anchor and adjust'],
        axis: { site: 'judgment', intent: 'accident' }, parent: 'availability',
        counter: ['Write your own number down before you hear theirs.'],
        gist: 'The first number you hear drags every later estimate toward it.' }),
    entry({ id: 'availability', no: 4, name: 'Availability heuristic', family: 'heuristic',
        counter: ['Ask for the denominator.'],
        axis: { site: 'judgment', intent: 'accident' } }),
    entry({ id: 'cherry', no: 5, name: 'Cherry-picking', family: 'statistical',
        axis: { site: 'argument', intent: 'both' },
        counter: ['Ask for the selection rule before arguing with the data.'],
        confusedWith: [{ id: 'strawman', because: 'b', tell: 't' }] }),
]);

test('anything deliberate must say what the person doing it wants', () => {
    // The adversary drill runs the play from the other side, and without a
    // stated objective the question degenerates into "name this technique"
    // with extra words. Accidents have no objective, so the rule is only on
    // the deliberate half of the axis.
    const noPlay = validateCatalog(catalog([entry({
        id: 'x', family: 'rhetoric', axis: { site: 'argument', intent: 'deliberate' },
    })]));
    assert.ok(noPlay.some((e) => /needs a play/.test(e)), noPlay.join('; '));

    // An accident needs no play, and may not claim one.
    const accidentWithPlay = validateCatalog(catalog([entry({ play: 'You want to win.' })]));
    assert.ok(accidentWithPlay.some((e) => /accident cannot have a play/.test(e)), accidentWithPlay.join('; '));
});

test('the index is built from a valid catalog and groups by quadrant and family', () => {
    assert.deepEqual(validateCatalog(world()), []);
    const index = indexCatalog(world());

    assert.equal(index.byId.get('anchoring').name, 'Anchoring');
    assert.deepEqual(index.byQuadrant.fallacy.map((e) => e.id), ['strawman']);
    assert.deepEqual(index.byQuadrant.rhetoric.map((e) => e.id), ['strawmanning']);
    assert.deepEqual(index.byQuadrant['seam-argument'].map((e) => e.id), ['cherry']);
    assert.deepEqual(index.byQuadrant.exploit, [], 'an empty quadrant is still a quadrant');
    assert.deepEqual(index.byFamily.bias.map((e) => e.id), ['anchoring']);
});

test('the index hangs the resolved relations off each entry', () => {
    // script.js renders a plate straight from an indexed entry, so every
    // pointer has to already be an object by then. Resolving in the view is
    // how a dangling id becomes a blank space on the page instead of an error.
    const index = indexCatalog(world());
    const strawman = index.byId.get('strawman');

    assert.equal(strawman.twin.id, 'strawmanning');
    assert.equal(strawman.quadrant, 'fallacy');
    assert.deepEqual(strawman.near.map((n) => n.entry.id), ['cherry']);
    assert.equal(strawman.near[0].tell, 't', 'the near-miss keeps its own prose');

    assert.equal(index.byId.get('anchoring').parentEntry.id, 'availability');
    assert.deepEqual(index.byId.get('availability').children.map((e) => e.id), ['anchoring']);
    assert.equal(index.byId.get('cherry').twin, null);
});

test('the index counts what the grid prints on each cell', () => {
    const index = indexCatalog(world());
    assert.equal(index.counts.fallacy, 1);
    assert.equal(index.counts.exploit, 0);
    assert.equal(index.total, 5);
});

//? ── Search ──────────────────────────────────────────────────────────────────

test('search matches a name, an alias and the gist, in that order of merit', () => {
    const index = indexCatalog(world());
    assert.deepEqual(searchEntries(index, 'anchoring').map((e) => e.id), ['anchoring']);
    assert.deepEqual(searchEntries(index, 'anchor and adjust').map((e) => e.id), ['anchoring']);

    // "straw" prefixes two names; the shorter, exact-prefix one comes first.
    assert.deepEqual(searchEntries(index, 'straw').map((e) => e.id), ['strawman', 'strawmanning']);

    // Only the gist mentions estimates, so a gist hit still finds the entry.
    assert.deepEqual(searchEntries(index, 'estimate').map((e) => e.id), ['anchoring']);
});

test('search ignores case, accents and the hyphen people forget', () => {
    const index = indexCatalog(world());
    assert.deepEqual(searchEntries(index, 'CHERRY').map((e) => e.id), ['cherry']);
    assert.deepEqual(searchEntries(index, 'cherry picking').map((e) => e.id), ['cherry']);
    assert.deepEqual(searchEntries(index, 'chérry').map((e) => e.id), ['cherry']);
});

test('an empty query returns the whole guide, and a miss returns nothing', () => {
    const index = indexCatalog(world());
    assert.equal(searchEntries(index, '   ').length, 5);
    assert.deepEqual(searchEntries(index, 'zzzz'), []);
});

//? ── Drills ──────────────────────────────────────────────────────────────────

test('a review never shows an example you have already been asked about', () => {
    // The whole point of scheduling the concept rather than the card. If the
    // same sentence came back every time, you would learn to recognise the
    // sentence, which is exactly the "learned trick" the debiasing literature
    // warns training produces instead of transfer.
    const index = indexCatalog(world());
    const item = index.byId.get('strawman');   // three examples: a, b, c
    const rng = seeded(5);

    const first = nextExample(item, [], rng);
    const second = nextExample(item, [first.text], rng);
    const third = nextExample(item, [first.text, second.text], rng);
    assert.equal(new Set([first.text, second.text, third.text]).size, 3);
});

test('once every example has been seen the pool starts over rather than running dry', () => {
    const index = indexCatalog(world());
    const item = index.byId.get('strawman');
    const all = item.examples.map((e) => e.text);
    const again = nextExample(item, all, seeded(6));
    assert.ok(all.includes(again.text), 'should reuse rather than return nothing');
});

test('a distractor is never the answer, and never a label that also fits', () => {
    // `also` lists the entries that are genuinely defensible for this example.
    // Offering one beside the answer makes the learner wrong whichever they
    // pick, and teaches them to distrust a distinction they had right.
    const index = indexCatalog(world());
    const rng = seeded(7);
    for (let i = 0; i < 50; i += 1) {
        const options = pickDistractors(index, 'strawman', ['cherry'], 3, rng);
        assert.equal(options.length, 3);
        assert.ok(!options.includes('strawman'));
        assert.ok(!options.includes('cherry'), 'offered a label that also applies');
        assert.equal(new Set(options).size, 3, 'offered the same option twice');
    }
});

test('distractors prefer the entries this one is genuinely confused with', () => {
    // A random wrong answer teaches nothing. The near-miss is where the
    // category actually lives, so it should be on the card whenever it is
    // not itself a defensible answer for this example.
    const index = indexCatalog(world());
    const options = pickDistractors(index, 'cherry', [], 3, seeded(8));
    assert.ok(options.includes('strawman'), 'the declared near-miss should be offered');
});

test('a spot-it question carries an example, four options and exactly one answer', () => {
    const index = indexCatalog(world());
    const quiz = buildSpotQuiz(index, 4, seeded(9));

    assert.equal(quiz.length, 4);
    for (const q of quiz) {
        assert.equal(q.mode, 'spot');
        assert.equal(q.options.length, 4);
        assert.equal(new Set(q.options).size, 4);
        assert.ok(q.options.includes(q.answer));
        assert.ok(q.example.text, 'a question with no example is not a question');
        for (const also of q.example.also || []) {
            assert.ok(!q.options.includes(also), `offered ${also}, which also fits`);
        }
    }
});

test('a spot-it round never asks about the same entry twice', () => {
    const index = indexCatalog(world());
    const quiz = buildSpotQuiz(index, 5, seeded(10));
    assert.equal(new Set(quiz.map((q) => q.answer)).size, quiz.length);
});

test('the same seed builds the same round', () => {
    const index = indexCatalog(world());
    assert.deepEqual(buildSpotQuiz(index, 4, seeded(11)), buildSpotQuiz(index, 4, seeded(11)));
});

test('a round cannot be longer than the guide', () => {
    const index = indexCatalog(world());
    assert.equal(buildSpotQuiz(index, 99, seeded(12)).length, 5);
});

test('a discrimination drill offers exactly the confusable pair', () => {
    // Two options, not four: the question is which of these two, and adding
    // filler would let you win it by elimination instead of by the distinction.
    const index = indexCatalog(world());
    const drill = buildDiscriminationDrill(index, seeded(13));

    assert.equal(drill.mode, 'discriminate');
    assert.equal(drill.options.length, 2);
    assert.ok(drill.options.includes(drill.answer));
    const other = drill.options.find((id) => id !== drill.answer);
    const near = index.byId.get(drill.answer).near.find((n) => n.entry.id === other);
    assert.ok(near, 'the two options should be a declared near-miss pair');
    assert.equal(drill.tell, near.tell, 'the reveal must explain how to separate them');
});

test('a discrimination drill draws only examples the other label does not also fit', () => {
    const index = indexCatalog(world());
    for (let i = 0; i < 30; i += 1) {
        const drill = buildDiscriminationDrill(index, seeded(100 + i));
        const other = drill.options.find((id) => id !== drill.answer);
        assert.ok(!(drill.example.also || []).includes(other), 'the distractor also fits this example');
    }
});

test('a counter drill asks what to do, not what to call it', () => {
    const index = indexCatalog(world());
    const drill = buildCounterDrill(index, seeded(15));

    assert.equal(drill.mode, 'counter');
    assert.ok(drill.entryId, 'the label is given, so the entry is named up front');
    assert.ok(index.byId.get(drill.entryId).counter.includes(drill.answer));
    assert.ok(drill.options.includes(drill.answer));
    assert.equal(new Set(drill.options).size, drill.options.length);
    // Every wrong option is a real counter, just to a different technique.
    for (const option of drill.options) {
        assert.ok(index.entries.some((e) => e.counter.includes(option)), `${option} is not anyone's counter`);
    }
});

test('the adversary drill only ever answers with something someone chose to do', () => {
    // Inverting the task is what inoculation research says confers resistance:
    // you learn the playbook from the manipulator's side. Answering "anchoring"
    // to "how would you move their estimate" would be incoherent, because an
    // accident is not a play anyone can run.
    const index = indexCatalog(world());
    for (let i = 0; i < 30; i += 1) {
        const drill = buildAdversaryDrill(index, seeded(200 + i));
        assert.equal(drill.mode, 'adversary');
        assert.equal(index.byId.get(drill.answer).axis.intent, 'deliberate');
        assert.ok(drill.options.includes(drill.answer));
        assert.ok(drill.goal, 'the drill needs a goal to run the play against');
    }
});

test('a guide with nothing deliberate in it cannot build an adversary drill', () => {
    const onlyAccidents = indexCatalog(catalog([entry({ id: 'a', no: 1 }), entry({ id: 'b', no: 2 })]));
    assert.equal(buildAdversaryDrill(onlyAccidents, seeded(17)), null);
});

//? ── Memory ──────────────────────────────────────────────────────────────────

test('confidence is asked before the reveal and grades the answer with it', () => {
    // Correctness alone cannot tell a solid answer from a lucky one, and a
    // lucky guess scheduled as if it were solid will not come back until it
    // has been forgotten. The confidence you claimed is the missing half.
    assert.equal(gradeFrom(true, 'sure'), 5);
    assert.equal(gradeFrom(true, 'think-so'), 4);
    assert.equal(gradeFrom(true, 'guess'), 3);
    assert.equal(gradeFrom(false, 'guess'), 2);
    assert.equal(gradeFrom(false, 'think-so'), 1);
    assert.equal(gradeFrom(false, 'sure'), 0);
});

test('being sure and wrong is called out, because that is the lesson', () => {
    // The bias blind spot, happening to you, in the one moment it is visible.
    // Everything else in this guide is described; this is demonstrated.
    assert.equal(overconfident(false, 'sure'), true);
    assert.equal(overconfident(false, 'guess'), false);
    assert.equal(overconfident(true, 'sure'), false);
});

test('every confidence level carries the probability it is claiming', () => {
    // The ledger compares the claim against what actually happened, so a level
    // with no number attached could never be scored.
    for (const level of CONFIDENCE) {
        assert.ok(level.key && level.label);
        assert.ok(level.claimed > 0 && level.claimed < 1, `${level.key} claims ${level.claimed}`);
    }
});

test('a new card is due immediately and remembers nothing', () => {
    const card = newCard();
    assert.equal(card.reps, 0);
    assert.equal(card.lapses, 0);
    assert.deepEqual(card.seen, []);
    assert.equal(card.dueIso, null);
});

test('a passed card comes back tomorrow, then in six days, then further out', () => {
    let card = newCard();
    card = schedule(card, 4, '2026-08-08');
    assert.equal(card.interval, 1);
    assert.equal(card.dueIso, '2026-08-09');

    card = schedule(card, 4, '2026-08-09');
    assert.equal(card.interval, 6);
    assert.equal(card.dueIso, '2026-08-15');

    card = schedule(card, 4, '2026-08-15');
    assert.ok(card.interval > 6, 'the third pass should stretch the interval');
    assert.equal(card.dueIso, addDays('2026-08-15', card.interval));
});

test('answering easily stretches the interval faster than answering with effort', () => {
    let easy = newCard();
    let hard = newCard();
    for (const day of ['2026-08-08', '2026-08-09', '2026-08-15']) {
        easy = schedule(easy, 5, day);
        hard = schedule(hard, 3, day);
    }
    assert.ok(easy.interval > hard.interval, `${easy.interval} should beat ${hard.interval}`);
});

test('a wrong answer sends the card back to tomorrow and records the lapse', () => {
    let card = newCard();
    card = schedule(card, 5, '2026-08-08');
    card = schedule(card, 5, '2026-08-09');
    assert.equal(card.interval, 6);

    card = schedule(card, 0, '2026-08-15');
    assert.equal(card.interval, 1, 'a lapse restarts the ladder');
    assert.equal(card.reps, 0);
    assert.equal(card.lapses, 1);
    assert.equal(card.dueIso, '2026-08-16');
});

test('ease drifts with performance but never below the floor', () => {
    // Without a floor a card you keep failing collapses to an interval of one
    // day forever and quietly turns the session into that one card.
    let card = newCard();
    const start = card.ease;
    card = schedule(card, 5, '2026-08-08');
    assert.ok(card.ease > start);

    let punished = newCard();
    for (let i = 0; i < 20; i += 1) punished = schedule(punished, 0, '2026-08-08');
    assert.ok(punished.ease >= 1.3, `ease fell to ${punished.ease}`);
});

test('the example just asked about is remembered on the card', () => {
    const card = schedule(newCard(), 4, '2026-08-08', 'the bus routes one');
    assert.deepEqual(card.seen, ['the bus routes one']);
});

test('a card that has seen every example forgets the list and starts over', () => {
    // `seen` exists to stop repeats inside one pass through the examples. Kept
    // forever it would grow without bound and permanently pin the rotation.
    let card = newCard();
    card = schedule(card, 4, '2026-08-08', 'a');
    card = schedule(card, 4, '2026-08-09', 'b');
    assert.deepEqual(card.seen, ['a', 'b']);

    card = schedule(card, 4, '2026-08-15', 'c', 3);
    assert.deepEqual(card.seen, [], 'the third of three examples wraps the rotation');
});

test('the session serves what is overdue first, then what has never been seen', () => {
    const index = indexCatalog(world());
    const deck = {
        strawman: { ...newCard(), dueIso: '2026-08-01' },     // long overdue
        anchoring: { ...newCard(), dueIso: '2026-08-08' },    // due today
        cherry: { ...newCard(), dueIso: '2026-09-01' },       // not yet
    };
    const due = dueCards(deck, index, '2026-08-08', 10);

    assert.deepEqual(due.slice(0, 2), ['strawman', 'anchoring']);
    assert.ok(!due.includes('cherry'), 'a card that is not due should wait');
    assert.deepEqual([...due].sort(), ['anchoring', 'availability', 'strawman', 'strawmanning'].sort());
});

test('a session is capped, so a month away does not open onto ninety cards', () => {
    const index = indexCatalog(world());
    assert.equal(dueCards({}, index, '2026-08-08', 2).length, 2);
});

//? ── The ledger ──────────────────────────────────────────────────────────────

const answer = (confidence, correct) => ({ iso: '2026-08-08', id: 'x', mode: 'spot', confidence, correct });

test('the ledger compares what you claimed against what happened', () => {
    const log = [
        ...Array(10).fill(answer('sure', true)).slice(0, 6),
        ...Array(4).fill(answer('sure', false)),
        ...Array(2).fill(answer('guess', true)),
    ];
    const rows = calibration(log);

    const sure = rows.find((r) => r.key === 'sure');
    assert.equal(sure.n, 10);
    assert.equal(sure.actual, 0.6);
    assert.equal(sure.claimed, CONFIDENCE.find((c) => c.key === 'sure').claimed);
    assert.ok(sure.gap < 0, 'claiming 0.9 and scoring 0.6 is overconfidence');

    assert.equal(rows.find((r) => r.key === 'guess').n, 2);
    assert.equal(rows.find((r) => r.key === 'think-so'), undefined, 'an unused level is not a row');
});

test('an empty ledger is empty rather than a division by zero', () => {
    assert.deepEqual(calibration([]), []);
});

//? ── The daily card ──────────────────────────────────────────────────────────

test('the tell of the day is the same for everyone and moves once a day', () => {
    // Deterministic from the date so it cannot be rerolled, and so the answer
    // to "what did you get today" is the same on every device.
    const index = indexCatalog(world());
    const epoch = '2026-08-01';

    assert.equal(tellOfTheDay(index.entries, '2026-08-08', epoch).id,
                 tellOfTheDay(index.entries, '2026-08-08', epoch).id);
    assert.notEqual(tellOfTheDay(index.entries, '2026-08-08', epoch).id,
                    tellOfTheDay(index.entries, '2026-08-09', epoch).id);
});

test('the daily card wraps rather than running out, and ignores days before the epoch', () => {
    const index = indexCatalog(world());
    const epoch = '2026-08-01';
    assert.ok(tellOfTheDay(index.entries, '2027-08-08', epoch), 'a year on there should still be a card');
    assert.equal(tellOfTheDay(index.entries, '2026-07-31', epoch), null);
    assert.equal(tellOfTheDay([], '2026-08-08', epoch), null);
});

test('the daily card visits every entry before it repeats one', () => {
    // A fixed stride would have worked at 13 entries and silently cycled
    // through seven of them at 49. The guide is meant to keep growing.
    for (const size of [5, 13, 48, 49, 50, 56, 100]) {
        const entries = Array.from({ length: size }, (_, i) => ({ id: `e${i}` }));
        const seen = new Set();
        for (let day = 0; day < size; day += 1) {
            seen.add(tellOfTheDay(entries, addDays('2026-08-01', day), '2026-08-01').id);
        }
        assert.equal(seen.size, size, `${size} entries covered only ${seen.size} days`);
    }
});
