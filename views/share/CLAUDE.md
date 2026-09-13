# views/share

The QR page. The bare address is a **rack of every project**; picking one opens its
code in a `<dialog>` plate. `share.domenhribernik.com/views/tells/` lands straight on
the Tells plate, with the rack behind it.

## This directory must stay self-contained

**No `../../` anywhere.** Not in an import, not in a `<link>`, not in a `src`. The
subdomain's document root is *this directory*, so a path that climbs out of it resolves
to nothing there while still working when the same files are opened at
`/views/share/` on the main domain. That is the worst possible failure mode: it works
locally and 404s only on the subdomain.

Consequences, all deliberate:

- Every shared file is an absolute `https://domenhribernik.com/...` URL: consent,
  analytics, `fonts.css`, `site-footer.js`, the favicon. `tests/share-page.test.mjs`
  fails on any `../` or root-relative reference in this directory.
- **`site-footer.js` is loaded as a classic script, not `type="module"`.** Cross-origin
  module scripts need CORS and classic scripts do not. It imports nothing, so this works.
- **The self-hosted fonts need one CORS header to work on the subdomain.** Font files are
  CORS-restricted even when the stylesheet is not, so without
  `Access-Control-Allow-Origin: https://share.domenhribernik.com` on `assets/fonts/files/`
  the page renders in `system-ui`. It still works, it just looks worse. The header is
  server config (root `.htaccess` is untracked), so it is a manual step.
- There is no `main-navbar`, no `base-style.css`, no `gtranslate`. The palette in
  `style.css` is a copy of DESIGN.md's tokens; that duplication is the price of the
  subdomain, so keep it in sync by hand rather than importing.
- The registry is unreachable, so card copy comes from **`catalog.json`**, which is
  generated. See below.
- No Tailwind CDN. A share link opens cold on a phone and the page is one card and one
  square; the JIT compiler would be the largest thing on it. Same call as
  `views/flowers/share`.

## Two routes, and why the host check is explicit

| Address | What it opens |
|---|---|
| `share.domenhribernik.com/views/tells/` | the Tells plate (target is the pathname) |
| `share.domenhribernik.com/` | the **homepage** plate, not the rack |
| `domenhribernik.com/views/share/` | the rack, no plate |
| `domenhribernik.com/views/share/?p=views/tells` | the Tells plate |
| `domenhribernik.com/views/share/?p=` | the homepage plate |

`requestedTarget()` switches on `hostname` starting with `share.` rather than sniffing the
path. Off the subdomain the pathname *is* this page's own address, so reading it would
make the page share itself forever. The `?p=` route is also how this is developed locally
and the fallback if the subdomain is ever down, so both must keep working.

**`null` and `''` are different answers, and collapsing them is the bug to avoid.**
`requestedTarget()` returns `null` for "names nothing, show the rack" and `''` for "the
homepage". The homepage is the thing most worth handing over, so it cannot share a value
with "nothing". `shareAddressFor()` is the inverse and takes the same distinction; it is
the single source for both a tile's `href` and the history entry the plate pushes, so a
link and the back button can never disagree. The two are held together by a round-trip
property test.

**The plate's history handling has one trap.** A dialog's `close` event is *queued*, not
fired synchronously, so a "closing silently" flag must be cleared by the handler, never on
the line after `close()`. Clear it early and a back button closes the plate, the handler
walks history back again, and the visitor falls off the page.

**The deploy may not carry `.htaccess` here.** The workflow's exclude list has a bare
`.htaccess` entry meant for the root one, and whether that glob also catches this nested
file depends on the upload action's matching, which is not documented and whose source is
not published. After the first deploy, check `share.domenhribernik.com/views/tells/`: an
Apache 404 rather than the card means the file did not arrive, and it is then a one-time
manual SFTP upload. Deploys never delete, so it stays.

`.htaccess` here has no `RewriteBase`, on purpose: the substitution then resolves against
whichever directory the file sits in, which is what makes one rule correct both as a
document root and at `/views/share/`.

## catalog.json is generated

`tools/seo/generate.js` writes it from `components/project-data.js`, `SHARE_EXTRAS` in
`tools/seo/share-catalog.js`, and the blog manifest. Do not hand-edit it; run
`node tools/seo/generate.js`. CI regenerates it, so it cannot go stale in production.

**Adding a public view to the site fails the build until it has a share card.** That is
the point: `buildShareCatalog` throws when a page in the sitemap inventory is described by
neither the registry nor `SHARE_EXTRAS`. Fix it by registering the project, or by adding
an icon, gradient **and `kind`** to `SHARE_EXTRAS` (the words then come from that page's
own hand-written `<title>` and meta description).

**Every card has a `kind`: `project`, `page` or `post`.** The rack shows `project` only.
Registry entries are projects by definition; blog posts are `post`. A `SHARE_EXTRAS`
entry has to declare its kind and the build throws if it does not, because `views/rocks`
(a project the registry does not carry) and `views/privacy` (furniture) are
indistinguishable by the time the page reads the catalog. `projectEntries()` reads the
kind and never infers it, so a stale catalog without kinds shows an empty rack rather than
filing the privacy policy as a project. Every catalog page stays reachable by address
regardless of kind; `kind` only decides what is listed.

Off-site registry entries (the professional client sites, two academic papers) are not in
the catalog at all and cannot be: `normalizeSharePath()` is a security boundary that
refuses anything leaving this site, so a code can only ever point at a page here.

## Dashboard tile

`app/models/seeds/dashboard-tile-share.sql` adds a Share tile for the admin only. The page
is public; only the launcher shortcut is private. It works by pointing the tile at a
`share` row in `projects` that nobody holds a role in, which leaves site admins. Granting
anyone a `share` role widens the tile to them.

## The encoder

`qr.js` is a from-scratch byte-mode encoder, versions 1 to 10, all four correction levels.
It is verified two ways and both matter:

- `tests/share-qr.test.mjs` checks spec *properties*, not remembered tables: GF(256)
  multiplication against an independent implementation, the generator polynomial by its
  roots, encoded blocks by the defining Reed-Solomon property, format and version strings
  by BCH divisibility.
- The golden digests at the end of that suite were frozen only after every catalog URL was
  rendered and read back by **jsQR** in a browser. If you change the encoder and a golden
  fails, re-run that round trip before updating the digest. A digest updated on its own
  proves nothing.

**The format bits are the trap.** Each of the two 15-bit copies stays in one line: one is
the whole of column 8, the other the whole of row 8. Interleaving the halves between them
produces a grid that still looks like a QR code and that no scanner can read, and every
structural test still passes. That bug was here once.

The code is always ink on card stock. Colouring the modules is the first thing anyone
suggests and the first thing that breaks scanning, so the project's colour appears only in
the 6px band across the top of the card, pulled most of the way to paper by
`subtleGradient()`.
