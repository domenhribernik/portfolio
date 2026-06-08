# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Personal portfolio website for Domen Hribernik. Pure static site on the frontend: HTML, CSS, and vanilla JavaScript with no build system, package manager, or framework. The backend is PHP (API proxying and database CRUD) plus a few standalone Python scripts (scheduled data jobs and Telegram alerts).

## Architecture

### Frontend: Page Structure

The main entry point is `index.html` (root), which loads its page-specific logic from [views/homepage/script.js](views/homepage/script.js). The `views/homepage/` folder contains CSS and JS unique to the landing page.

All page directories live under [views/](views/), named to match their URL path (e.g., `/views/rocks` → [views/rocks/](views/rocks/), `/views/tarok` → [views/tarok/](views/tarok/)). Each directory is self-contained with its own `index.html`, `style.css`, and `script.js`. Global styles shared across all pages are in [base-style.css](base-style.css).

Current project directories: `views/about`, `views/blog`, `views/botaniq`, `views/homepage`, `views/iliana`, `views/ip`, `views/jeger`, `views/maze`, `views/music`, `views/on-this-day`, `views/presence`, `views/pricing`, `views/quizz`, `views/rocks`, `views/shopping`, `views/slovenia`, `views/sourdough`, `views/spy`, `views/stocks`, `views/tarok`, `views/thesis`, `views/valentine`, `views/vrata`, `views/workout`.

Note: `views/presence`, `views/pricing`, `views/stocks`, `views/valentine`, and `views/vrata` are **unlisted private tools**. They are intentionally not registered in `components/project-data.js`, not linked from `index.html`, and not in the main navbar. Do not add them to any of those. (`views/vrata` is also a standalone PWA with its own `manifest.json` and service worker, backed by `app/proxys/vrata.php`.)

A view directory may include its own `CLAUDE.md` for project-specific notes that don't belong in this root file (grid contracts, tricky invariants, file-map for a complex subtree, etc.). These are auto-loaded when working inside that directory. Existing per-view CLAUDE.md files: [views/maze/CLAUDE.md](views/maze/CLAUDE.md). When a view grows complex enough that re-deriving its conventions from the code wastes context, add a `CLAUDE.md` to that view rather than expanding this root file.

### Frontend: Styling

Default to **Tailwind CSS** for styling on any new view. Pull it in via the CDN (`<script src="https://cdn.tailwindcss.com"></script>`) and, if needed, configure custom colors and fonts inline with `tailwind.config = { ... }`. See [views/rocks/index.html](views/rocks/index.html) and [views/ip/index.html](views/ip/index.html) for examples. There is no build step.

Use the view's `style.css` only for things Tailwind can't cleanly express:
- `@keyframes` and named animations
- `::before` / `::after` pseudo-element decorations (terminal prompts, glitch overlays, scanlines, generated content)
- Complex hover/focus effects that involve sweeping pseudo-elements, multi-layer text-shadows, or stacked filters
- State classes toggled by JS where the *default* must be `display: none` (e.g., `.loading`, `.error`, `.visible`)
- Print styles, `prefers-reduced-motion` overrides, and other rare media queries

Existing views written before this convention (e.g. `homepage`, `about`, `tarok`) still use a plain `style.css`. Don't migrate them as part of unrelated work; convert only when explicitly asked.

### Frontend: Component System

Reusable web components live in [components/](components/) and are imported as ES modules via `<script type="module">`:

- [components/gallery.js](components/gallery.js): Dynamic image gallery/carousel component
- [components/main-navbar.js](components/main-navbar.js): Site-wide navigation bar
- [components/project-card.js](components/project-card.js): Project display card
- [components/project-data.js](components/project-data.js): **Central data registry** for all portfolio projects; add new projects here
- [components/projects-grid.js](components/projects-grid.js): `<projects-grid category="...">` web component; auto-renders one `<project-card>` for every `project-data.js` entry matching that `category`, newest first. This is why `index.html` contains no hand-written project cards.
- [components/rocks/](components/rocks/): the Rocks feature. `rock-builder.js` is the shared Three.js geometry/mesh builder and `rocks-showcase.js` is the `<rocks-showcase>` embeddable rotating view. The editor at `views/rocks` imports the builder so both stay visually in sync.

Site-wide third-party embeds are imported by most view pages: [components/google-analytics.js](components/google-analytics.js), [components/gtranslate.js](components/gtranslate.js) (translate widget: en/sl/de/es/fr/zh-CN), and [components/tawk-chat.js](components/tawk-chat.js) (live chat). Include all three on new public views for consistency, loaded as plain `<script>` tags before `</body>` (use `../../` relative paths from a view). The navbar's language dropdown is **not** self-contained: `main-navbar.js` only renders the picker shell with an empty `.gtranslate_wrapper`; `gtranslate.js` injects the actual language links into it. Omit `gtranslate.js` and the dropdown renders but does nothing. (This bit the `views/blog` pages, which had only `google-analytics.js`.)

