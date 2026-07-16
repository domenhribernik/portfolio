import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURED,
  featuredEntries,
  professionalEntries,
  archiveCount,
} from '../components/projects-index/logic.js';
import { projects } from '../components/project-data.js';

/* The homepage index carries a hand-ranked selection of passion projects.
   The ranking lives in FEATURED as registry keys; this suite runs it
   against the real registry so a renamed or deleted entry fails loudly. */

test('every FEATURED key exists in the live registry, in the agreed order', () => {
  assert.deepEqual(FEATURED, [
    'nebo',
    'tarok',
    'workout',
    'recipes',
    'maze',
    'botaniq',
    'guitarBackingTracks',
  ]);
  for (const key of FEATURED) {
    assert.ok(projects[key], `FEATURED key "${key}" is missing from project-data.js`);
  }
});

test('featuredEntries returns registry entries in FEATURED order', () => {
  const titles = featuredEntries(projects).map(e => e.title);
  assert.equal(titles.length, FEATURED.length);
  assert.equal(titles[0], 'Nebo');
  assert.equal(titles.at(-1), 'Guitar Backing Tracks');
});

test('featuredEntries skips keys the registry no longer has', () => {
  const titles = featuredEntries({ nebo: { title: 'Nebo' } }).map(e => e.title);
  assert.deepEqual(titles, ['Nebo']);
});

test('professionalEntries carries only professional work, newest first', () => {
  const entries = professionalEntries({
    oldJob: { category: 'professional', title: 'Old Job' },
    toy: { category: 'passion', title: 'Toy' },
    newJob: { category: 'professional', title: 'New Job' },
  });
  assert.deepEqual(entries.map(e => e.title), ['New Job', 'Old Job']);
});

test('archiveCount counts every registry entry for the full-edition line', () => {
  assert.equal(archiveCount({ a: {}, b: {}, c: {} }), 3);
  assert.ok(archiveCount(projects) >= 19);
});
