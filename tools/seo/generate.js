#!/usr/bin/env node
//? SEO artifact generator. Zero dependencies, plain node (18+). Run from
//? anywhere: `node tools/seo/generate.js`. Also wired into the deploy
//? workflow so production output can never go stale.
//?
//? It owns exactly the content that changes when content changes:
//?   - sitemap.xml (root): inventory from project-data.js + config, lastmod
//?     from git history (fs mtime fallback), priorities from config.
//?   - index.html: the static projects fallback between the
//?     <!-- seo:projects:start/end --> markers inside <projects-index>.
//?   - views/projects/index.html: the static full-edition fallback between
//?     the <!-- seo:archive:start/end --> markers inside #edition.
//?   - views/blog/index.html: the static post list between the
//?     <!-- seo:posts:start/end --> markers inside #post-grid.
//?   - views/blog/<slug>/index.html: one prerendered page per post in
//?     views/blog/posts/manifest.json, from the markdown + frontmatter.
//?
//? Hand-edited heads (titles, descriptions, canonicals) are deliberately NOT
//? generated; the views/seo checklist is the guard for those. The generator
//? only warns (stderr, non-fatal) when a flagship view is missing a canonical.
//?
//? New-post workflow: write views/blog/posts/<slug>.md, add the slug to
//? posts/manifest.json, run this script, commit everything including the
//? generated views/blog/<slug>/ directory. Removing a post: delete the md,
//? the manifest entry and the generated directory; the server keeps its stale
//? copy until removed manually over SFTP (deploy never deletes).
//?
//? `--check` generates to memory and exits 1 listing stale files, writing
//? nothing.

import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SITE_ORIGIN, FLAGSHIP, EXTRA_PUBLIC_PAGES, NOT_DEPLOYED, PRIORITY } from './config.js';
import {
    buildInventory, registryInternalPages, sitemapXml, replaceBetweenMarkers,
    projectsFallbackHtml, archiveFallbackHtml, postsFallbackHtml, blogPostPage,
    validateSlug,
} from './logic.js';
import { renderMarkdown } from './markdown.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK = process.argv.includes('--check');

const { projects } = await import(pathToFileURL(join(ROOT, 'components/project-data.js')));
const { FEATURED } = await import(pathToFileURL(join(ROOT, 'components/projects-index/logic.js')));
const { parseFrontmatter, formatDate, readingTime, plainExcerpt } =
    await import(pathToFileURL(join(ROOT, 'views/blog/blog.js')));

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

