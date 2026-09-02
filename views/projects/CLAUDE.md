# views/projects (the full edition)

One public broadsheet page carrying **every** `components/project-data.js` entry. The
homepage deliberately prints less: the professional band plus the hand-ranked featured
picks (`FEATURED` in `components/projects-index/logic.js`). This page is where everything
runs in full.

New registry entries appear here automatically. There is nothing to wire.

## Layout

Masthead "Project Portfolio" over a live dateline (date and story count, nothing else),
then one section per category:
**A** Professional, **B** Passion, **C** Academic. Each section opens on a photo lead (a
halftone "press photo" built from the entry's registry `gradient` + `iconClass`) with the
rest in ruled newspaper columns.

A section is **newest-first unless it pins a presentation lead** via `leadKey` in its
`SECTIONS` entry. Section C pins `thesis`, so Virtual Runner fronts Academic & Research.

Type: headlines in Bricolage Grotesque (the site's display face), furniture in Space Mono.

## logic.js

The DOM-free edition builder (section order, the lead hoist, folios, dateline) is
[logic.js](logic.js), tested by
[tests/projects-edition-logic.test.mjs](../../tests/projects-edition-logic.test.mjs).

`editionMeta()` still returns a `volume` and `number`. The masthead stopped printing them
when the decorative furniture came out (see the eyebrow rule in
[DESIGN.md](../../DESIGN.md)), so the `[data-ed="volume"]` slot no longer exists and
`script.js` skips a missing slot rather than throwing. Deleting them from `logic.js` is
fine; leaving them is not a bug.

Link priority (visitSite > readMore > code > demo) is **not** reimplemented here: it
comes from the shared helpers in
[components/project-links.js](../../components/project-links.js). Registry links are
written relative to the site root, so this page passes its own `../../` prefix through
`resolveLink()`.

## Generated fallback

The crawlable fallback between the `<!-- seo:archive:start -->` / `<!-- seo:archive:end -->`
markers in `index.html` is **generated, do not hand-edit**. Run
`node tools/seo/generate.js` after touching the registry. See
[tools/seo/CLAUDE.md](../../tools/seo/CLAUDE.md).
