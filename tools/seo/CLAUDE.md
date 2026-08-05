# tools/seo

The site-wide SEO generator. Plain node, **zero dependencies**, run with:

```bash
node tools/seo/generate.js          # write
node tools/seo/generate.js --check  # non-writing freshness guard
```

Production domain is `https://domenhribernik.com`. The *why* behind all of this is written
up in the playbook at [views/seo](../../views/seo/), which also holds the per-page
checklist guarding the hand-edited head tags.

## What the generator owns

It only owns content that changes when content changes. Everything it writes is
**generated, do not hand-edit**:

- `sitemap.xml`
- The homepage's static projects fallback, between the
  `<!-- seo:projects:start -->` / `<!-- seo:projects:end -->` markers inside
  `<projects-index>`. This is real light DOM that the component replaces at hydration, so
  non-JS crawlers still see the band, the featured picks and the full-edition link. It
  reads the `FEATURED` list from `components/projects-index/logic.js`.
- The full-edition fallback in `views/projects/index.html`
  (`<!-- seo:archive:start/end -->`), every registry entry with `../../`-prefixed
  internal links.
- The blog index's static post list (`<!-- seo:posts:start/end -->`).
- One prerendered static page per blog post at `views/blog/<slug>/index.html`.

It reads `components/project-data.js` directly, takes sitemap `lastmod` from `git log`
(hence `fetch-depth: 0` in CI), and **auto-drops any page that gains a `noindex`**.

## Files

- `config.js`: site origin, the editable `FLAGSHIP` list, extra public pages, and the
  deploy-excluded `NOT_DEPLOYED` list.
- `logic.js`: pure logic, tested.
- `markdown.js`: the bounded markdown renderer, tested.

Suites: `tests/seo-logic.test.mjs`, `tests/seo-generate.test.mjs`,
`tests/seo-markdown.test.mjs`. They render both real blog posts and validate the committed
`views/seo/checklist.json`, so a broken generator or a bad checklist edit fails the run.

## It is committed AND re-run in CI

`.github/workflows/deploy.yml` does `fetch-depth: 0`, runs the generator, then
`node --test tests/`, and excludes `tools/**` from the SFTP upload. So the artifacts are
committed for local truth and regenerated for deploy, and prod can never be stale.

## Head tags are NOT generated

Every public `views/*/index.html` carries its `<title>` (`{Name} | {plain descriptor}`),
meta description, absolute trailing-slash `<link rel="canonical">`, the Open Graph block
(`og:site_name/type/title/description/url/image` + `twitter:card summary_large_image`)
**by hand**. JSON-LD goes on the flagship views plus homepage, about and bloom:
`WebApplication` per flagship tool, `Person` + `WebSite` on the homepage, `ProfilePage` on
about, `Organization` on bloom. Private/unlisted views carry
`<meta name="robots" content="noindex, nofollow">`.

## Blog authoring workflow

1. Write `views/blog/posts/<slug>.md` with frontmatter `title/date/author/tag/excerpt`.
2. Add the slug to `views/blog/posts/manifest.json`.
3. Run `node tools/seo/generate.js`.
4. Commit everything, **including** the generated `views/blog/<slug>/` directory.

The live `post.html?slug=` reader still works but is noindexed; the generated per-slug
pages are the indexable ones.

**Deleting a post:** remove the md, the manifest entry, and the generated dir, then delete
the stale copy on the server over SFTP. Deploys never delete.

## Root files it does not own

`robots.txt` disallows `/app/` and every unlisted private tool, and references the
sitemap. `.htaccess` is **untracked** (gitignored AND excluded from the CI upload; the
server copy is updated by hand over SFTP). It merges the canonical-host 301s (www→apex,
http→https), the security denies (dotfiles, `app/config|models|vendor|cache`, active in
dev too), the legacy blog `?slug=` redirect, deflate/expires, and the pretty-URL rewrites
(`/rocks/` → `views/rocks/index.html`, `/views/x` collapsed to `/x/`). Those rewrite and
redirect rules are **prod-only** via a host-anchored `[S=7]` skip, because local XAMPP
serves the repo from `/portfolio/` where the absolute substitutions (and `../../` asset
paths under shortened URLs) would break.

`assets/img/og-default.png` is the 1200x630 default social card.
