---
name: homepage-redesign-architecture
description: How the light "editorial" theme is wired vs the rest of the dark site
metadata:
  type: project
---

The homepage (`index.html`) and `views/about/` were redesigned (2026-06) to a light Editorial Gallery theme; the other ~11 views stay dark. The light theme is opt-in per page via `<body class="editorial">`.

Key mechanics (so future edits don't fight it):
- `base-style.css` `:root` accent was de-purpled globally (`--primary-color` is now clay `#d4451f`). A `body.editorial { ... }` block **remaps the shared vars** (`--bg-dark`, `--text-light`, `--bg-card`, etc.) to light values, so all variable-driven CSS (navbar, `.section-title`, `.footer`, loading overlay, APOD) flips automatically on those two pages only.
- Project-card styling is centralized **once** in `base-style.css` under `body.editorial .project-card` (shared by both pages); `views/homepage/style.css` and `views/about/style.css` were trimmed to essentials. `project-card.js` no longer uses per-project purple gradients.
- Navbar scroll state is a `.scrolled` class toggled in `components/main-navbar.js` (was inline bg), styled per-theme in `base-style.css`.
- `views/homepage/otd-gallery.css` custom props are now scoped to `#on-this-day-section` (they used to leak via `:root`).
- Homepage uses Tailwind via CDN with an inline `tailwind.config` (tokens: paper/ink/clay/stone/pine, fonts Fraunces + IBM Plex Sans); cards still use semantic classes (not Tailwind) so they don't depend on the CDN's runtime JIT.

Related: [[design-aesthetic-preference]].
