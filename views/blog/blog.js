/* ============================================================
   Shared helpers for the static blog.
   The blog is fully static: posts live as .md files in posts/,
   each carrying YAML-ish frontmatter (title, date, author, ...).
   manifest.json just lists which slugs exist; the frontmatter
   inside each .md is the single source of truth for metadata.
   ============================================================ */

export const POSTS_DIR = 'posts/';

//? Load the list of post slugs (filenames without the .md extension).
export async function loadManifest() {
    const res = await fetch(`${POSTS_DIR}manifest.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error('Could not load the blog index.');
    return res.json();
}

//? Fetch a single post and split it into { meta, body }.
export async function loadPost(slug) {
    const res = await fetch(`${POSTS_DIR}${slug}.md`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Post not found: ${slug}`);
    const raw = await res.text();
    const { meta, body } = parseFrontmatter(raw);
    return { slug, meta, body };
}

//? Minimal frontmatter parser: a --- fenced block of key: value lines.
export function parseFrontmatter(raw) {
    const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
    const match = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text);
    if (!match) return { meta: {}, body: text.trim() };

    const meta = {};
    for (const line of match[1].split('\n')) {
        const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (!kv) continue;
        let val = kv[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        meta[kv[1].toLowerCase()] = val;
    }
    return { meta, body: text.slice(match[0].length).trim() };
}

//? "2026-05-28" -> "May 28, 2026". Leaves anything unparseable untouched.
export function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

//? Rough reading time from a word count, floored at one minute.
export function readingTime(markdown) {
    const words = markdown.replace(/[#>*`_\[\]()!~-]/g, ' ').split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / 200));
}

//? Strip markdown to plain text and clip to a word boundary near `max`.
//? Used for the card snippets on the index so we don't curate excerpts by hand.
export function plainExcerpt(markdown, max = 120) {
    const text = markdown
        .replace(/```[\s\S]*?```/g, ' ')      // fenced code blocks
        .replace(/`[^`]*`/g, ' ')             // inline code
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')// images
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> text
        .replace(/^>+\s?/gm, '')              // blockquote markers
        .replace(/^#{1,6}\s+/gm, '')          // headings
        .replace(/[*_~]/g, '')                // emphasis
        .replace(/<[^>]+>/g, ' ')             // stray html
        .replace(/\s+/g, ' ')                 // collapse whitespace
        .trim();

    if (text.length <= max) return text;
    const clipped = text.slice(0, max);
    const cut = clipped.lastIndexOf(' ');
    return `${(cut > 40 ? clipped.slice(0, cut) : clipped).replace(/[.,;:!?]$/, '')}…`;
}

//? Scroll-reveal that mirrors the homepage: hidden state is gated on JS.
export function observeReveals(scope = document) {
    document.body.classList.add('reveals-on');
    const obs = new IntersectionObserver((entries, o) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
                o.unobserve(entry.target);
            }
        });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    scope.querySelectorAll('.reveal:not(.is-visible)').forEach(el => obs.observe(el));
}
