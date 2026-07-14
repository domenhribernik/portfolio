/* Unit tests for tools/seo/markdown.js (the generator's bounded renderer).
   Run with: node --test tests/ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderMarkdown, renderInline } from '../tools/seo/markdown.js';
import { parseFrontmatter } from '../views/blog/blog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('paragraphs join wrapped lines and separate on blanks', () => {
    assert.equal(renderMarkdown('line one\nline two\n\nsecond para'),
        '<p>line one line two</p>\n<p>second para</p>');
});

test('headings h2 through h4', () => {
    assert.equal(renderMarkdown('## Two\n\n### Three\n\n#### Four'),
        '<h2>Two</h2>\n<h3>Three</h3>\n<h4>Four</h4>');
});

test('fenced code blocks escape their content and keep the language', () => {
    const md = '```json\n{ "a": "<b>" }\n```';
    assert.equal(renderMarkdown(md),
        '<pre><code class="language-json">{ &quot;a&quot;: &quot;&lt;b&gt;&quot; }</code></pre>');
});

test('unordered and ordered lists', () => {
    assert.equal(renderMarkdown('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
    assert.equal(renderMarkdown('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
});

test('blockquotes merge consecutive lines', () => {
    assert.equal(renderMarkdown('> quoted\n> more'), '<blockquote><p>quoted more</p></blockquote>');
});

test('inline code, emphasis, links and escaping', () => {
    assert.equal(renderInline('a `code` and **bold** and *ital*'),
        'a <code>code</code> and <strong>bold</strong> and <em>ital</em>');
    assert.equal(renderInline('[marked](https://marked.js.org/)'),
        '<a href="https://marked.js.org/">marked</a>');
    assert.equal(renderInline('5 < 6 & "x"'), '5 &lt; 6 &amp; &quot;x&quot;');
});

test('emphasis inside code spans stays literal', () => {
    assert.equal(renderInline('`*not em*`'), '<code>*not em*</code>');
});

test('bare numbers survive around code spans', () => {
    assert.equal(renderInline('has `x` and 0 stays 1 intact'),
        'has <code>x</code> and 0 stays 1 intact');
});

test('renders both real posts without losing structure', () => {
    for (const slug of ['building-this-blog', 'in-praise-of-small-software']) {
        const raw = readFileSync(join(ROOT, `views/blog/posts/${slug}.md`), 'utf8');
        const { body } = parseFrontmatter(raw);
        const html = renderMarkdown(body);
        assert.ok(html.includes('<p>'), `${slug}: has paragraphs`);
        assert.ok(html.includes('<h2>'), `${slug}: has headings`);
        assert.ok(!html.includes('```'), `${slug}: no leftover fences`);
        assert.ok(!/^#{1,4}\s/m.test(html), `${slug}: no leftover heading markers`);
        // every markdown fence pair became exactly one <pre>
        const fences = (body.match(/^```/gm) || []).length;
        const pres = (html.match(/<pre>/g) || []).length;
        assert.equal(pres, fences / 2, `${slug}: fences rendered`);
    }
});
