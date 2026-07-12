/* DOM-free decision logic for <projects-paper>, the homepage newspaper
   projects section. Tested by tests/projects-paper-logic.test.mjs. */

/* The front page carries professional work (top-stories band) and passion
   projects (briefs index), in that order. Academic work is deliberately
   absent here; it lives on the about page, reached via the paper's
   cross-reference line. */
export const SECTIONS = [
  { category: 'professional', label: 'Professional & Freelance' },
  { category: 'passion', label: 'Passion Projects' },
];

/* On phones each section prints at most this many stories before folding
   the rest behind its "More stories" toggle; wider viewports show all. */
export const MOBILE_VISIBLE = 5;

/* The whole story block links to its best destination, in this order. */
export const PRIMARY_ORDER = ['visitSite', 'readMore', 'code', 'demo'];

export function primaryLink(links) {
  const all = links || {};
  const kind = PRIMARY_ORDER.find(k => all[k] && all[k].trim()) || null;
  return { kind, href: kind ? all[kind] : '#' };
}

const LINK_LABELS = {
  visitSite: 'Website',
  readMore: 'Read more',
  code: 'Code',
  demo: 'Demo',
};

/* Every non-blank link beyond the primary, as small cross-reference links. */
export function secondaryLinks(links) {
  const all = links || {};
  const { kind: primary } = primaryLink(all);
  return PRIMARY_ORDER
    .filter(k => k !== primary && all[k] && all[k].trim())
    .map(k => ({ kind: k, href: all[k], label: LINK_LABELS[k] }));
}

/* Everything opens a new tab except a same-site readMore (the registry's
   noTarget flag) and the '#' fallback when an entry has no links. */
export function opensNewTab(kind, data) {
  if (!kind) return false;
  return !(kind === 'readMore' && data.noTarget);
}

/* A column prints its first story big (the lead), the next few as briefs,
   and folds the rest behind the column's "more stories" toggle. `visible`
   is the total story count shown before unfolding. */
export function splitStories(entries, visible) {
  return {
    lead: entries[0],
    briefs: entries.slice(1, visible),
    hidden: entries.slice(visible),
  };
}

/* Group the project registry into ordered sections, newest entry first
   (registry insertion order is oldest first, same rule as the old index). */
export function buildSections(registry) {
  return SECTIONS
    .map(({ category, label }) => ({
      category,
      label,
      entries: Object.values(registry)
        .filter(data => data.category === category)
        .reverse(),
    }))
    .filter(section => section.entries.length > 0);
}
