import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLink } from '../components/project-links.js';

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
