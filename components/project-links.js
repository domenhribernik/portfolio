/* DOM-free link resolution for project registry entries. Links in
   project-data.js are written relative to the site root (e.g. "views/music");
   a page rendering them from a subdirectory passes its site prefix (the same
   value main-navbar takes, e.g. "../../") so they still resolve correctly.
   Tested by tests/project-links.test.mjs. */

export function resolveLink(href, site = '') {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  return site + href;
}

/* A registry entry links to one best destination, in this order. */
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

/* Every non-blank link beyond the primary, as small labelled links. */
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
