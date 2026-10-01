// Battleship's themes (views/battleship/theme.js and the token blocks at the
// top of views/battleship/style.css). A theme lives in three places, its key,
// its CSS block and its ui.json row, and a theme that is missing one of them
// does not fail loudly: a missing token silently falls back to the olive
// room, and a missing name renders as its raw key. This suite is the loud.
// Run: node --test tests/     (Windows: node --test "tests/**/*.test.mjs")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THEMES, DEFAULT_THEME, THEME_KEY, resolveTheme } from '../views/battleship/theme.js';

const url = (p) => new URL(p, import.meta.url);
const css = readFileSync(url('../views/battleship/style.css'), 'utf8');
const html = readFileSync(url('../views/battleship/index.html'), 'utf8');
const ui = JSON.parse(readFileSync(url('../views/battleship/i18n/ui.json'), 'utf8'));

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `[data-theme="key"] { ... }` block in the stylesheet, by key. */
function themeBlocks() {
    const blocks = new Map();
    for (const m of stripComments(css).matchAll(/([^{}]*\[data-theme="([\w-]+)"\][^{}]*)\{([^{}]*)\}/g)) {
        assert.ok(!blocks.has(m[2]), `${m[2]} is declared in two blocks`);
        blocks.set(m[2], { selector: m[1].trim(), body: m[3] });
    }
    return blocks;
}

const tokens = (body) => new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

test('the default theme is the first, and it is what :root wears', () => {
    // A page with no saved theme, or storage switched off, gets :root alone.
    assert.equal(DEFAULT_THEME, THEMES[0]);
    const block = themeBlocks().get(DEFAULT_THEME);
    assert.ok(block, `no block for ${DEFAULT_THEME}`);
    assert.match(block.selector, /^:root\s*,/, 'the default block does not also select :root');
});

test('every theme declares every token the default declares, and no strays', () => {
    const blocks = themeBlocks();
    const wanted = tokens(blocks.get(DEFAULT_THEME).body);
    assert.ok(wanted.size > 30, 'the default block looks truncated');
    for (const key of THEMES) {
        assert.ok(blocks.has(key), `${key} is in THEMES but has no [data-theme="${key}"] block`);
        const have = tokens(blocks.get(key).body);
        const missing = [...wanted].filter((t) => !have.has(t));
        const stray = [...have].filter((t) => !wanted.has(t));
        assert.deepEqual(missing, [], `${key} falls back to the default for ${missing.join(', ')}`);
        assert.deepEqual(stray, [], `${key} declares tokens the default does not: ${stray.join(', ')}`);
    }
    for (const key of blocks.keys()) {
        assert.ok(THEMES.includes(key), `[data-theme="${key}"] has a block but is not in THEMES`);
    }
});

test('no colour is written anywhere but a theme block', () => {
    // A literal outside the blocks paints the same in every theme, which is
    // exactly the bug a themed page cannot show you until someone plays it.
    let rest = stripComments(css);
    for (const m of rest.matchAll(/[^{}]*\[data-theme="[\w-]+"\][^{}]*\{[^{}]*\}/g)) rest = rest.replace(m[0], '');
    const found = [...rest.matchAll(/:[^;{}]*?(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\))/g)]
        .map((m) => m[1]);
    assert.deepEqual(found, [], `colour literals outside the theme blocks: ${found.join(', ')}`);
});

test('every theme has a name in every language', () => {
    for (const key of ['theme.label', ...THEMES.map((k) => `theme.${k}`)]) {
        assert.ok(ui[key], `${key} is missing from ui.json`);
        assert.ok(ui[key].en?.trim() && ui[key].sl?.trim(), `${key} is not filled in for both languages`);
    }
});

test('a stored theme is worn only if it still exists', () => {
    assert.equal(resolveTheme(null), DEFAULT_THEME);
    assert.equal(resolveTheme(''), DEFAULT_THEME);
    assert.equal(resolveTheme('neon'), DEFAULT_THEME, 'a retired theme must fall back, not stay stuck');
    assert.equal(resolveTheme('__proto__'), DEFAULT_THEME);
    for (const key of THEMES) assert.equal(resolveTheme(key), key);
});

test('the pre-paint script reads the same key the page saves under', () => {
    // Drift here means the theme still saves, but every load flashes the
    // default first and the script that was meant to stop that does nothing.
    assert.ok(html.includes(`localStorage.getItem('${THEME_KEY}')`),
        `index.html does not read ${THEME_KEY} before the first paint`);
    const head = html.slice(0, html.indexOf('</head>'));
    assert.ok(head.indexOf(THEME_KEY) < head.indexOf('href="style.css"'),
        'the theme is applied after the stylesheet link, so the default can flash');
});
