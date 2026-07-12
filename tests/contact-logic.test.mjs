import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateContact } from '../views/homepage/contact-logic.js';

test('valid submission passes and returns trimmed values', () => {
    const r = validateContact({ name: '  Ada  ', email: ' ada@example.com ', message: ' Hi there ' });
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, {});
    assert.equal(r.clean.name, 'Ada');
    assert.equal(r.clean.email, 'ada@example.com');
    assert.equal(r.clean.message, 'Hi there');
});

test('blank name is rejected', () => {
    const r = validateContact({ name: '   ', email: 'a@b.co', message: 'hello' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.name);
});

test('missing name field is rejected', () => {
    const r = validateContact({ email: 'a@b.co', message: 'hello' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.name);
});

test('malformed email is rejected', () => {
    for (const email of ['nope', 'a@b', 'a b@c.co', '@b.co', 'a@.co']) {
        const r = validateContact({ name: 'Ada', email, message: 'hello' });
        assert.equal(r.valid, false, `expected ${email} invalid`);
        assert.ok(r.errors.email);
    }
});

test('blank message is rejected', () => {
    const r = validateContact({ name: 'Ada', email: 'a@b.co', message: '   ' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.message);
});

test('over-length fields are rejected', () => {
    const long = (n) => 'x'.repeat(n);
    assert.ok(validateContact({ name: long(121), email: 'a@b.co', message: 'hi' }).errors.name);
    assert.ok(validateContact({ name: 'Ada', email: long(255) + '@b.co', message: 'hi' }).errors.email);
    assert.ok(validateContact({ name: 'Ada', email: 'a@b.co', message: long(4001) }).errors.message);
});

test('all three errors reported at once', () => {
    const r = validateContact({ name: '', email: 'bad', message: '' });
    assert.equal(r.valid, false);
    assert.deepEqual(Object.keys(r.errors).sort(), ['email', 'message', 'name']);
});
