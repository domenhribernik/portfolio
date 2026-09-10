// Unit tests for the Peal tower's ringing engine (views/peal/logic.js).
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    symbolToPlace, placeToSymbol, rowToString, rounds,
    tokenizeBlock, resolvePlaces, expandNotation, applyChange,
    plainCourse, bellPath, isTrue, analyseMethod,
    bellSemitones, bellHz, bellPartials,
    rowOffsetUnits, schedule, blowsForBell,
    bandFor, scoreCourse, matchStrike,
    bellName, stageName, bellBefore
} from '../views/peal/logic.js';

//? Symbols and rows

test('places past nine use the letters ringers use', () => {
    assert.equal(symbolToPlace('9'), 9);
    assert.equal(symbolToPlace('0'), 10);
    assert.equal(symbolToPlace('E'), 11);
    assert.equal(symbolToPlace('T'), 12);
    assert.equal(symbolToPlace('e'), 11, 'lower case should still parse');
    assert.equal(symbolToPlace('#'), 0, 'anything else is not a place');
    assert.equal(placeToSymbol(10), '0');
});

test('a row prints the way a ringer writes it', () => {
    assert.equal(rowToString([1, 3, 5, 2, 6, 4]), '135264');
    assert.equal(rowToString(rounds(8)), '12345678');
    assert.equal(rowToString([1, 2, 10, 11, 12]), '120ET');
});

//? Tokenizing

test('digits run together into one change and x stands alone', () => {
    assert.deepEqual(tokenizeBlock('x16x16x16'), ['x', '16', 'x', '16', 'x', '16']);
    assert.deepEqual(tokenizeBlock('5.1.5.1.5'), ['5', '1', '5', '1', '5']);
    assert.deepEqual(tokenizeBlock('34x34.16x12'), ['34', 'x', '34', '16', 'x', '12']);
    assert.deepEqual(tokenizeBlock('-16-12'), ['x', '16', 'x', '12'], 'a dash means the same as an x');
});

test('a character that is not a place is refused with the character named', () => {
    assert.throws(() => tokenizeBlock('16z'), /"z" is not a place/);
});

//? Implicit places
//
// This is where hand-written notation goes wrong, so it gets the most tests.

test('a lone bell stranded at either end is making a place', () => {
    // "3" on six leaves position 6 with nobody to swap with, so it stands.
    assert.deepEqual(resolvePlaces([3], 6), [3, 6]);
    // "4" on six leaves position 1 stranded at the front.
    assert.deepEqual(resolvePlaces([4], 6), [1, 4]);
    // "1" on five leaves 2,3,4,5 which pair off fine, so nothing is added.
    assert.deepEqual(resolvePlaces([1], 5), [1]);
    // "5" on five: four bells in front pair off, so again nothing is added.
    assert.deepEqual(resolvePlaces([5], 5), [5]);
});

test('places written out in full are left alone', () => {
    assert.deepEqual(resolvePlaces([1, 6], 6), [1, 6]);
    assert.deepEqual(resolvePlaces([1, 2, 5], 5), [1, 2, 5]);
});

test('places are sorted and de-duplicated', () => {
    assert.deepEqual(resolvePlaces([6, 1, 1], 6), [1, 6]);
});

test('a cross needs an even stage', () => {
    assert.deepEqual(resolvePlaces([], 6), []);
    assert.throws(() => resolvePlaces([], 5), /even stage/);
});

test('an odd gap in the middle is a typo, not an implicit place', () => {
    // Places 1 and 3 on six leaves exactly one bell in position 2.
    assert.throws(() => resolvePlaces([1, 3], 6), /cannot pair between places 1 and 3/);
});

test('a place that does not exist on this stage is refused', () => {
    assert.throws(() => expandNotation('18', 6), /place 8 does not exist on 6 bells/);
});

//? Expansion

