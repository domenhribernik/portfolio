//? Pure decision and templating logic for the SEO generator. No fs, no git,
//? no DOM: everything here takes plain data and returns strings, so it is
//? unit-testable by tests/seo-generate.test.mjs.

export function escapeHtml(s) {
    return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

//? XML attribute/text escaping is the same five entities.
export const escapeXml = escapeHtml;

//? Clip a plain-text excerpt to a word boundary near `max` characters,
//? for meta descriptions (Google truncates around 160).
export function clipDescription(text, max = 160) {
    const t = String(text).replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    const clipped = t.slice(0, max);
    const cut = clipped.lastIndexOf(' ');
    return (cut > 60 ? clipped.slice(0, cut) : clipped).replace(/[.,;:!?]$/, '');
}

//? ---------------------------------------------------------------- inventory

//? Build the ordered list of site-root-relative page paths for the sitemap.
//? `registryPages` are internal links pulled from project-data.js entries,
//? `extras` come from config, `notDeployed` and `noindexed` are excluded.
//? '' (the homepage) is always first; everything else is deduped and kept
//? in first-seen order: registry order, then extras.
export function buildInventory({ registryPages, extras, notDeployed, noindexed }) {
    const drop = new Set([...notDeployed, ...noindexed]);
    const seen = new Set();
    const pages = [''];
    for (const p of [...registryPages, ...extras]) {
        const path = String(p).replace(/\/+$/, '');
        if (!path || seen.has(path) || drop.has(path)) continue;
        seen.add(path);
        pages.push(path);
    }
    return pages;
}

//? Extract the site-internal page paths ('views/...') from the registry, in
//? registry order. External links (https://...) are skipped. Link priority
//? per entry matches projects-paper: visitSite, else readMore, else code.
export function registryInternalPages(projects) {
    const pages = [];
    for (const entry of Object.values(projects)) {
        const href = entry.links?.visitSite || entry.links?.readMore || entry.links?.code || '';
        if (/^views\//.test(href)) pages.push(href.replace(/\/+$/, ''));
    }
    return pages;
}

//? ---------------------------------------------------------------- sitemap

//? entries: [{ loc, lastmod?, priority }] with loc already absolute.
export function sitemapXml(entries) {
    const urls = entries.map(({ loc, lastmod, priority }) => {
        const parts = [`        <loc>${escapeXml(loc)}</loc>`];
        if (lastmod) parts.push(`        <lastmod>${escapeXml(lastmod)}</lastmod>`);
        if (priority) parts.push(`        <priority>${escapeXml(priority)}</priority>`);
        return `    <url>\n${parts.join('\n')}\n    </url>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        `${urls.join('\n')}\n` +
        `</urlset>\n`;
}

//? ---------------------------------------------------------------- markers

//? Replace the content between two marker comments, keeping the markers and
//? the surrounding bytes untouched. Idempotent: running the replacement
//? twice with the same content yields the same document. Throws when the
//? markers are missing or out of order so a stale template fails loudly.
export function replaceBetweenMarkers(source, startMarker, endMarker, content) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker);
    if (start === -1 || end === -1) {
        throw new Error(`Marker not found: ${start === -1 ? startMarker : endMarker}`);
    }
    if (end < start) throw new Error(`Markers out of order: ${endMarker} before ${startMarker}`);
    const before = source.slice(0, start + startMarker.length);
    const after = source.slice(end);
    return `${before}\n${content}\n${after}`;
}

//? ------------------------------------------------- homepage projects fallback

//? Static, crawlable stand-in for the <projects-paper> front page. Real light
//? DOM (not <noscript>): projects-paper.js overwrites this wholesale at
//? hydration, so it only ever renders for non-JS crawlers and readers.
//? Mirrors the paper's content: professional + passion, academic left to the
//? about page. Flagship passion projects list first.
export function projectsFallbackHtml(projects, flagship) {
    const flagshipSet = new Set(flagship);
    const byCategory = (cat) => Object.values(projects).filter(p => p.category === cat);

    const link = (entry) => {
        const href = entry.links?.visitSite || entry.links?.readMore || entry.links?.code || '';
        return href;
    };
    const item = (entry) => {
        const href = link(entry);
        const title = escapeHtml(entry.title);
        const desc = escapeHtml(entry.description);
        const a = href ? `<a href="${escapeHtml(href)}">${title}</a>` : title;
        return `            <li>${a}: ${desc}</li>`;
    };

    const passion = byCategory('passion').sort((a, b) => {
        const fa = flagshipSet.has(link(a).replace(/\/+$/, '')) ? 0 : 1;
        const fb = flagshipSet.has(link(b).replace(/\/+$/, '')) ? 0 : 1;
        return fa - fb;
    });

    return [
        '        <div class="ppaper-fallback">',
        '            <h3>Professional &amp; Freelance</h3>',
        '            <ul>',
        ...byCategory('professional').map(item),
        '            </ul>',
        '            <h3>Passion Projects</h3>',
        '            <ul>',
        ...passion.map(item),
        '            </ul>',
        '        </div>',
    ].join('\n');
}

//? --------------------------------------------------- blog index fallback

//? posts: [{ slug, meta: { title, date, tag }, minutes, snippet }] sorted
//? newest first by the caller. Markup mirrors the hydrated .post-card so the
//? no-JS view looks right; index.js clears and re-renders it on load.
export function postsFallbackHtml(posts) {
    const card = (p) => {
        const { title = p.slug, date = '', tag = '' } = p.meta;
        const lines = [
            `                <a class="post-card" href="${escapeHtml(p.slug)}/">`,
        ];
        if (tag) lines.push(`                    <span class="post-card__cat">${escapeHtml(tag)}</span>`);
        lines.push(`                    <h2 class="post-card__title">${escapeHtml(title)}</h2>`);
        lines.push(`                    <p class="post-card__snippet">${escapeHtml(p.snippet)}</p>`);
        lines.push('                    <div class="post-card__meta">');
        if (date) lines.push(`                        <time datetime="${escapeHtml(date)}">${escapeHtml(p.dateLabel || date)}</time>`);
        lines.push(`                        <span class="post-card__sep">&middot;</span>`);
        lines.push(`                        <span>${p.minutes} min read</span>`);
        lines.push('                    </div>');
        lines.push('                </a>');
        return lines.join('\n');
    };
    return posts.map(card).join('\n');
}

//? --------------------------------------------------- generated post pages

//? Full static HTML document for one blog post at views/blog/<slug>/.
//? Visual shell mirrors views/blog/post.html (same stylesheets and classes,
//? paths adjusted one level deeper); `is-ready` is baked in since there is
//? no loading state to wait for.
export function blogPostPage({ slug, meta, bodyHtml, minutes, dateLabel, dateModified, origin }) {
    const title = meta.title || slug;
    const desc = clipDescription(meta.excerpt || '');
    const url = `${origin}/views/blog/${slug}/`;
    const jsonLd = {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: title,
        datePublished: meta.date || undefined,
        dateModified: dateModified || meta.date || undefined,
        author: { '@type': 'Person', name: meta.author || 'Domen Hribernik', url: `${origin}/` },
        url,
        description: desc,
        isPartOf: { '@type': 'Blog', url: `${origin}/views/blog/` },
        inLanguage: 'en',
    };
    const breadcrumbs = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Blog', item: `${origin}/views/blog/` },
            { '@type': 'ListItem', position: 2, name: title, item: url },
        ],
    };

    const metaBits = [];
    if (meta.date) metaBits.push(`<time datetime="${escapeHtml(meta.date)}">${escapeHtml(dateLabel || meta.date)}</time>`);
    if (meta.author) metaBits.push(`<span>${escapeHtml(meta.author)}</span>`);
    metaBits.push(`<span>${minutes} min read</span>`);

    return `<!DOCTYPE html>
<!-- GENERATED by tools/seo/generate.js from views/blog/posts/${slug}.md.
     Do not hand-edit: change the markdown and re-run the generator. -->
<html lang="en">

<head>
    <script src="../../../components/google-analytics.js"></script>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="${escapeHtml(desc)}">
    <title>${escapeHtml(title)} | Domen Hribernik</title>
    <link rel="canonical" href="${escapeHtml(url)}">
    <meta property="og:site_name" content="Domen Hribernik">
    <meta property="og:type" content="article">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(desc)}">
    <meta property="og:url" content="${escapeHtml(url)}">
    <meta property="og:image" content="${escapeHtml(origin)}/assets/img/og-default.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
${meta.date ? `    <meta property="article:published_time" content="${escapeHtml(meta.date)}">\n` : ''}    <meta name="twitter:card" content="summary_large_image">
    <script type="application/ld+json">
${JSON.stringify(jsonLd, null, 4).replace(/^/gm, '    ')}
    </script>
    <script type="application/ld+json">
${JSON.stringify(breadcrumbs, null, 4).replace(/^/gm, '    ')}
    </script>
    <link rel="icon" type="image/x-icon" href="../../../assets/favicon.ico" />
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=IBM+Plex+Sans:wght@300;400;500;600;700&family=Space+Mono:ital,wght@0,400;0,700;1,400;1,700&display=swap"
        rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    colors: {
                        paper: '#f6f2ea', 'paper-2': '#efe9dd', card: '#fffdf8',
                        ink: '#1c1a17', stone: '#6b6256', clay: '#d4451f',
                        'clay-dk': '#b8371a', pine: '#2f5b53', cobalt: '#1f35e0', marigold: '#f2b705',
                    },
                    fontFamily: {
                        display: ['"Bricolage Grotesque"', 'sans-serif'],
                        serif: ['"Bricolage Grotesque"', 'sans-serif'],
                        sans: ['"IBM Plex Sans"', 'sans-serif'],
                        mono: ['"Space Mono"', 'monospace'],
                    },
                }
            }
        }
    </script>
    <link rel="stylesheet" href="../../../base-style.css">
    <link rel="stylesheet" href="../../homepage/kinetic.css">
    <link rel="stylesheet" href="../style.css">
</head>

<body class="editorial kinetic bg-paper text-ink font-sans antialiased">
    <span class="read-progress" id="read-progress" aria-hidden="true"></span>

    <main-navbar site="../../../"></main-navbar>

    <article class="post-shell is-ready">
        <header class="post-header">
            <div class="post-header__inner">
                <a href="../" class="post-back">
                    <i class="fas fa-arrow-left"></i> All writing
                </a>
                <p class="post-eyebrow">${escapeHtml(meta.tag || 'Blog')}</p>
                <h1 class="post-title">${escapeHtml(title)}</h1>
                <div class="post-meta">${metaBits.join('<span class="post-meta__sep">/</span>')}</div>
            </div>
        </header>

        <div class="post-body">
            <div class="prose">
${bodyHtml}
            </div>

            <footer class="post-footer">
                <a href="../" class="post-back post-back--foot">
                    <i class="fas fa-arrow-left"></i> Back to all writing
                </a>
            </footer>
        </div>
    </article>

    <footer class="footer">
        <div class="container">
            <p>Copyright &copy; Domen Hribernik <span id="currentYear"></span></p>
        </div>
    </footer>

    <script type="module" src="../../../components/main-navbar.js"></script>
    <script src="../static-post.js"></script>
    <script src="../../../components/gtranslate.js"></script>
</body>

</html>
`;
}

//? Slugs must be url-safe and must not collide with the blog's own files.
const RESERVED_SLUGS = new Set(['posts', 'index.html', 'index.js', 'post.html', 'post.js', 'blog.js', 'style.css', 'static-post.js']);

export function validateSlug(slug) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
        throw new Error(`Invalid slug (lowercase letters, digits, hyphens only): ${slug}`);
    }
    if (RESERVED_SLUGS.has(slug)) throw new Error(`Slug collides with a blog file: ${slug}`);
    return slug;
}
