---
name: verify
description: How to launch and visually verify this site's pages headlessly (XAMPP + headless Chrome + puppeteer-core), including the homepage intro-overlay and hover-media gotchas.
---

# Verifying this site

Static frontend served by XAMPP. If `curl -s -o /dev/null -w "%{http_code}" http://localhost/portfolio/` returns 200, the site is up; PHP endpoints work too. No build step.

## Browser handle

No playwright installed; `/usr/bin/google-chrome` exists. Plain `--headless=new --screenshot` produces a blank paper-colored frame on the homepage (intro overlay + scroll reveals). Instead, `npm i puppeteer-core` in the scratchpad (it is ESM: use `await import('puppeteer-core')`, not `require`) and drive `/usr/bin/google-chrome`.

## Gotchas that produce false negatives

- **Homepage intro overlay**: wait for `document.documentElement.classList.contains('intro-done')` (failsafe adds it by 7s) before interacting or screenshotting, then give scroll reveals ~1s after `scrollIntoView`.
- **Hover media queries**: headless Chrome reports `hover: none` / `pointer: coarse`, so anything gated on `(hover: hover) and (pointer: fine)` silently no-ops. Spoof with:
  `--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4`
- **:focus-within / transition probes**: reading `getComputedStyle(...).transform` in the same tick as `.focus()` returns the transition's frame-0 value (looks like "not working"). Wait ~500ms and screenshot instead.
- Console shows a tawk.to CORS error on localhost; pre-existing environment noise, not a finding.

## Flows worth driving

- Homepage: hover a `.ppaper__story` (headline underlines in the section accent), professional splash + 3 ruled stories, passion briefs flow in 3 CSS columns (2 at tablet, 1 on mobile), the foot `.ppaper__crossref` links to `views/about/#academic-projects`. At 390px each section caps at 5 stories with a `.ppaper__more` toggle (hidden on wider viewports, where every story prints).
- `views/about/`: still uses `<projects-grid>`/`<project-card>` with Show More; regression-check it after touching anything under `components/project*`.
