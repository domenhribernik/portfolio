# views/share

The QR landing page. `share.domenhribernik.com/views/tells/` shows a card for
`domenhribernik.com/views/tells/` with a code pointing at it.

## This directory must stay self-contained

**No `../../` anywhere.** Not in an import, not in a `<link>`, not in a `src`. The
subdomain's document root is *this directory*, so a path that climbs out of it resolves
to nothing there while still working when the same files are opened at
`/views/share/` on the main domain. That is the worst possible failure mode: it works
locally and 404s only on the subdomain.

Consequences, all deliberate:

- The analytics script and the favicon are absolute `https://domenhribernik.com/...` URLs.
- There is no `main-navbar`, no `base-style.css`, no `gtranslate`. The palette in
  `style.css` is a copy of DESIGN.md's tokens; that duplication is the price of the
  subdomain, so keep it in sync by hand rather than importing.
- The registry is unreachable, so card copy comes from **`catalog.json`**, which is
  generated. See below.
- No Tailwind CDN. A share link opens cold on a phone and the page is one card and one
  square; the JIT compiler would be the largest thing on it. Same call as
  `views/flowers/share`.

## Two routes, and why the host check is explicit

| Address | Target comes from |
|---|---|
| `share.domenhribernik.com/views/tells/` | the pathname |
| `domenhribernik.com/views/share/?p=views/tells` | the `p` query |

`targetPathFrom()` switches on `hostname` starting with `share.` rather than sniffing the
path. Off the subdomain the pathname *is* this page's own address, so reading it would
make the page share itself forever. The `?p=` route is also how this is developed locally
and the fallback if the subdomain is ever down, so both must keep working.

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
an icon and gradient to `SHARE_EXTRAS` (the words then come from that page's own
hand-written `<title>` and meta description).

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
