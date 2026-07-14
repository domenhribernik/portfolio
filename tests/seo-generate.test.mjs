/* Unit tests for tools/seo/logic.js (the SEO generator's pure logic).
   Run with: node --test tests/ */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    escapeHtml,
    clipDescription,
    buildInventory,
    registryInternalPages,
    sitemapXml,
    replaceBetweenMarkers,
    projectsFallbackHtml,
    postsFallbackHtml,
    blogPostPage,
    validateSlug,
} from '../tools/seo/logic.js';

test('escapeHtml covers the five entities', () => {
    assert.equal(escapeHtml(`<a href="x">Q&A 'y'</a>`),
        '&lt;a href=&quot;x&quot;&gt;Q&amp;A &#39;y&#39;&lt;/a&gt;');
});

test('clipDescription keeps short text and clips long text at a word', () => {
    assert.equal(clipDescription('Short and sweet.'), 'Short and sweet.');
    const long = 'word '.repeat(60);
    const clipped = clipDescription(long, 160);
    assert.ok(clipped.length <= 160);
    assert.ok(!clipped.endsWith(' '));
    assert.ok(!/[.,;:!?]$/.test(clipped));
});

test('registryInternalPages picks internal links by priority and skips externals', () => {
    const pages = registryInternalPages({
        a: { links: { visitSite: 'views/one' } },
        b: { links: { visitSite: 'https://elsewhere.com' } },
        c: { links: { readMore: 'views/two/', code: 'https://github.com/x' } },
        d: { links: { code: 'https://github.com/y' } },
    });
    assert.deepEqual(pages, ['views/one', 'views/two']);
});

test('buildInventory starts at the homepage, dedupes, and drops exclusions', () => {
    const pages = buildInventory({
        registryPages: ['views/a', 'views/b', 'views/a'],
        extras: ['views/b', 'views/c', 'views/gone', 'views/hidden'],
        notDeployed: ['views/gone'],
        noindexed: ['views/hidden'],
    });
    assert.deepEqual(pages, ['', 'views/a', 'views/b', 'views/c']);
});

test('sitemapXml emits well-formed urlset with escaped locs', () => {
    const xml = sitemapXml([
        { loc: 'https://example.com/', lastmod: '2026-01-02', priority: '1.0' },
        { loc: 'https://example.com/a&b/', priority: '0.4' },
    ]);
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
    assert.equal((xml.match(/<url>/g) || []).length, 2);
    assert.equal((xml.match(/<\/url>/g) || []).length, 2);
    assert.ok(xml.includes('<loc>https://example.com/a&amp;b/</loc>'));
    assert.ok(xml.includes('<lastmod>2026-01-02</lastmod>'));
    assert.ok(!/&(?!amp;|lt;|gt;|quot;|#39;)/.test(xml), 'no raw ampersands');
    assert.ok(xml.endsWith('</urlset>\n'));
});

test('replaceBetweenMarkers is idempotent and preserves surroundings', () => {
    const doc = 'before\n<!-- s -->\nold stuff\n<!-- e -->\nafter';
    const once = replaceBetweenMarkers(doc, '<!-- s -->', '<!-- e -->', 'NEW');
    const twice = replaceBetweenMarkers(once, '<!-- s -->', '<!-- e -->', 'NEW');
    assert.equal(once, 'before\n<!-- s -->\nNEW\n<!-- e -->\nafter');
    assert.equal(once, twice);
});

test('replaceBetweenMarkers throws on missing or reversed markers', () => {
    assert.throws(() => replaceBetweenMarkers('no markers', '<!-- s -->', '<!-- e -->', 'x'),
        /Marker not found/);
    assert.throws(() => replaceBetweenMarkers('<!-- e -->\n<!-- s -->', '<!-- s -->', '<!-- e -->', 'x'),
        /out of order/);
});

const sampleProjects = {
    pro: {
        category: 'professional',
        title: 'Client & Co',
        description: 'Quotes "here" stay safe.',
        links: { visitSite: 'https://client.example' },
    },
    flag: {
        category: 'passion',
        title: 'Flagship App',
        description: 'The important one.',
        links: { visitSite: 'views/flag' },
    },
    minor: {
        category: 'passion',
        title: 'Minor App',
        description: 'The other one.',
        links: { visitSite: 'views/minor' },
    },
    academic: {
        category: 'academic',
        title: 'Thesis',
        description: 'Not on the front page.',
        links: { readMore: 'views/thesis' },
    },
};

test('projectsFallbackHtml escapes registry text and orders flagship first', () => {
    // registry order puts minor's source before flag when keys are swapped
    const swapped = { pro: sampleProjects.pro, minor: sampleProjects.minor, flag: sampleProjects.flag };
    const html = projectsFallbackHtml(swapped, ['views/flag']);
    assert.ok(html.includes('Client &amp; Co'));
    assert.ok(html.includes('Quotes &quot;here&quot; stay safe.'));
    assert.ok(html.indexOf('views/flag') < html.indexOf('views/minor'), 'flagship listed first');
    assert.ok(!html.includes('Thesis'), 'academic entries stay off the front page');
    assert.ok(html.includes('<a href="https://client.example">'));
});

test('postsFallbackHtml renders cards matching the hydrated markup', () => {
    const html = postsFallbackHtml([{
        slug: 'my-post',
        meta: { title: 'A <Title>', date: '2026-05-28', tag: 'Essays' },
        minutes: 3,
        snippet: 'Some & snippet',
        dateLabel: 'May 28, 2026',
    }]);
    assert.ok(html.includes('href="my-post/"'));
    assert.ok(html.includes('post-card__title">A &lt;Title&gt;</h2>'));
    assert.ok(html.includes('Some &amp; snippet'));
    assert.ok(html.includes('<time datetime="2026-05-28">May 28, 2026</time>'));
    assert.ok(html.includes('3 min read'));
});

test('blogPostPage emits a full document with canonical, OG and BlogPosting', () => {
    const page = blogPostPage({
        slug: 'my-post',
        meta: {
            title: 'My Post', date: '2026-05-28', author: 'Domen Hribernik',
            tag: 'Essays', excerpt: 'What it says.',
        },
        bodyHtml: '<p>Hello.</p>',
        minutes: 2,
        dateLabel: 'May 28, 2026',
        dateModified: '2026-06-08',
        origin: 'https://example.com',
    });
    assert.ok(page.startsWith('<!DOCTYPE html>'));
    assert.ok(page.includes('GENERATED by tools/seo/generate.js'));
    assert.ok(page.includes('<title>My Post | Domen Hribernik</title>'));
    assert.ok(page.includes('<link rel="canonical" href="https://example.com/views/blog/my-post/">'));
    assert.ok(page.includes('"@type": "BlogPosting"'));
    assert.ok(page.includes('"dateModified": "2026-06-08"'));
    assert.ok(page.includes('"@type": "BreadcrumbList"'));
    assert.ok(page.includes('property="og:type" content="article"'));
    assert.ok(page.includes('article:published_time'));
    assert.ok(page.includes('<p>Hello.</p>'));
    assert.ok(page.includes('post-shell is-ready'));
    assert.ok(page.includes('main-navbar site="../../../"'));
});

test('validateSlug accepts url-safe slugs and rejects collisions', () => {
    assert.equal(validateSlug('building-this-blog'), 'building-this-blog');
    assert.throws(() => validateSlug('Bad Slug'), /Invalid slug/);
    assert.throws(() => validateSlug('../escape'), /Invalid slug/);
    assert.throws(() => validateSlug('posts'), /collides/);
    assert.throws(() => validateSlug('post.html'), /Invalid slug|collides/);
});
