/* Unit tests for views/seo/logic.js (the SEO checklist's pure logic), plus
   schema validation of the committed views/seo/checklist.json.
   Run with: node --test tests/ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    STATUS_VALUES,
    TIER_WEIGHT,
    nextStatus,
    pageScore,
    overallScore,
    requirementCoverage,
    nextActions,
    filterPages,
    validateChecklist,
} from '../views/seo/logic.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const REQS = [
    { id: 'title', label: 'Title', weight: 3 },
    { id: 'og', label: 'OG', weight: 2 },
    { id: 'cwv', label: 'CWV', weight: 1 },
];

const page = (path, tier, status, notes) => ({ path, name: path, tier, status, notes });

test('pageScore weights statuses and excludes na from the denominator', () => {
    const p = page('a', 'public', { title: 'done', og: 'partial', cwv: 'na' });
    // (3*1 + 2*0.5) / (3+2) = 4/5
    assert.equal(pageScore(p, REQS), 0.8);
});

test('pageScore returns null when everything is na', () => {
    const p = page('a', 'private', { title: 'na', og: 'na', cwv: 'na' });
    assert.equal(pageScore(p, REQS), null);
});

test('unknown scores zero like todo', () => {
    const p = page('a', 'public', { title: 'unknown', og: 'todo', cwv: 'done' });
    assert.equal(pageScore(p, REQS), 1 / 6);
});

test('overallScore weights flagship pages heavier', () => {
    const pages = [
        page('flag', 'flagship', { title: 'done' }),
        page('pub', 'public', { title: 'todo' }),
    ];
    // (3*3*1 + 3*1*0) / (3*3 + 3*1) = 9/12
    assert.equal(overallScore(pages, REQS), 0.75);
    assert.equal(TIER_WEIGHT.flagship, 3);
});

test('requirementCoverage counts statuses and owed pages', () => {
    const pages = [
        page('a', 'public', { title: 'done' }),
        page('b', 'public', { title: 'todo' }),
        page('c', 'public', { title: 'partial' }),
        page('d', 'private', { title: 'na' }),
        page('e', 'public', {}),
    ];
    const c = requirementCoverage('title', pages);
    assert.equal(c.done, 1);
    assert.equal(c.todo, 1);
    assert.equal(c.partial, 1);
    assert.equal(c.na, 1);
    assert.equal(c.missing, 1);
    assert.equal(c.owed, 2);
});

test('nextActions ranks by tier weight times requirement weight', () => {
    const pages = [
        page('pub', 'public', { title: 'todo', og: 'todo' }),
        page('flag', 'flagship', { og: 'todo', cwv: 'unknown' }),
    ];
    const actions = nextActions(pages, REQS, 10);
    // flagship og: 3*2=6, pub title: 1*3=3, pub og: 1*2=2, flag cwv unknown: 3*1*0.5=1.5
    assert.deepEqual(actions.map(a => `${a.path}:${a.requirement}`),
        ['flag:og', 'pub:title', 'pub:og', 'flag:cwv']);
    assert.equal(actions[0].urgency, 6);
});

test('nextActions carries notes and truncates to n', () => {
    const pages = [page('a', 'public', { title: 'todo', og: 'todo' }, { title: 'fix me' })];
    const actions = nextActions(pages, REQS, 1);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].note, 'fix me');
});

test('filterPages by tier, by owed requirement, and by both', () => {
    const pages = [
        page('flag', 'flagship', { title: 'done', og: 'todo' }),
        page('pub', 'public', { title: 'todo', og: 'done' }),
    ];
    assert.deepEqual(filterPages(pages, { tier: 'flagship' }).map(p => p.path), ['flag']);
    assert.deepEqual(filterPages(pages, { requirement: 'og' }).map(p => p.path), ['flag']);
    assert.deepEqual(filterPages(pages, { requirement: 'title', status: 'done' }).map(p => p.path), ['flag']);
    assert.equal(filterPages(pages).length, 2);
});

test('nextStatus cycles through every status', () => {
    let s = 'todo';
    const seen = new Set();
    for (let i = 0; i < STATUS_VALUES.length; i++) {
        seen.add(s);
        s = nextStatus(s);
    }
    assert.equal(seen.size, STATUS_VALUES.length);
    assert.equal(s, 'todo');
});

test('validateChecklist flags structural problems', () => {
    assert.ok(validateChecklist(null).length > 0);
    const errors = validateChecklist({
        requirements: [{ id: 'x', label: 'X', weight: 1 }, { id: 'x', label: 'X2', weight: 0 }],
        pages: [
            { path: 'a', name: 'A', tier: 'nope', status: { y: 'done', x: 'sideways' } },
            { path: 'a', name: 'A2', tier: 'public', status: {} },
        ],
    });
    assert.ok(errors.some(e => e.includes('duplicate requirement id')));
    assert.ok(errors.some(e => e.includes('weight')));
    assert.ok(errors.some(e => e.includes('bad tier')));
    assert.ok(errors.some(e => e.includes('unknown requirement: y')));
    assert.ok(errors.some(e => e.includes('bad status x=sideways')));
    assert.ok(errors.some(e => e.includes('duplicate page path')));
});

test('the committed checklist.json is valid', () => {
    const doc = JSON.parse(readFileSync(join(ROOT, 'views/seo/checklist.json'), 'utf8'));
    assert.deepEqual(validateChecklist(doc), []);
    // and it scores: every tier is represented and the overall score computes
    assert.ok(overallScore(doc.pages, doc.requirements) > 0);
    for (const tier of ['flagship', 'public', 'private']) {
        assert.ok(doc.pages.some(p => p.tier === tier), `has a ${tier} page`);
    }
});
