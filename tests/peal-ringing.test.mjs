// The Peal tower's clock (views/peal/tower.js), driven against a stub bell
// foundry and a fake audio clock so the scheduling, the miss detection and the
// striking match can be held by a test without a browser or a speaker.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ringing } from '../views/peal/tower.js';
import { plainCourse } from '../views/peal/logic.js';

// A tower that records what it was asked to ring and lets a test move time.
class StubTower {
    constructor() { this.ctx = { currentTime: 0 }; this.struck = []; this.silenced = 0; }
    get now() { return this.ctx.currentTime; }
    advance(seconds) { this.ctx.currentTime += seconds; }
    strike(bell, stage, when = null) { this.struck.push({ bell, at: when === null ? this.now : when }); }
    silence() { this.silenced += 1; }
}

// Run a course through without a real timer: tick, step the clock, repeat.
function ring(r, tower, seconds, step = 0.05, between = null) {
    const end = tower.now + seconds;
    while (tower.now < end && r.running) {
        r.tick();
        if (between) between(r, tower);
        tower.advance(step);
    }
}

const minor = () => plainCourse('x16', 6).rows;

test('the tower rings every blow of the course, once', () => {
    const tower = new StubTower();
    const r = new Ringing(tower);
    const rows = minor();
    r.load(rows, 6, 300);
    r.start(0, { auto: false });
    ring(r, tower, 30);
    assert.equal(tower.struck.length, rows.length * 6, 'one blow per bell per row');
    assert.equal(r.running, false, 'it stands its own bells when the course comes round');
});

test('the course comes round rather than being stopped', () => {
    const tower = new StubTower();
    let ended = null;
    const r = new Ringing(tower, { onEnd: (why) => { ended = why; } });
    r.load(minor(), 6, 300);
    r.start(0, { auto: false });
    ring(r, tower, 30);
    assert.equal(ended, 'come round');
});

test('the bell a person has hold of is never rung by the machine', () => {
    const tower = new StubTower();
    const r = new Ringing(tower);
    r.load(minor(), 6, 300, 4);
    r.start(0, { auto: false });
    ring(r, tower, 30);
    assert.equal(tower.struck.some((s) => s.bell === 4), false, 'the fourth rope is the ringer’s');
    assert.equal(r.owed.length, minor().length, 'and they owe one blow per row');
});

test('rows are announced in order and none is skipped', () => {
    const tower = new StubTower();
    const seen = [];
    // onRow is normally handed to a timer so it lands with the sound; here it
    // is delivered straight away so the fake clock can see the whole sequence.
    class Immediate extends Ringing { defer(fn) { fn(); } }
    const r = new Immediate(tower, { onRow: (i) => seen.push(i) });
    r.load(minor(), 6, 300);
    r.start(0, { auto: false });
    ring(r, tower, 30);
    assert.deepEqual(seen, minor().map((_, i) => i), 'every row, in order, exactly once');
});

test('a pull lands on the blow it was aiming at and records the error', () => {
    const tower = new StubTower();
    const r = new Ringing(tower);
    r.load(minor(), 6, 300, 4);
    r.start(0, { auto: false });
    r.tick();

    // The fourth's first blow of the opening row is due after three gaps.
    const due = r.owed[0].at;
    tower.advance((due + 40) / 1000);
    const hit = r.pull();
    assert.equal(hit.matched, true);
    assert.ok(Math.abs(hit.error - 40) < 1, 'forty milliseconds late');
    assert.equal(hit.index, 0);
    assert.ok(Math.abs(r.strikes[0] - 40) < 1);
    assert.ok(tower.struck.some((s) => s.bell === 4), 'and the bell sounds when they pull, not when it was due');
});

test('a pull nowhere near a blow sounds the bell but scores nothing', () => {
    const tower = new StubTower();
    const r = new Ringing(tower);
    r.load(minor(), 6, 300, 4);
    r.start(0, { auto: false });
    r.tick();
    tower.advance(0.05);            // far too early: the fourth is not due yet
    const hit = r.pull();
    assert.equal(hit.matched, false);
    assert.equal(r.strikes[0], null);
    assert.ok(tower.struck.some((s) => s.bell === 4), 'a bell rings whenever the rope is pulled');
});

test('pulling twice for one blow does not score twice', () => {
    const tower = new StubTower();
    const r = new Ringing(tower);
    r.load(minor(), 6, 300, 4);
    r.start(0, { auto: false });
    r.tick();
    tower.advance((r.owed[0].at + 10) / 1000);
    assert.equal(r.pull().matched, true);
    const second = r.pull();
    assert.equal(second.matched, false);
    assert.equal(second.doubled, true);
    assert.ok(Math.abs(r.strikes[0] - 10) < 1, 'the first pull is the one that counts');
});

test('a blow gone past unrung is reported as a miss, once', () => {
    const tower = new StubTower();
    const missed = [];
    const r = new Ringing(tower, { onMiss: (i) => missed.push(i) });
    r.load(minor(), 6, 300, 4);
    r.start(0, { auto: false });
    ring(r, tower, 6);
    assert.ok(missed.length > 0, 'a ringer who never pulls misses blows');
    assert.equal(new Set(missed).size, missed.length, 'and each one is reported only once');
    assert.deepEqual(missed, [...missed].sort((a, b) => a - b), 'in the order they went past');
});

test('standing part way through cuts the bells off', () => {
    const tower = new StubTower();
    let ended = null;
    const r = new Ringing(tower, { onEnd: (why) => { ended = why; } });
    r.load(minor(), 6, 300);
    r.start(0, { auto: false });
    ring(r, tower, 1);
    r.stop();
    assert.equal(ended, 'stood');
    assert.equal(tower.silenced, 1);
    assert.equal(r.running, false);
    const after = tower.struck.length;
    r.tick();
    assert.equal(tower.struck.length, after, 'a stopped ring schedules nothing more');
});

test('a slower speed spreads the same course over more time', () => {
    const quick = new Ringing(new StubTower());
    const slow = new Ringing(new StubTower());
    quick.load(minor(), 6, 250);
    slow.load(minor(), 6, 400);
    assert.equal(quick.blows.length, slow.blows.length);
    assert.ok(slow.blows[slow.blows.length - 1].at > quick.blows[quick.blows.length - 1].at * 1.5);
});

test('loading a new course clears the last one’s striking', () => {
    const tower = new StubTower();
    const r = new Ringing(tower);
    r.load(minor(), 6, 300, 4);
    r.start(0, { auto: false });
    r.tick();
    tower.advance((r.owed[0].at + 5) / 1000);
    r.pull();
    assert.notEqual(r.strikes[0], null);
    r.load(minor(), 6, 300, 2);
    assert.equal(r.strikes.every((s) => s === null), true);
    assert.equal(r.silentBell, 2);
});
