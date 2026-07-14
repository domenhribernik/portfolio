//? Central configuration for the SEO generator (tools/seo/generate.js).
//? Everything URL-shaped is site-root-relative without a trailing slash
//? (e.g. 'views/nebo'), matching the internal links in project-data.js.

export const SITE_ORIGIN = 'https://domenhribernik.com';

//? Flagship subset: these get sitemap priority 0.8 and are listed first in
//? the homepage's static projects fallback. Edit this list to promote or
//? demote a project; everything else public stays crawlable at priority 0.4.
export const FLAGSHIP = [
    'views/nebo',
    'views/flowers',
    'views/tarok',
    'views/music',
    'views/botaniq',
    'views/workout',
    'views/blog',
];

//? Public pages that are not registered in components/project-data.js (or
//? whose registry entry has no internal link) but should still be crawled.
export const EXTRA_PUBLIC_PAGES = [
    'views/about',
    'views/flowers',
    'views/bloom',
    'views/rocks',
    'views/dnd',
    'views/jeger',
    'views/on-this-day',
];

//? Views excluded from the production upload in .github/workflows/deploy.yml.
//? They must never appear in the sitemap; keep this list in sync with the
//? workflow's exclude block.
export const NOT_DEPLOYED = [
    'views/stocks',
    'views/slovenia',
    'views/quizz',
    'views/download',
];

//? Sitemap priorities per tier.
export const PRIORITY = {
    home: '1.0',
    flagship: '0.8',
    post: '0.8',
    about: '0.7',
    default: '0.4',
};
