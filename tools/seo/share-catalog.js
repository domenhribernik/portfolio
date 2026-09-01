//? Builds views/share/catalog.json, the card copy the share subdomain reads.
//?
//? The share page is served from its own document root and cannot import
//? components/project-data.js, so the registry is baked into a small JSON file
//? at generate time instead. Pure data in, plain object out: no fs, no DOM.
//? Unit-tested by tests/share-catalog.test.mjs.
//?
//? Three sources, in priority order:
//?   1. the project registry, whose title and description are already written
//?      to be read by a person;
//?   2. SHARE_EXTRAS below for public pages the registry does not describe,
//?      which supplies only the icon and gradient and takes the words from the
//?      page's own hand-written <title> and meta description;
//?   3. the blog manifest, one card per post from its frontmatter.
//?
//? A page in the sitemap inventory that none of the three covers throws. That
//? is deliberate: a nameless QR card is worse than a failed build, and the
//? failure lands on whoever added the view rather than on a visitor.

import { clipDescription } from './logic.js';

//? A card is read on a phone, held up, at a glance. Longer than a meta
//? description (the SEO limit is Google's, not a reader's) but still short.
export const CARD_DESCRIPTION_MAX = 220;

//? Trim to a sentence rather than a word. A meta description cut mid-clause is
//? invisible in a search result; on a card it is the only prose on the page,
//? so it has to end somewhere a person would stop.
export function cardDescription(text, max = CARD_DESCRIPTION_MAX) {
    const full = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!full) return '';
    if (full.length <= max) return full;

    let end = 0;
    for (const match of full.matchAll(/[.!?](\s|$)/g)) {
        const stop = match.index + 1;
        if (stop > max) break;
        end = stop;
    }
    if (end) return full.slice(0, end).trim();

    //? One sentence longer than the whole budget: fall back to a word cut.
    return clipDescription(full, max) + '\u2026';
}

//? Icon and gradient for the public pages that are not registry entries. The
//? words come from each page's own head, so only the card art lives here.
//? tests/share-catalog.test.mjs asserts this covers exactly those pages, so a
//? stale key fails just as loudly as a missing one.
export const SHARE_EXTRAS = {
    '': {
        icon: 'fas fa-house',
        gradient: 'linear-gradient(45deg, #1c1a17 0%, #6b6256 100%)',
    },
    'views/about': {
        icon: 'fas fa-user',
        gradient: 'linear-gradient(45deg, #2f5b53 0%, #6b6256 100%)',
    },
    'views/projects': {
        icon: 'fas fa-newspaper',
        gradient: 'linear-gradient(45deg, #1f35e0 0%, #1c1a17 100%)',
    },
    'views/store': {
        icon: 'fas fa-seedling',
        gradient: 'linear-gradient(45deg, #2f5b53 0%, #f2b705 100%)',
    },
    'views/rocks': {
        icon: 'fas fa-gem',
        gradient: 'linear-gradient(45deg, #4a4036 0%, #a49a8a 100%)',
    },
    'views/dnd': {
        icon: 'fas fa-dice-d20',
        gradient: 'linear-gradient(45deg, #4c1d95 0%, #d4451f 100%)',
    },
    'views/jeger': {
        icon: 'fas fa-wine-bottle',
        gradient: 'linear-gradient(45deg, #0f0d0a 0%, #f2b705 100%)',
    },
    'views/on-this-day': {
        icon: 'fas fa-calendar-day',
        gradient: 'linear-gradient(45deg, #1c1a17 0%, #2f5b53 100%)',
    },
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
    return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X'
                ? parseInt(body.slice(2), 16)
                : parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        const named = ENTITIES[body.toLowerCase()];
        return named === undefined ? whole : named;
    });
}

//? A page title reads "{Name} | {plain descriptor}" (or with a middle dot on
//? views/store). The card wants the name alone; the descriptor is the meta
//? description's job. Splits before decoding, so an encoded pipe inside a name
//? cannot masquerade as the separator.
export function pageTitleFrom(headTitle) {
    const raw = String(headTitle ?? '');
    const head = raw.split(/\s+[|·]\s+/)[0];
    const name = decodeEntities(head).trim();
    return name || decodeEntities(raw).trim();
}

//? Site-root-relative page path to its registry entry, using the same link
//? priority the sitemap uses so the two inventories can never disagree.
//? External links are skipped: they are not pages of this site.
export function registryByPage(projects) {
    const byPage = {};
    for (const entry of Object.values(projects)) {
        const href = entry.links?.visitSite || entry.links?.readMore || entry.links?.code || '';
        if (!/^views\//.test(href)) continue;
        const page = href.replace(/\/+$/, '');
        if (!(page in byPage)) byPage[page] = entry;
    }
    return byPage;
}

export function buildShareCatalog({ projects, pages, headMeta = {}, posts = [], origin }) {
    const byPage = registryByPage(projects);
    const cards = {};

    for (const page of pages) {
        const entry = byPage[page];
        if (entry) {
            cards[page] = {
                title: entry.title,
                description: cardDescription(entry.description),
                icon: entry.iconClass,
                gradient: entry.gradient,
            };
            continue;
        }

        const art = SHARE_EXTRAS[page];
        if (!art) {
            throw new Error(
                `share catalog: nothing describes "${page}". Either register it in ` +
                'components/project-data.js or add an icon and gradient for it to ' +
                'SHARE_EXTRAS in tools/seo/share-catalog.js.',
            );
        }

        const head = headMeta[page];
        if (!head?.title || !head?.description) {
            throw new Error(
                `share catalog: could not read a title and description from the head of ` +
                `"${page}/index.html", which is where its card copy comes from.`,
            );
        }

        cards[page] = {
            title: pageTitleFrom(head.title),
            description: cardDescription(decodeEntities(head.description)),
            icon: art.icon,
            gradient: art.gradient,
        };
    }

    //? Posts borrow the blog's card art so a new post needs no configuration.
    const blog = cards['views/blog'];
    for (const post of posts) {
        cards[`views/blog/${post.slug}`] = {
            title: pageTitleFrom(post.meta?.title || post.slug),
            description: cardDescription(post.meta?.excerpt || ''),
            icon: blog?.icon || 'fas fa-pen-nib',
            gradient: blog?.gradient || 'linear-gradient(45deg, #1f35e0 0%, #1c1a17 100%)',
        };
    }

    return { origin, pages: cards };
}
