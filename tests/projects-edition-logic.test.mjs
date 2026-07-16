import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEdition, editionMeta, SECTIONS } from '../views/projects/logic.js';
import { projects } from '../components/project-data.js';

/* Minimal registry in insertion order, mirroring project-data.js shape. */
const registry = {
  oldJob: { category: 'professional', title: 'Old Job' },
  paper: { category: 'academic', title: 'Paper' },
  toy: { category: 'passion', title: 'Toy' },
  newJob: { category: 'professional', title: 'New Job' },
  fresh: { category: 'passion', title: 'Fresh' },
};

test('buildEdition carries all three sections in A/B/C order, newest first inside', () => {
  const { sections } = buildEdition(registry);
  assert.deepEqual(sections.map(s => s.letter), ['A', 'B', 'C']);
  assert.deepEqual(sections.map(s => s.label), [
    'Professional & Freelance',
    'Passion Projects',
    'Academic & Research',
  ]);
  assert.deepEqual(sections[0].entries.map(e => e.title), ['New Job', 'Old Job']);
  assert.deepEqual(sections[1].entries.map(e => e.title), ['Fresh', 'Toy']);
});

test('buildEdition numbers every story from 1 within its section', () => {
  const { sections } = buildEdition(registry);
  assert.deepEqual(sections[0].entries.map(e => e.folio), ['A1', 'A2']);
  assert.deepEqual(sections[1].entries.map(e => e.folio), ['B1', 'B2']);
  assert.deepEqual(sections[2].entries.map(e => e.folio), ['C1']);
});

test('buildEdition omits sections with no entries', () => {
  const { sections } = buildEdition({ solo: { category: 'passion', title: 'Solo' } });
  assert.deepEqual(sections.map(s => s.letter), ['B']);
});

test('the academic section hoists its designated lead to the front', () => {
  const { sections } = buildEdition({
    thesis: { category: 'academic', title: 'Virtual Runner' },
    ocr: { category: 'academic', title: 'OCR' },
    fruit: { category: 'academic', title: 'Fruit' },
  });
  assert.deepEqual(sections[0].entries.map(e => e.title), ['Virtual Runner', 'Fruit', 'OCR']);
  assert.deepEqual(sections[0].entries.map(e => e.folio), ['C1', 'C2', 'C3']);
});

test('the configured lead keys exist in the live registry', () => {
  for (const { leadKey, category } of SECTIONS) {
    if (!leadKey) continue;
    assert.ok(projects[leadKey], `lead key "${leadKey}" missing from project-data.js`);
    assert.equal(projects[leadKey].category, category);
  }
});

test('editionMeta numbers the edition from the date and counts every story', () => {
  const meta = editionMeta(registry, new Date(2026, 6, 16));
  assert.equal(meta.volume, 'Vol. VI');       // 2026 is the site's 6th year
  assert.equal(meta.number, 'No. 197');       // 197th day of 2026
  assert.equal(meta.count, 5);
  assert.equal(meta.dateline, 'Thursday, July 16, 2026');
});

test('editionMeta survives the volume rolling past year ten', () => {
  assert.equal(editionMeta({}, new Date(2035, 0, 1)).volume, 'Vol. XV');
  assert.equal(editionMeta({}, new Date(2035, 0, 1)).number, 'No. 1');
});
