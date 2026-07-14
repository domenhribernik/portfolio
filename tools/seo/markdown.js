//? Minimal zero-dependency Markdown -> HTML renderer for the blog's
//? prerendered post pages. Deliberately bounded: it supports exactly the
//? constructs the posts use (headings, paragraphs, ordered/unordered lists,
//? fenced code blocks, blockquotes, hr, links, images, inline code, bold,
//? italic). Anything fancier belongs in the markdown, not here. The live
//? post.html reader still uses marked; this only feeds the generator.
//? Tested by tests/seo-markdown.test.mjs.

import { escapeHtml } from './logic.js';

//? Placeholder sentinel for code spans while the emphasis passes run.
//? U+0000 cannot appear in the escaped source text, so it never collides.
const SENTINEL = '\u0000';

//? Inline spans. Escape first, then substitute: the replacements only ever
//? introduce tags whose attribute values are themselves escaped.
export function renderInline(text) {
    let out = escapeHtml(text);
    // images before links (same bracket syntax)
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1">');
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
    // code spans win over emphasis inside them: substitute them first and
    // shield their content from the emphasis passes with placeholders.
    const codes = [];
    out = out.replace(/`([^`]+)`/g, (_, code) => {
        codes.push(`<code>${code}</code>`);
        return `${SENTINEL}${codes.length - 1}${SENTINEL}`;
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
    return out;
}

export function renderMarkdown(md) {
    const lines = String(md).replace(/\r\n/g, '\n').split('\n');
    const html = [];
    let i = 0;

    const paragraph = [];
    const flushParagraph = () => {
        if (!paragraph.length) return;
        html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
        paragraph.length = 0;
    };

    while (i < lines.length) {
        const line = lines[i];

        // fenced code block
        const fence = /^```(\w*)\s*$/.exec(line);
        if (fence) {
            flushParagraph();
            const lang = fence[1];
            const code = [];
            i++;
            while (i < lines.length && !/^```\s*$/.test(lines[i])) {
                code.push(lines[i]);
                i++;
            }
            i++; // closing fence
            const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
            html.push(`<pre><code${cls}>${escapeHtml(code.join('\n'))}</code></pre>`);
            continue;
        }

        // heading
        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading) {
            flushParagraph();
            const level = heading[1].length;
            html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
            i++;
            continue;
        }

        // horizontal rule
        if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
            flushParagraph();
            html.push('<hr>');
            i++;
            continue;
        }

        // blockquote (consecutive > lines become one quote)
        if (/^>\s?/.test(line)) {
            flushParagraph();
            const quote = [];
            while (i < lines.length && /^>\s?/.test(lines[i])) {
                quote.push(lines[i].replace(/^>\s?/, ''));
                i++;
            }
            html.push(`<blockquote><p>${renderInline(quote.join(' ').trim())}</p></blockquote>`);
            continue;
        }

        // lists (unordered - / *, ordered 1.)
        const ulItem = /^\s*[-*]\s+(.*)$/.exec(line);
        const olItem = /^\s*\d+\.\s+(.*)$/.exec(line);
        if (ulItem || olItem) {
            flushParagraph();
            const ordered = Boolean(olItem);
            const itemRe = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*]\s+(.*)$/;
            const items = [];
            while (i < lines.length) {
                const m = itemRe.exec(lines[i]);
                if (!m) break;
                items.push(`<li>${renderInline(m[1].trim())}</li>`);
                i++;
            }
            const tag = ordered ? 'ol' : 'ul';
            html.push(`<${tag}>${items.join('')}</${tag}>`);
            continue;
        }

        // blank line ends a paragraph
        if (/^\s*$/.test(line)) {
            flushParagraph();
            i++;
            continue;
        }

        paragraph.push(line.trim());
        i++;
    }
    flushParagraph();
    return html.join('\n');
}