test('an ampersand block is a palindrome that does not repeat its last change', () => {
    // Six written changes become eleven.
    assert.equal(expandNotation('&x16x16x16', 6).length, 11);
    // Plus the lead end after the comma.
    assert.equal(expandNotation('&x16x16x16,12', 6).length, 12);
    // A block without the ampersand is taken literally.
    assert.equal(expandNotation('x16x16x16', 6).length, 6);
});

test('blocks are expanded in the order they are written', () => {
    // Grandsire opens on a single change and then runs its palindrome.
    const lead = expandNotation('3,&1.5.1.5.1', 5);
    assert.equal(lead.length, 10);
    assert.deepEqual(lead[0], [3], 'the first change is the one before the comma');
    assert.deepEqual(lead[1], [1]);
});

test('empty notation is refused rather than ringing nothing', () => {
    assert.throws(() => expandNotation('   ', 6), /no place notation/);
    assert.throws(() => expandNotation(',,', 6), /no place notation/);
});

//? Applying changes

test('bells not making a place swap with their neighbour', () => {
    assert.deepEqual(applyChange([1, 2, 3, 4, 5, 6], []), [2, 1, 4, 3, 6, 5]);
    // 16 on six: the lead and the back stand, the middle four cross.
    assert.deepEqual(applyChange([2, 1, 4, 3, 6, 5], [1, 6]), [2, 4, 1, 6, 3, 5]);
});

test('the opening rows of Plain Bob Minor are the ones in the book', () => {
    const { rows } = plainCourse('&x16x16x16,12', 6);
    assert.deepEqual(rows.slice(0, 7).map(rowToString), [
        '123456', '214365', '241635', '426153', '462513', '645231', '654321'
    ]);
});

test('the opening rows of Grandsire Doubles are the ones in the book', () => {
    const { rows } = plainCourse('3,&1.5.1.5.1', 5);
    assert.deepEqual(rows.slice(0, 5).map(rowToString), ['12345', '21354', '23145', '32415', '34251']);
});

//? Courses

test('a plain course starts at rounds and ends at rounds', () => {
    const { rows } = plainCourse('&x16x16x16,12', 6);
    assert.equal(rowToString(rows[0]), '123456');
    assert.equal(rowToString(rows[rows.length - 1]), '123456');
    assert.equal(rows.length, 61, 'sixty changes plus the row you started on');
});

test('a course may only close at a lead end, never part way through one', () => {
    // Plain Bob Minor passes through rounds nowhere but the end, but this
    // guards the general rule: the check is on the lead boundary, not the row.
    const a = analyseMethod('&x16x16x16,12', 6);
    assert.equal(a.courseLength % a.leadLength, 0);
});

test('a lead repeated always comes home, because every change undoes itself', () => {
    // A place notation change is its own inverse, so repeating a lead can only
    // ever cycle back to rounds. The engine leans on that: it grinds until
    // rounds turns up at a lead end, and the row cap is a guard against typed
    // nonsense rather than something a method reaches.
    assert.equal(plainCourse('&12', 6).courseLength, 2, 'the shortest course there is');
    // Five changes a lead, so the two crosses at the lead end meet and cancel,
    // and what is left folds back to rounds in two leads rather than six.
    assert.equal(plainCourse('x.16.x.16.x', 6).courseLength, 10);
});

test('a repeated row makes a course untrue', () => {
    assert.equal(isTrue([[1, 2, 3], [2, 1, 3], [1, 2, 3]]), true, 'the closing return to rounds does not count');
    assert.equal(isTrue([[1, 2, 3], [2, 1, 3], [2, 1, 3], [1, 2, 3]]), false);
});

//? The blue line

test('a bell path is that bell’s place in every row', () => {
    const { rows } = plainCourse('x16', 6);
    // Plain hunt: the treble walks out to the back and straight home.
    assert.deepEqual(bellPath(rows, 1), [1, 2, 3, 4, 5, 6, 6, 5, 4, 3, 2, 1, 1]);
});

