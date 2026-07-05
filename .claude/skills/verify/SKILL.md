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
- **Hover media queries**: headless Chrome reports `hover: none` / `pointer: coarse`, so anything gated on `(hover: hover) and (pointer: fine)` (e.g. the projects-index cursor stamp) silently no-ops. Spoof with:
  `--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4`
- **:focus-within / transition probes**: reading `getComputedStyle(...).transform` in the same tick as `.focus()` returns the transition's frame-0 value (looks like "not working"). Wait ~500ms and screenshot instead.
- Console shows a tawk.to CORS error on localhost; pre-existing environment noise, not a finding.

## Flows worth driving

- Homepage: hover a `.pindex__row` (title letters wipe to accent + cursor stamp), click a `.pindex__more` toggle (each category collapses to 3 rows), mobile viewport 390px (rows + contact stack).
- `views/about/`: still uses `<projects-grid>`/`<project-card>` with Show More; regression-check it after touching anything under `components/project*`.