//? Last content change of a repo path as YYYY-MM-DD, from git history so
//? regeneration is idempotent; falls back to fs mtime outside a git checkout.
function lastmod(rel) {
    try {
        const out = execSync(`git log -1 --format=%cI -- "${rel}"`, {
            cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (out) return out.slice(0, 10);
    } catch { /* not a git checkout */ }
    try {
        return statSync(join(ROOT, rel)).mtime.toISOString().slice(0, 10);
    } catch {
        return null;
    }
}

function isNoindexed(page) {
    try {
        return /name="robots"[^>]*noindex/.test(read(`${page}/index.html`));
    } catch {
        return true; // unreadable page: leave it out of the sitemap
    }
}

//? ---------------------------------------------------------------- inventory

const registryPages = registryInternalPages(projects);
const candidates = [...new Set([...registryPages, ...EXTRA_PUBLIC_PAGES])];
const noindexed = candidates.filter(isNoindexed);
const pages = buildInventory({
    registryPages,
    extras: EXTRA_PUBLIC_PAGES,
    notDeployed: NOT_DEPLOYED,
    noindexed,
});

for (const page of FLAGSHIP) {
    try {
        if (!read(`${page}/index.html`).includes('rel="canonical"')) {
            console.error(`warning: flagship ${page}/index.html has no canonical tag`);
        }
    } catch { /* checked elsewhere */ }
}

//? ---------------------------------------------------------------- blog posts

const manifest = JSON.parse(read('views/blog/posts/manifest.json'));
const posts = manifest.map((slug) => {
    validateSlug(slug);
    const raw = read(`views/blog/posts/${slug}.md`);
    const { meta, body } = parseFrontmatter(raw);
    return {
        slug,
        meta,
        body,
        minutes: readingTime(body),
        snippet: plainExcerpt(body, 120),
        dateLabel: formatDate(meta.date),
        dateModified: lastmod(`views/blog/posts/${slug}.md`),
    };
});
posts.sort((a, b) => (b.meta.date || '').localeCompare(a.meta.date || ''));

//? ---------------------------------------------------------------- outputs

const outputs = new Map(); // repo-relative path -> content

const flagshipSet = new Set(FLAGSHIP);
const entries = pages.map((page) => {
    if (page === '') {
        const dates = [lastmod('index.html'), lastmod('views/homepage')].filter(Boolean).sort();
        return { loc: `${SITE_ORIGIN}/`, lastmod: dates.at(-1), priority: PRIORITY.home };
    }
    const priority = flagshipSet.has(page) ? PRIORITY.flagship
        : page === 'views/about' ? PRIORITY.about
        : page === 'views/projects' ? PRIORITY.archive
        : PRIORITY.default;
    return { loc: `${SITE_ORIGIN}/${page}/`, lastmod: lastmod(page), priority };
});
for (const post of posts) {
    entries.push({
        loc: `${SITE_ORIGIN}/views/blog/${post.slug}/`,
        lastmod: post.dateModified || post.meta.date,
        priority: PRIORITY.post,
    });
}
outputs.set('sitemap.xml', sitemapXml(entries));

outputs.set('index.html', replaceBetweenMarkers(
    read('index.html'),
    '<!-- seo:projects:start (generated by tools/seo/generate.js, do not hand-edit) -->',
    '<!-- seo:projects:end -->',
    projectsFallbackHtml(projects, FEATURED),
));

outputs.set('views/projects/index.html', replaceBetweenMarkers(
    read('views/projects/index.html'),
    '<!-- seo:archive:start (generated by tools/seo/generate.js, do not hand-edit) -->',
    '<!-- seo:archive:end -->',
    archiveFallbackHtml(projects),
));

outputs.set('views/blog/index.html', replaceBetweenMarkers(
    read('views/blog/index.html'),
    '<!-- seo:posts:start (generated by tools/seo/generate.js, do not hand-edit) -->',
    '<!-- seo:posts:end -->',
    postsFallbackHtml(posts),
));

for (const post of posts) {
    const rel = `views/blog/${post.slug}/index.html`;
    if (existsSync(join(ROOT, rel)) && !read(rel).includes('GENERATED by tools/seo/generate.js')) {
        throw new Error(`${rel} exists but is not a generated file; refusing to overwrite`);
    }
    outputs.set(rel, blogPostPage({
        slug: post.slug,
        meta: post.meta,
        bodyHtml: renderMarkdown(post.body),
        minutes: post.minutes,
        dateLabel: post.dateLabel,
        dateModified: post.dateModified,
        origin: SITE_ORIGIN,
    }));
}

//? ---------------------------------------------------------------- write/check

if (CHECK) {
    const stale = [];
    for (const [rel, content] of outputs) {
        let current = null;
        try { current = read(rel); } catch { /* missing */ }
        if (current !== content) stale.push(rel);
    }
    if (stale.length) {
        console.error('stale SEO artifacts (run: node tools/seo/generate.js):');
        for (const rel of stale) console.error(`  ${rel}`);
        process.exit(1);
    }
    console.log(`seo: ${outputs.size} artifacts up to date`);
} else {
    let written = 0;
    for (const [rel, content] of outputs) {
        let current = null;
        try { current = read(rel); } catch { /* missing */ }
        if (current === content) continue;
        mkdirSync(dirname(join(ROOT, rel)), { recursive: true });
        writeFileSync(join(ROOT, rel), content);
        console.log(`wrote ${rel}`);
        written++;
    }
    console.log(written ? `seo: ${written} of ${outputs.size} artifacts updated`
        : `seo: all ${outputs.size} artifacts already current`);
}
