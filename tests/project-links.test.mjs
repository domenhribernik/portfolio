import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveLink,
  primaryLink,
  secondaryLinks,
  opensNewTab,
} from '../components/project-links.js';

/* Registry links in project-data.js are written relative to the site root
   (e.g. "views/music"). A page that renders them from a subdirectory passes
   its site prefix (the same value main-navbar takes) so they still land on
   the right page. */

test('a site-root-relative link gets the page site prefix', () => {
  assert.equal(resolveLink('views/music', '../../'), '../../views/music');
});

test('a page at the site root (no site attribute) gets the link unchanged', () => {
  assert.equal(resolveLink('views/music', ''), 'views/music');
  assert.equal(resolveLink('views/music'), 'views/music');
});

test('an external URL is left untouched regardless of the prefix', () => {
  assert.equal(
    resolveLink('https://vitamavric.com', '../../'),
    'https://vitamavric.com'
  );
});

/* A registry entry's best single destination, and everything beyond it.
   Shared by the homepage projects section and the views/projects edition. */

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
