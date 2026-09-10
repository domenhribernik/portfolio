// Every method in the Peal library is a factual claim: a real name attached to
// a real place notation. This suite rings each one from rounds and refuses any
// entry whose course does not come home true at the length it says it does, so
// a mistyped notation fails here rather than shipping under a name it is not.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { METHODS, methodsForStage, libraryStages, methodByKey } from '../views/peal/methods.js';
import { analyseMethod, bellPath, expandNotation } from '../views/peal/logic.js';

test('every method rings a true plain course at its stated length', () => {
    for (const m of METHODS) {
        const a = analyseMethod(m.notation, m.stage);
        assert.equal(a.true, true, `${m.name} is untrue: a row repeats inside the plain course`);
        assert.equal(a.courseLength, m.changes, `${m.name} rings ${a.courseLength} changes, not ${m.changes}`);
        assert.equal(a.leads, m.leads, `${m.name} has ${a.leads} leads, not ${m.leads}`);
    }
});

test('a lead divides the course exactly', () => {
    for (const m of METHODS) {
        const a = analyseMethod(m.notation, m.stage);
        assert.equal(a.leadLength * a.leads, a.courseLength, `${m.name} does not divide into whole leads`);
    }
});

test('the treble hunts in the way each class requires', () => {
    const expected = {
        Plain: 'plain hunt',
        Court: 'plain hunt',
        'Treble Bob': 'treble bob hunt',
        Surprise: 'treble bob hunt'
    };
    for (const m of METHODS) {
        const want = expected[m.class];
        if (!want) continue;
        const a = analyseMethod(m.notation, m.stage);
        assert.equal(a.treble, want, `${m.name} is a ${m.class} method, so its treble should ${want}, not ${a.treble}`);
    }
});

test('a principle has no hunt bell at all', () => {
    for (const m of METHODS.filter((x) => x.class === 'Principle')) {
        const a = analyseMethod(m.notation, m.stage);
        assert.equal(a.treble, 'working', `${m.name} is a principle, so nothing should hunt`);
    }
});

test('in a principle every bell rings the same line, only starting elsewhere', () => {
    // This is what "principle" means, and it is why Stedman is in the library:
    // rotate the treble's path far enough and it lands exactly on any other
    // bell's path. Nothing hunts, because everything does the same work.
    const stedman = methodByKey('stedman-5');
    const a = analyseMethod(stedman.notation, stedman.stage);
    const len = a.courseLength;
    const treble = bellPath(a.rows, 1).slice(0, len);

    for (let bell = 2; bell <= stedman.stage; bell++) {
        const path = bellPath(a.rows, bell).slice(0, len);
        let offset = -1;
        for (let s = 0; s < len; s++) {
            if (treble.every((place, i) => place === path[(i + s) % len])) { offset = s; break; }
        }
        assert.notEqual(offset, -1, `bell ${bell} does not ring the treble's line at any offset`);
        assert.equal(offset % 12, 0, `bell ${bell} starts ${offset} rows in, which is not a whole division`);
    }
});

test('every bell visits every place at least once in a Surprise course', () => {
    for (const m of METHODS.filter((x) => x.class === 'Surprise')) {
        const a = analyseMethod(m.notation, m.stage);
        for (let bell = 1; bell <= m.stage; bell++) {
            const visited = new Set(bellPath(a.rows, bell));
            assert.equal(visited.size, m.stage, `${m.name}: bell ${bell} never reaches every place`);
        }
    }
});

test('Double Norwich is double: inverting the places gives the method back', () => {
    // A double method is one where turning the tower upside down changes
    // nothing: swap place p for place n+1-p through a whole lead and you get
    // the same lead again, started from somewhere else. Very few methods do it,
    // and this is the property the name is claiming.
    const m = methodByKey('double-norwich-8');
    const lead = expandNotation(m.notation, m.stage);
    const print = (changes) => changes.map((c) => (c.length ? c.join('') : 'x')).join('.');
    const inverted = lead.map((change) => change.map((p) => m.stage + 1 - p).sort((a, b) => a - b));

    let offset = -1;
    for (let s = 0; s < lead.length; s++) {
        const rotated = lead.map((_, i) => lead[(i + s) % lead.length]);
        if (print(rotated) === print(inverted)) { offset = s; break; }
    }
    assert.notEqual(offset, -1, 'Double Norwich is not double, so either the notation or the name is wrong');
    assert.equal(offset, lead.length / 2, 'the inverted lead should start exactly half a lead along');
});

test('method keys are unique and lookups work', () => {
    const keys = METHODS.map((m) => m.key);
    assert.equal(new Set(keys).size, keys.length, 'two methods share a key');
    assert.equal(methodByKey('cambridge-6').name, 'Cambridge Surprise Minor');
    assert.equal(methodByKey('nothing-here'), null);
});

test('the library covers the stages the tower offers', () => {
    assert.deepEqual(libraryStages(), [5, 6, 7, 8]);
    for (const stage of libraryStages()) {
        assert.ok(methodsForStage(stage).length > 0, `nothing to ring on ${stage}`);
        assert.ok(methodsForStage(stage).every((m) => m.stage === stage));
    }
});

test('every method carries a note that reads as a sentence, with no em dashes', () => {
    for (const m of METHODS) {
        assert.ok(m.note.length > 40, `${m.name} has no real note`);
        assert.ok(m.note.trim().endsWith('.'), `${m.name}'s note does not end in a full stop`);
        assert.ok(!m.note.includes('—'), `${m.name}'s note uses an em dash`);
    }
});
