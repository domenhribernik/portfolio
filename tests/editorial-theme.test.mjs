/* The editorial theme is declared twice on purpose: once as hex in
   components/editorial/theme.js (so Tailwind's slash-opacity utilities
   like text-stone/80 can compute an alpha, which they cannot do through
   a var()) and once as CSS custom properties in theme.css (for
   hand-written CSS). Two declarations can drift, so this suite welds
   them together and fails the moment they disagree.

   It also guards the migration itself: the palette used to be retyped in
   22 inline tailwind.config blocks, and nothing but a test stops a 23rd
   from appearing. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const THEME_JS = readFileSync(join(ROOT, 'components/editorial/theme.js'), 'utf8');
const THEME_CSS = readFileSync(join(ROOT, 'components/editorial/theme.css'), 'utf8');

/* The unhyphenated aliases are deliberate duplicates of an existing
   colour, not their own tokens, so they are exempt from the CSS mirror. */
const ALIASES = new Set(['paper2', 'claydk']);

function jsColors() {
  const block = THEME_JS.match(/var COLORS = \{([\s\S]*?)\n {2}\};/);
  assert.ok(block, 'theme.js must declare a `var COLORS = { ... };` block');
  const out = {};
  /* Matches hex AND functional colours. An earlier version of this
     regex only caught `#hex`, which hid `hairline: rgba(...)` from the
     migration and silently dropped it from nine pages. */
  for (const m of block[1].matchAll(/'?([a-z0-9-]+)'?\s*:\s*'(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))'/g)) {
    out[m[1]] = m[2].toLowerCase().replace(/\s+/g, ' ');
  }
  /* The alias spellings are assigned after the literal, by reference to
     a canonical key, so that they cannot be given a value of their own. */
  for (const m of THEME_JS.matchAll(/COLORS\.([a-z0-9]+)\s*=\s*COLORS\['([a-z0-9-]+)'\]/g)) {
    out[m[1]] = out[m[2]];
  }
  return out;
}

function cssTokens() {
  const root = THEME_CSS.match(/:root \{([\s\S]*?)\n\}/);
  assert.ok(root, 'theme.css must declare a `:root { ... }` block');
  const out = {};
  for (const m of root[1].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim().toLowerCase().replace(/\s+/g, ' ');
  }
  return out;
}

function walk(dir, hits = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'vendor' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, hits);
    else if (name.endsWith('.html')) hits.push(full);
  }
  return hits;
}

test('every theme.js colour is mirrored as a CSS custom property', () => {
  const js = jsColors();
  const css = cssTokens();
  assert.ok(Object.keys(js).length >= 12, 'expected the full palette in theme.js');

  for (const [name, hex] of Object.entries(js)) {
    if (ALIASES.has(name)) continue;
    assert.equal(
      css[name], hex,
      `--${name} in theme.css is "${css[name]}" but theme.js says "${hex}"`
    );
  }
});

test('the unhyphenated aliases still point at their canonical colour', () => {
  const js = jsColors();
  assert.equal(js.paper2, js['paper-2'], 'paper2 must alias paper-2');
  assert.equal(js.claydk, js['clay-dk'], 'claydk must alias clay-dk');
});

test('theme.css carries the shared motion curves', () => {
  const css = cssTokens();
  for (const key of ['ease-out', 'ease-emph', 'hard']) {
    assert.ok(css[key], `theme.css is missing --${key}`);
  }
});

test('theme.css declares no derived token nothing consumes', () => {
  /* A shared theme is the easiest place in the codebase to accumulate
     speculative tokens. Every property it declares beyond the palette
     must be read by something outside the file, or it is dead weight the
     next person still has to understand. (An earlier draft shipped a
     radius scale, a duration scale and a spring curve that nothing used.)

     Palette tokens are exempt: the mirror is deliberately complete, which
     the first test enforces, and several are consumed only through
     Tailwind utilities such as `text-faint` rather than through var(). */
  const palette = new Set(Object.keys(jsColors()));
  const declared = Object.keys(cssTokens()).filter(t => !palette.has(t));
  const sources = [];
  const collect = dir => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'vendor' || name.startsWith('.')) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) collect(full);
      else if (/\.(css|html|js)$/.test(name) && !full.endsWith('editorial/theme.css')) {
        sources.push(readFileSync(full, 'utf8'));
      }
    }
  };
  collect(ROOT);
  const haystack = sources.join('\n');

  const unused = declared.filter(t => !haystack.includes(`var(--${t}`));
  assert.deepEqual(
    unused, [],
    `theme.css declares tokens nothing reads: ${unused.map(t => '--' + t).join(', ')}`
  );
});

test('theme.js is loadable as a classic script, not an ES module', () => {
  /* A `type="module"` tag is deferred and would run after Tailwind's
     first pass, so the theme would silently not apply. Keeping the file
     free of import/export syntax is what makes the plain <script src>
     in every page head legal. */
  assert.doesNotMatch(THEME_JS, /^\s*(import|export)\s/m,
    'theme.js must not use ES module syntax');
});

test('no page re-declares the editorial palette inline', () => {
  /* The whole point of the migration. A page that hardcodes the paper
     hex next to a tailwind.config has forked the palette again. */
  const offenders = [];
  for (const file of walk(ROOT)) {
    const html = readFileSync(file, 'utf8');
    if (!/tailwind\.config/.test(html)) continue;
    if (/#f6f2ea/i.test(html)) offenders.push(relative(ROOT, file));
  }
  assert.deepEqual(
    offenders, [],
    `these pages still declare the palette inline instead of loading ` +
    `components/editorial/theme.js:\n  ${offenders.join('\n  ')}`
  );
});