When a feature grows to need multiple component files (shared builders + extra web components), group them under `components/<feature>/` rather than flat at the root.

### Backend (PHP and Python)

The [app/](app/) directory contains the backend, structured as follows:

- [app/config/](app/config/): Database access and other configuration (e.g., `database.php`, `dev-mode.php`)
- [app/models/](app/models/): SQL / data storage definitions
- [app/controllers/](app/controllers/): CRUD operations for the database
- [app/services/](app/services/): Higher-level functions that compose controllers; called by the frontend when logic is complex
- [app/proxys/](app/proxys/): External API proxies (hide API keys from the client) and small server-side endpoints. Current: `apod-proxy.php` (NASA APOD), `otd-proxy.php` (On This Day), `stats-proxy.php` (codebase line/file counts, cached daily), `vrata.php` (backend for the private `vrata` tool).
- [app/cache/](app/cache/): Cached responses from proxies and the Python scripts, to avoid redundant external fetches
- [app/data/](app/data/): Static JSON data files (e.g., `rocks.json`)
- [app/admin/](app/admin/): Internal HTML admin tools (image manager, upload test); not linked from the public site
- [app/scripts/](app/scripts/): Standalone Python scripts, not invoked from PHP. `check_stocks.py` fetches quotes, logs to `app/cache/`, and sends a Telegram alert on moves >=2%; helpers are `yahoo.py` (quote fetch), `telegram.py` (Telegram client), and `notify.py`. Intended to run periodically (e.g. via cron).
- [app/vendor/](app/vendor/): Composer dependencies (phpdotenv for `.env` loading)

When developing locally without XAMPP running, requests that go through PHP proxies/services will fail.

### Assets

All media (images, video, audio, documents) and data files live in [assets/](assets/).

## Adding a New Project

1. **Register the project** in [components/project-data.js](components/project-data.js). Required fields: `category`, `gradient`, `title`, `description`, `links`, `iconClass`. Optional: `badge`, `noTarget`. Once registered the card renders automatically (see below); there is no manual `index.html` step.
   - **`category` is what places the card**, not the `//? ...` comment headers (those are only visual grouping in the file). Valid values: `"professional"`, `"academic"`, `"passion"`. Gotcha: the "Personal Projects" section uses `category: "passion"`, not `"personal"`. [components/projects-grid.js](components/projects-grid.js) renders one `<project-card>` per matching entry, newest first (it reverses registry order).
   - `gradient` is the card background, a CSS `linear-gradient(...)`. Pick one that fits the project's theme. It lives here in the registry, not in `index.html`.
   - `links` is an object of named links (e.g. `visitSite`, `readMore`, `code`); the card renders one button per entry.

   **Writing the description:** Write it so a person actually wants to read it. Lead with the problem it solves or what makes it interesting, not a list of features or tech. Use plain conversational sentences. Keep it to 1-3 sentences. No em dashes (`—`) anywhere: use commas, colons, or split into two sentences instead. No hyphenated compound adjectives if a single word or short phrase works just as well. Look at the existing entries for tone.
2. **Create the project directory** under `views/` matching the desired URL path (e.g., `views/botaniq/`), containing `index.html`, `style.css`, and `script.js`. Import shared components (`main-navbar.js`, etc.) and `base-style.css` using `../../` relative paths (two levels up to reach the root).
3. **If the project uses a database**, create an SQL model file at `app/models/<name>-model.sql` with the `CREATE TABLE` and seed `INSERT` statements. SQL is always executed manually via phpMyAdmin; never run SQL from code or migrations automatically. Create the corresponding controller at `app/controllers/<name>-controller.php` following the existing CRUD pattern.
   - **If the project stores images**, do NOT duplicate image columns (`uuid`, `mime_type`, `width`, `height`, `file_size`) in the domain table. Instead, add an `image_id INT NOT NULL` column that foreign-keys to `images(id)` with `ON DELETE CASCADE`. The `images` table (and `ImageService`) handles all file storage; the domain table only holds its own context-specific metadata. Example: `iliana_photos.image_id → images.id`.
4. **Update the project directory list** in this file's "Frontend: Page Structure" section.

## External Dependencies

Loaded via CDN, no local install needed:
- FontAwesome (icons)
- Google Fonts
- Devicons (tech stack icons)

## Writing Style

Avoid em dashes (`—`) everywhere in this codebase: in descriptions, comments, HTML content, and any other text. Use a comma, colon, or a new sentence instead.
