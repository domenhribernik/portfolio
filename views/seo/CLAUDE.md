# views/seo

Unlisted private SEO tool: noindexed, disallowed in `robots.txt`, and never registered in
`components/project-data.js`, `index.html`, or the navbar.

Two hash-routed tabs:

1. A written **2026 SEO playbook** (technical / on-page / content / authority / AI-GEO).
2. A live **per-page checklist**.

## The checklist state is a committed JSON file, not a DB

State lives in [checklist.json](checklist.json). Cells cycle status in memory and the
"Copy updated JSON" button exports the new state to paste back into the file. That is the
whole persistence story, deliberately, there is no backend here.

Pure logic (scoring, next-action ranking, filtering, schema validation) is
[logic.js](logic.js), tested by
[tests/seo-logic.test.mjs](../../tests/seo-logic.test.mjs). That suite **validates the
committed JSON against its schema**, so a bad hand-edit fails the test run rather than
silently corrupting the tool.

## What it is for

This page is the human guard against the site's hand-edited `<head>` tags drifting: every
public view carries its title, description, canonical, Open Graph block and (for
flagships) JSON-LD by hand. The site-wide machinery it documents lives in
[tools/seo/](../../tools/seo/), see
[tools/seo/CLAUDE.md](../../tools/seo/CLAUDE.md).

When adding a new public view, add a row here (root CLAUDE.md, "Adding a New Project",
step 5).
