// Unit tests for the share catalog builder (tools/seo/share-catalog.js).
// Run with: node --test tests/
//
// The catalog is what views/share reads instead of importing the registry: the
// share page is served from its own subdomain document root and cannot reach
// ../../components. So this is the seam where a page that exists on the site
// but has no share card must fail loudly, at build time, rather than shipping
// a nameless QR.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SHARE_EXTRAS,
    CARD_DESCRIPTION_MAX,
    cardDescription,
    pageTitleFrom,
    registryByPage,
    buildShareCatalog,
} from '../tools/seo/share-catalog.js';
import { projects } from '../components/project-data.js';
import { registryInternalPages, buildInventory } from '../tools/seo/logic.js';
import { EXTRA_PUBLIC_PAGES, NOT_DEPLOYED, SITE_ORIGIN } from '../tools/seo/config.js';

const GRADIENT = /^linear-gradient\(45deg, #[0-9a-f]{6} 0%, #[0-9a-f]{6} 100%\)$/i;

// The real inventory, exactly as generate.js assembles it.
const inventory = buildInventory({
    registryPages: registryInternalPages(projects),
    extras: EXTRA_PUBLIC_PAGES,
    notDeployed: NOT_DEPLOYED,
    noindexed: [],
});

// Stand-in head metadata for the pages the registry does not describe.
const headMeta = Object.fromEntries(
    Object.keys(SHARE_EXTRAS).map((page) => [page, {
        title: `Title For ${page || 'home'} | tail that gets dropped`,
        description: `A description for ${page || 'the homepage'}.`,
    }]),
);

const posts = [
    { slug: 'in-praise-of-small-software', meta: { title: 'In Praise of Small Software', excerpt: 'Most of the projects here solve a problem exactly one person had.' } },
    { slug: 'building-this-blog', meta: { title: 'Building a Blog With No Build Step', excerpt: 'The whole site is hand written static files, so the blog had to be too.' } },
];

const build = (over = {}) => buildShareCatalog({
    projects, pages: inventory, headMeta, posts, origin: SITE_ORIGIN, ...over,
});

//? ------------------------------------------------------------------ coverage

test('every page in the sitemap inventory gets a share card', () => {
    const catalog = build();
    for (const page of inventory) {
        assert.ok(catalog.pages[page], `no share card for "${page || '(homepage)'}"`);
    }
});

test('SHARE_EXTRAS describes exactly the pages the registry does not', () => {
    // A stale entry here is dead config; a missing one breaks the build. Both
    // are worth catching the moment a view is added or a link is repointed.
    const fromRegistry = new Set(Object.keys(registryByPage(projects)));
    const needed = inventory.filter((page) => !fromRegistry.has(page)).sort();
    assert.deepEqual(Object.keys(SHARE_EXTRAS).sort(), needed);
});

test('every card carries a title, description, icon and gradient', () => {
    const catalog = build();
    for (const [page, card] of Object.entries(catalog.pages)) {
        assert.ok(card.title && card.title.trim(), `title for ${page}`);
        assert.ok(card.description && card.description.trim(), `description for ${page}`);
        assert.match(card.icon, /^fas? fa-/, `icon for ${page}`);
        assert.match(card.gradient, GRADIENT, `gradient for ${page}`);
        assert.ok(card.description.length <= CARD_DESCRIPTION_MAX + 1,
            `description length for ${page}`);
    }
});

test('the catalog carries the origin the URLs are built from', () => {
    assert.equal(build().origin, SITE_ORIGIN);
});

//? ------------------------------------------------------------------- sources

test('a registered project uses its registry copy, not the page head', () => {
    const catalog = build();
    assert.equal(catalog.pages['views/tells'].title, projects.tells.title);
    assert.equal(catalog.pages['views/tells'].icon, projects.tells.iconClass);
    assert.equal(catalog.pages['views/tells'].gradient, projects.tells.gradient);
    assert.ok(catalog.pages['views/tells'].description.startsWith('A logical fallacy sits'));
});

test('an unregistered public page takes its title and description from its head', () => {
    const catalog = build();
    assert.equal(catalog.pages['views/rocks'].title, 'Title For views/rocks');
    assert.equal(catalog.pages['views/rocks'].description, 'A description for views/rocks.');
    assert.equal(catalog.pages['views/rocks'].icon, SHARE_EXTRAS['views/rocks'].icon);
});

test('the homepage is keyed by the empty string', () => {
    const catalog = build();
    assert.ok(catalog.pages[''], 'homepage card');
    assert.equal(catalog.pages[''].title, 'Title For home');
});

test('blog posts are listed under their own path, inheriting the blog card art', () => {
    const catalog = build();
    const card = catalog.pages['views/blog/in-praise-of-small-software'];
    assert.ok(card, 'post card');
    assert.equal(card.title, 'In Praise of Small Software');
    assert.ok(card.description.startsWith('Most of the projects here'));
    assert.equal(card.icon, catalog.pages['views/blog'].icon);
    assert.equal(card.gradient, catalog.pages['views/blog'].gradient);
});

test('a long registry description is clipped to card length', () => {
    const catalog = buildShareCatalog({
        projects: {
            long: {
                title: 'Long', gradient: 'linear-gradient(45deg, #1c1a17 0%, #d4451f 100%)',
                iconClass: 'fas fa-circle', links: { visitSite: 'views/long' },
                description: 'word '.repeat(80),
            },
        },
        pages: ['views/long'], headMeta: {}, posts: [], origin: SITE_ORIGIN,
    });
    assert.ok(catalog.pages['views/long'].description.length <= CARD_DESCRIPTION_MAX + 1);
});

//? ------------------------------------------------------------------- guards

test('a public page with no registry entry and no extras entry fails the build', () => {
    assert.throws(
        () => build({ pages: [...inventory, 'views/brand-new'] }),
        /views\/brand-new/,
    );
});

test('an extras page with no readable head fails the build', () => {
    assert.throws(
        () => build({ headMeta: {} }),
        /head/i,
    );
});

test('a registry entry whose link points off-site is not mistaken for a page', () => {
    const byPage = registryByPage({
        offsite: { links: { visitSite: 'https://vitamavric.com' }, title: 'Off Site' },
        onsite: { links: { visitSite: 'views/here' }, title: 'On Site' },
    });
    assert.deepEqual(Object.keys(byPage), ['views/here']);
});

test('registryByPage follows the same link priority as the sitemap', () => {
    const byPage = registryByPage({
        a: { links: { readMore: 'views/read', code: 'views/code' }, title: 'A' },
        b: { links: { visitSite: 'views/visit', readMore: 'views/read-b' }, title: 'B' },
    });
    assert.deepEqual(Object.keys(byPage).sort(), ['views/read', 'views/visit']);
});

//? -------------------------------------------------------------- title tidying

test('pageTitleFrom keeps the name and drops the descriptor tail', () => {
    assert.equal(pageTitleFrom('Our Rock Pile | A Little 3D Rock Collection'), 'Our Rock Pile');
    assert.equal(pageTitleFrom('Everbloom · Flowers that never wilt'), 'Everbloom');
    assert.equal(pageTitleFrom('Domen Hribernik | Full-Stack Developer in Slovenia'), 'Domen Hribernik');
    assert.equal(pageTitleFrom('On This Day | A Daily Almanac of History'), 'On This Day');
});

test('pageTitleFrom decodes the entities a hand-written head can carry', () => {
    assert.equal(pageTitleFrom('Session Zero | Find Your D&amp;D Class Quiz'), 'Session Zero');
    assert.equal(pageTitleFrom('Tom &amp; Jerry'), 'Tom & Jerry');
    assert.equal(pageTitleFrom('Caf&#233; &lt;b&gt;'), 'Café <b>');
});

test('pageTitleFrom leaves a title with no descriptor alone', () => {
    assert.equal(pageTitleFrom('Nebo'), 'Nebo');
    assert.equal(pageTitleFrom('  Spaced Out  '), 'Spaced Out');
});

test('pageTitleFrom never returns an empty string for a separator-only title', () => {
    assert.equal(pageTitleFrom('| tail only'), '| tail only');
    assert.equal(pageTitleFrom(''), '');
});

//? -------------------------------------------------------------- card copy

test('cardDescription keeps a description that already fits, untouched', () => {
    const short = 'Connect four, except the ground keeps disappearing.';
    assert.equal(cardDescription(short), short);
});

test('cardDescription stops at the last full sentence that fits', () => {
    const text = 'One sentence here. A second one follows it. '
        + 'A third that would push the whole thing past the limit if it were kept.';
    assert.equal(cardDescription(text, 60), 'One sentence here. A second one follows it.');
});

test('cardDescription falls back to a word cut when one sentence is too long', () => {
    const runOn = 'word '.repeat(80);
    const out = cardDescription(runOn, 100);
    assert.ok(out.length <= 101, `length was ${out.length}`);
    assert.ok(out.endsWith('\u2026'), 'a mid-sentence cut is marked');
    assert.ok(!out.includes('  '), 'whitespace is collapsed');
});

test('cardDescription handles nothing at all', () => {
    assert.equal(cardDescription(''), '');
    assert.equal(cardDescription(null), '');
    assert.equal(cardDescription(undefined), '');
});
