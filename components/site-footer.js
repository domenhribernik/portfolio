// <site-footer> — the one footer every page ends on.
//
// Views used to end on a bespoke colophon: a paragraph of method notes, a
// research bibliography, an explanation of what the tool is. Nobody read them
// and every page ended differently. The foot of a page is chrome, not content:
// it says who made this and nothing else. Anything a reader genuinely needs
// (a licence credit, a privacy note) belongs in the content above it.
//
// Light DOM, like <main-navbar>, so a page's own stylesheet can still reach in.
// The styles are injected here rather than living in base-style.css because
// most views never load base-style.css.
//
//   <site-footer></site-footer>                 paper ground (the default)
//   <site-footer theme="dark"></site-footer>    a view whose ground is dark

const STYLE_ID = 'site-footer-style';

const CSS = `
site-footer { display: block; }

.site-footer {
    --sf-fg: #6b6256;
    --sf-rule: rgba(28, 26, 23, 0.12);
    margin-top: 4rem;
    padding: 2rem 0;
    border-top: 1px solid var(--sf-rule);
    color: var(--sf-fg);
    text-align: center;
}

/* A dark ground keeps the same shape; only the two neutrals flip. */
.site-footer--dark {
    --sf-fg: #98a0c4;
    --sf-rule: rgba(231, 234, 248, 0.14);
}

.site-footer__inner {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 1.5rem;
}

.site-footer p {
    margin: 0;
    font-family: 'IBM Plex Sans', sans-serif;
    font-size: 0.95rem;
    line-height: 1.5;
}

@media (min-width: 768px) {
    .site-footer__inner { padding: 0 2rem; }
}
`;

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
}

class SiteFooter extends HTMLElement {
    connectedCallback() {
        injectStyles();
        const dark = this.getAttribute('theme') === 'dark' ? ' site-footer--dark' : '';
        this.innerHTML = `
            <footer class="site-footer${dark}">
                <div class="site-footer__inner">
                    <p>Copyright &copy; Domen Hribernik ${new Date().getFullYear()}</p>
                </div>
            </footer>
        `;
    }
}

customElements.define('site-footer', SiteFooter);
