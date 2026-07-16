/* DOM-free decision logic for <projects-index>, the homepage projects
   section. Tested by tests/projects-index-logic.test.mjs.

   The homepage no longer prints every project: it carries the compact
   Professional & Freelance band, then a hand-ranked selection of passion
   projects as big index rows, and hands everything else to the full
   edition at views/projects. */

/* Hand-ranked homepage selection, best first. Registry keys from
   components/project-data.js; the test suite runs this list against the
   live registry so a renamed or deleted entry fails the build. */
export const FEATURED = [
  'nebo',
  'tarok',
  'workout',
  'recipes',
  'maze',
  'botaniq',
  'guitarBackingTracks',
];

/* The featured registry entries in FEATURED order, each carrying its
   registry key. Unknown keys are skipped (the tests catch the drift). */
export function featuredEntries(registry) {
  return FEATURED
    .filter(key => registry[key])
    .map(key => ({ key, ...registry[key] }));
}

/* The compact top band: professional work only, newest entry first
   (registry insertion order is oldest first, same rule as the old paper). */
export function professionalEntries(registry) {
  return Object.values(registry)
    .filter(data => data.category === 'professional')
    .reverse();
}

/* Every registry entry counts toward the "all N projects" edition line. */
export function archiveCount(registry) {
  return Object.keys(registry).length;
}