test('a path never leaves the tower', () => {
    const a = analyseMethod('&x36x14x12x36x14x56,12', 6);
    for (let bell = 1; bell <= 6; bell++) {
        for (const place of bellPath(a.rows, bell)) {
            assert.ok(place >= 1 && place <= 6, `bell ${bell} reached place ${place}`);
        }
    }
});

//? Tuning

test('the treble is the highest bell and the tenor the lowest', () => {
    assert.equal(bellSemitones(6, 6), 0, 'the tenor sits at the bottom of the scale');
    assert.equal(bellSemitones(1, 6), 9, 'a ring of six reaches the sixth of the scale, not the octave');
    assert.equal(bellSemitones(1, 8), 12, 'a ring of eight is a full octave');
    assert.ok(bellHz(1, 8, 261.63) > bellHz(8, 8, 261.63));
});

test('a ring of eight is a descending major scale', () => {
    const steps = [8, 7, 6, 5, 4, 3, 2, 1].map((b) => bellSemitones(b, 8));
    assert.deepEqual(steps, [0, 2, 4, 5, 7, 9, 11, 12]);
});

test('the tenor is the note the tower is named for', () => {
    assert.equal(Math.round(bellHz(8, 8, 261.63)), 262);
});

//? Partials

test('a bell rings the partials a tuner actually cuts', () => {
    const p = bellPartials(400);
    const names = p.map((x) => x.name);
    assert.deepEqual(names.slice(0, 5), ['hum', 'prime', 'tierce', 'quint', 'nominal']);
    const by = Object.fromEntries(p.map((x) => [x.name, x.hz]));
    assert.equal(by.hum, 200, 'the hum is an octave below the strike note');
    assert.equal(by.nominal, 800, 'the nominal is an octave above it');
    assert.equal(Math.round(by.tierce), 480, 'the tierce is a minor third above the prime, which is why bells sound minor');
    assert.equal(by.quint, 600);
});

test('the nominal is the loudest partial and the hum the longest', () => {
    const p = bellPartials(400);
    const loudest = p.reduce((a, b) => (b.gain > a.gain ? b : a));
    const longest = p.reduce((a, b) => (b.seconds > a.seconds ? b : a));
    assert.equal(loudest.name, 'nominal');
    assert.equal(longest.name, 'hum');
});

test('a big bell rings longer than a small one', () => {
    const tenor = bellPartials(220).find((p) => p.name === 'hum');
    const treble = bellPartials(660).find((p) => p.name === 'hum');
    assert.ok(tenor.seconds > treble.seconds * 1.4, 'the tenor should hang on noticeably longer');
});

//? Timing

test('an extra gap falls before every handstroke row but not the first', () => {
    // Row 0 is a handstroke and starts immediately. Row 1 is the backstroke
    // that follows it, six bells later. Row 2 is the next handstroke, and the
    // open handstroke lead pushes it one bell further out.
    assert.equal(rowOffsetUnits(0, 6), 0);
    assert.equal(rowOffsetUnits(1, 6), 6);
    assert.equal(rowOffsetUnits(2, 6), 13);
    assert.equal(rowOffsetUnits(3, 6), 19);
    assert.equal(rowOffsetUnits(4, 6), 26);
});

test('a whole pull on six bells is thirteen bell widths, not twelve', () => {
    assert.equal(rowOffsetUnits(2, 6) - rowOffsetUnits(0, 6), 13);
    assert.equal(rowOffsetUnits(2, 8) - rowOffsetUnits(0, 8), 17);
});

test('the schedule puts every bell of every row on the clock', () => {
    const { rows } = plainCourse('x16', 6);
    const blows = schedule(rows, 6, 300);
    assert.equal(blows.length, rows.length * 6);
    assert.equal(blows[0].at, 0);
    assert.equal(blows[0].bell, 1);
    assert.equal(blows[0].stroke, 'hand');
    assert.equal(blows[5].at, 1500, 'the sixth bell of the opening row');
    assert.equal(blows[6].at, 1800, 'the backstroke row follows with no gap');
    assert.equal(blows[6].stroke, 'back');
    assert.equal(blows[12].at, 3900, 'the next handstroke row waits an extra bell width');
});

