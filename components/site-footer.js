// <site-footer> — the one footer every page ends on.
//
// Views used to end on a bespoke colophon: a paragraph of method notes, a
// research bibliography, an explanation of what the tool is. Nobody read them
// and every page ended differently. The foot of a page is chrome, not content:
// it says who made this, plus the two links the law insists be reachable from
// anywhere, and nothing else. Anything a reader genuinely needs (a licence
// credit, a method note) still belongs in the content above it.
//
// The legal line is the one deliberate exception to "copyright and nothing
// else": GDPR and ePrivacy both require the privacy policy to be reachable
// from every page, and "Cookie settings" is how a visitor withdraws consent
// after giving it. That is chrome, not colophon prose. Do not read it as
// licence to add anything else down here.
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

.site-footer__legal {
    margin-top: 0.6rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 0.9rem;
    align-items: center;
    justify-content: center;
    font-family: 'IBM Plex Sans', sans-serif;
    font-size: 0.85rem;
}

.site-footer__legal a,
.site-footer__legal button {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    opacity: 0.85;
}

/* The cookie link is a button (it opens the banner, it does not navigate),
   so it has to be talked out of looking like one. */
.site-footer__legal button {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    cursor: pointer;
}

.site-footer__legal a:hover,
.site-footer__legal button:hover { opacity: 1; }

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

//? Pages sit at three different depths (/, /views/x/, /views/x/y/), so the
//? legal links are resolved against this module's own URL rather than written
//? as absolute paths. Keeps the local XAMPP prefix (/portfolio/...) working.
const SITE_ROOT = new URL('../', import.meta.url).href;

class SiteFooter extends HTMLElement {
    connectedCallback() {
        injectStyles();
        const dark = this.getAttribute('theme') === 'dark' ? ' site-footer--dark' : '';
        this.innerHTML = `
            <footer class="site-footer${dark}">
                <div class="site-footer__inner">
                    <p>Copyright &copy; Domen Hribernik ${new Date().getFullYear()}</p>
                    <div class="site-footer__legal">
                        <a href="${SITE_ROOT}views/privacy/">Privacy</a>
                        <a href="${SITE_ROOT}views/terms/">Terms</a>
                        <button type="button" data-footer-cookies>Cookie settings</button>
                    </div>
                </div>
            </footer>
        `;

        this.querySelector('[data-footer-cookies]').addEventListener('click', () => {
            //? consent.js is only on pages that gate something. Everywhere else
            //? the link still has to lead somewhere, so it falls through to the
            //? cookie section of the policy rather than doing nothing.
            if (window.portfolioConsent) window.portfolioConsent.open();
            else window.location.href = `${SITE_ROOT}views/privacy/#cookies`;
        });
    }
}

customElements.define('site-footer', SiteFooter);
