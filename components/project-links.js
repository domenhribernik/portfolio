/* DOM-free link resolution for project registry entries. Links in
   project-data.js are written relative to the site root (e.g. "views/music");
   a page rendering them from a subdirectory passes its site prefix (the same
   value main-navbar takes, e.g. "../../") so they still resolve correctly.
   Tested by tests/project-links.test.mjs. */

export function resolveLink(href, site = '') {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  return site + href;
}
