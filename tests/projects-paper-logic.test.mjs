import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSections,
  primaryLink,
  opensNewTab,
  secondaryLinks,
  splitStories,
  MOBILE_VISIBLE,
} from '../components/projects-paper/logic.js';

/* Minimal registry in insertion order, mirroring project-data.js shape. */
const registry = {
  oldJob: { category: 'professional', title: 'Old Job' },
  paper: { category: 'academic', title: 'Paper' },
  toy: { category: 'passion', title: 'Toy' },
  newJob: { category: 'professional', title: 'New Job' },
};

test('buildSections carries only professional and passion, in that order', () => {
  const sections = buildSections(registry);
  assert.deepEqual(sections.map(s => s.category), ['professional', 'passion']);
  assert.deepEqual(sections.map(s => s.label), [
    'Professional & Freelance',
    'Passion Projects',
  ]);
});

test('buildSections leaves academic entries off the front page entirely', () => {
  const titles = buildSections(registry).flatMap(s => s.entries.map(e => e.title));
  assert.ok(!titles.includes('Paper'));
});

test('buildSections orders entries newest first within a section', () => {
  const pro = buildSections(registry)[0];
  assert.deepEqual(pro.entries.map(e => e.title), ['New Job', 'Old Job']);
});

test('buildSections omits sections with no entries', () => {
  const sections = buildSections({ solo: { category: 'passion', title: 'Solo' } });
  assert.deepEqual(sections.map(s => s.category), ['passion']);
});

test('primaryLink prefers visitSite, then readMore, then code, then demo', () => {
  assert.deepEqual(
    primaryLink({ code: 'c', visitSite: 'v', readMore: 'r' }),
    { kind: 'visitSite', href: 'v' });
  assert.deepEqual(
    primaryLink({ demo: 'd', code: 'c' }),
    { kind: 'code', href: 'c' });
});

test('primaryLink skips blank links and falls back to "#"', () => {
  assert.deepEqual(
    primaryLink({ visitSite: '   ', readMore: 'r' }),
    { kind: 'readMore', href: 'r' });
  assert.deepEqual(primaryLink({}), { kind: null, href: '#' });
  assert.deepEqual(primaryLink(undefined), { kind: null, href: '#' });
});

test('secondaryLinks returns labelled links beyond the primary, in priority order', () => {
  assert.deepEqual(
    secondaryLinks({ code: 'c', visitSite: 'v', demo: 'd' }),
    [
      { kind: 'code', href: 'c', label: 'Code' },
      { kind: 'demo', href: 'd', label: 'Demo' },
    ]);
});

test('secondaryLinks is empty when only the primary link exists', () => {
  assert.deepEqual(secondaryLinks({ visitSite: 'v' }), []);
  assert.deepEqual(secondaryLinks(undefined), []);
});

test('opensNewTab is true for links except local readMore and the fallback', () => {
  assert.equal(opensNewTab('visitSite', {}), true);
  assert.equal(opensNewTab('readMore', {}), true);
  assert.equal(opensNewTab('readMore', { noTarget: 'true' }), false);
  assert.equal(opensNewTab(null, {}), false);
});

test('splitStories folds a long column into lead, briefs, and hidden', () => {
  const entries = ['a', 'b', 'c', 'd', 'e', 'f'];
  const { lead, briefs, hidden } = splitStories(entries, 4);
  assert.equal(lead, 'a');
  assert.deepEqual(briefs, ['b', 'c', 'd']);
  assert.deepEqual(hidden, ['e', 'f']);
});

test('the mobile fold shows five stories per section and hides the rest', () => {
  const entries = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const { hidden } = splitStories(entries, MOBILE_VISIBLE);
  assert.deepEqual(hidden, ['f', 'g']);
  assert.deepEqual(splitStories(['a', 'b', 'c', 'd'], MOBILE_VISIBLE).hidden, []);
});

test('splitStories hides nothing when the column fits', () => {
  assert.deepEqual(splitStories(['a', 'b'], 4), { lead: 'a', briefs: ['b'], hidden: [] });
  assert.deepEqual(splitStories(['a'], 4), { lead: 'a', briefs: [], hidden: [] });
});