test('one ringer only owns their own blows, in order', () => {
    const { rows } = plainCourse('&x16x16x16,12', 6);
    const mine = blowsForBell(schedule(rows, 6, 300), 4);
    assert.equal(mine.length, rows.length, 'one blow per row');
    assert.ok(mine.every((b, i) => i === 0 || b.at > mine[i - 1].at));
    assert.ok(mine.every((b) => b.bell === 4));
});

//? Striking

test('striking bands are measured in milliseconds either side of the blow', () => {
    assert.equal(bandFor(0), 'true');
    assert.equal(bandFor(-24), 'true', 'early counts the same as late');
    assert.equal(bandFor(45), 'close');
    assert.equal(bandFor(-90), 'loose');
    assert.equal(bandFor(400), 'out');
});

test('a course of good striking scores well and reports no drift', () => {
    const s = scoreCourse([10, -8, 5, -12, 3]);
    assert.equal(s.struck, 5);
    assert.equal(s.missed, 0);
    assert.ok(s.rms < 12);
    assert.ok(Math.abs(s.drift) < 3);
    assert.equal(s.bands.true, 5);
    assert.equal(s.accuracy, 1);
});

test('ringing evenly but behind the band is reported as drift, not as inaccuracy', () => {
    // This ringer is 80ms late on every blow. Their spacing is perfect and
    // saying so is more useful than a bad score.
    const s = scoreCourse([80, 80, 80, 80]);
    assert.equal(s.drift, 80);
    assert.equal(s.spread, 0, 'the striking itself is dead even');
    assert.ok(s.rms >= 80, 'the accuracy against the blow is still poor');
});

test('a blow never struck counts against the score', () => {
    const s = scoreCourse([5, null, 5, null]);
    assert.equal(s.struck, 2);
    assert.equal(s.missed, 2);
    assert.equal(s.bands.missed, 2);
    assert.equal(s.accuracy, 0.5);
});

test('a ringer who never pulled at all scores nothing without dividing by zero', () => {
    const s = scoreCourse([null, null]);
    assert.equal(s.rms, null);
    assert.equal(s.drift, null);
    assert.equal(s.accuracy, 0);
    assert.equal(s.missed, 2);
});

test('a keypress is matched to the nearest blow it could have been aiming at', () => {
    const owed = [{ at: 1000 }, { at: 2000 }, { at: 3000 }];
    assert.equal(matchStrike(owed, 1040, 400), 0);
    assert.equal(matchStrike(owed, 1900, 400), 1);
    assert.equal(matchStrike(owed, 2500, 400), -1, 'exactly between two blows and near neither');
    assert.equal(matchStrike(owed, 9000, 400), -1);
});

//? Naming

test('bells are named the way ringers name them', () => {
    assert.equal(bellName(1, 6), 'treble');
    assert.equal(bellName(6, 6), 'tenor');
    assert.equal(bellName(3, 6), '3rd');
    assert.equal(bellName(1, 8), 'treble');
    assert.equal(bellName(6, 8), '6th', 'the sixth is only the tenor on six');
});

test('a number of bells has a name of its own', () => {
    assert.equal(stageName(5), 'doubles');
    assert.equal(stageName(6), 'minor');
    assert.equal(stageName(8), 'major');
    assert.equal(stageName(13), '13 bells');
});

test('a ringer watches the bell in front, and there is none when they lead', () => {
    assert.equal(bellBefore([3, 1, 5, 2, 4], 5), 1);
    assert.equal(bellBefore([3, 1, 5, 2, 4], 3), null);
    assert.equal(bellBefore([3, 1, 5, 2, 4], 9), null, 'a bell that is not in the row');
});
