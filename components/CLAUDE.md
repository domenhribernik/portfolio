# components/

Reusable web components, imported as ES modules via `<script type="module">`. When a
feature needs several files, group them under `components/<feature>/` rather than flat
at the root.

`<projects-grid>` and `<project-card>` take the same `site` attribute as `main-navbar`
(the about page passes `site="../../"`; the homepage omits it). Same-site links in
`project-data.js` `links` are written relative to the **site root** (e.g. `views/music`),
so a page rendering them from a subdirectory must pass its site prefix.

## What each one is for

Only the ones carrying a rule you could not guess from the file itself:

- [project-data.js](project-data.js): **central data registry** for all portfolio
  projects; add new projects here. See the root [CLAUDE.md](../CLAUDE.md) for the
  required fields and how to write a description
- [project-links.js](project-links.js): DOM-free link helpers. `resolveLink(href, site)`
  applies the site prefix and leaves external URLs alone; `primaryLink()` /
  `secondaryLinks()` / `opensNewTab()` encode the shared
  **visitSite > readMore > code > demo** priority
- [projects-grid.js](projects-grid.js): `<projects-grid category="...">`, one
  `<project-card>` per matching registry entry, newest first. Used by `views/about`
- [projects-index/](projects-index/): `<projects-index>`, the homepage projects section.
  Deliberately does **not** print the whole registry: professional entries as a ruled
  band, then the hand-ranked `FEATURED` key list from `projects-index/logic.js`. Styles
  live in [views/homepage/kinetic.css](../views/homepage/kinetic.css), not here
- [rocks/](rocks/): `rock-builder.js` (shared Three.js geometry builder) and
  `rocks-showcase.js`. The editor at `views/rocks` imports the builder so both stay in sync
- [auth-gate.js](auth-gate.js): login-wall *behavior*, not markup. `gatedFetch()`
  classifies a gated endpoint's 401/403; `loginUrl()` builds the
  `../account/?redirect=...` link. Each view keeps its own gate markup and styling
- [back-link.js](back-link.js): plain (non-module) script upgrading a view's back arrow
  (`<a id="back-link">`) to real history-back. It walks the view's **own screens** first
  (a hash route like tells' `#/t/x` or beseda's `#topic/x` is a screen), then the
  same-origin page the visitor arrived from, and only then falls through to the `href`.
  Load it **before** the view's own script tag
- [site-footer.js](site-footer.js): `<site-footer>`, the one footer every page ends on.
  Self-styled, since most views never load `base-style.css`; `theme="dark"` on a dark
  ground. Renders the copyright **and** the legal line (Privacy / Terms / Cookie
  settings), whose hrefs resolve against `import.meta.url` so the same element works at
  any page depth
- [consent/consent.js](consent/consent.js): the cookie banner and `window.portfolioConsent`.
  Classic script, loaded before the trackers it gates. See "Third-party embeds" below

[gallery.js](gallery.js), [main-navbar.js](main-navbar.js) and
[project-card.js](project-card.js) do what their names say.

## Third-party embeds

Include [google-analytics.js](google-analytics.js) and [gtranslate.js](gtranslate.js) on
new public views. Do **NOT** add [tawk-chat.js](tawk-chat.js) to any new view; existing
views keep it until asked.

**Analytics and chat are consent-gated.** [consent/consent.js](consent/consent.js) holds
the decision, renders the banner and exposes `window.portfolioConsent`. Both trackers
register a purpose against it and load nothing until it is granted, so:

```html
<script src="../../components/consent/consent.js"></script>   <!-- must come first -->
<script src="../../components/google-analytics.js"></script>
```

Both are classic scripts, so document order is execution order. A tracker with no
consent.js in front of it **silently does nothing** rather than tracking unconsented,
which is the safe failure but an easy one to miss; `tests/legal.test.mjs` asserts the
pairing and the order. The banner only appears where a purpose was actually declared, so
a page with neither tracker shows nothing.

**Gotcha:** the navbar's language dropdown is **not** self-contained.
`main-navbar.js` renders only the picker shell with an empty `.gtranslate_wrapper`, and
`gtranslate.js` injects the actual links. Omit it and the dropdown renders but does nothing.
Since translation is a service the visitor asks for, `gtranslate.js` needs no consent
toggle, but it now fetches the widget on **first interaction** with the picker (or
immediately if a `googtrans` cookie shows a language was already chosen) rather than on
page load. The navbar's MutationObserver picks the links up whenever they arrive, so
arriving late is fine.

## Editorial theme

[editorial/](editorial/) holds the shared palette (`theme.js`, `theme.css`) and the
poster hero (`poster.css`). Loading rules and the `type="module"` gotcha are in the root
[CLAUDE.md](../CLAUDE.md) under "Frontend: Styling", since you need them before deciding
whether a new view opts in.
