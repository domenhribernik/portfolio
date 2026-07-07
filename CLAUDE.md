# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Personal portfolio website for Domen Hribernik. Pure static site on the frontend: HTML, CSS, and vanilla JavaScript with no build system, package manager, or framework. The backend is PHP (API proxying and database CRUD) plus a few standalone Python scripts (scheduled data jobs and Telegram alerts).

## Architecture

### Frontend: Page Structure

The main entry point is `index.html` (root), which loads its page-specific logic from [views/homepage/script.js](views/homepage/script.js). The `views/homepage/` folder contains CSS and JS unique to the landing page.

All page directories live under [views/](views/), named to match their URL path (e.g., `/views/rocks` → [views/rocks/](views/rocks/), `/views/tarok` → [views/tarok/](views/tarok/)). Each directory is self-contained with its own `index.html`, `style.css`, and `script.js`. Global styles shared across all pages are in [base-style.css](base-style.css).

Current project directories: `views/about`, `views/account`, `views/admin`, `views/blog`, `views/botaniq`, `views/homepage`, `views/hub`, `views/iliana`, `views/ip`, `views/jeger`, `views/maze`, `views/music`, `views/on-this-day`, `views/pricing`, `views/quizz`, `views/recipes`, `views/rocks`, `views/shopping`, `views/slovenia`, `views/sourdough`, `views/spy`, `views/stocks`, `views/tarok`, `views/thesis`, `views/valentine`, `views/vrata`, `views/workout`.

Note: `views/account`, `views/admin`, `views/hub`, `views/pricing`, `views/shopping`, `views/stocks`, `views/valentine`, and `views/vrata` are **unlisted private tools**. They are intentionally not registered in `components/project-data.js`, not linked from `index.html`, and not in the main navbar. Do not add them to any of those. (`views/vrata` is also a standalone PWA with its own `manifest.json` and service worker, backed by `app/proxys/vrata.php`. `views/account` is the sign-in/account page and `views/admin` the admin dashboard of the auth system, see "Authentication and Permissions" below. `views/hub` is the installable PWA app launcher: its manifest `scope` resolves to the site root, so tiles open other views chrome-free inside the standalone window; backed by `app/controllers/hub-controller.php` and the `hub_apps` table in `app/models/hub-model.sql`, tiles are managed from the `views/admin` dashboard, and visibility is per-user via the projects registry, with a tile whose project is NULL visible to any signed-in user.)

`views/botaniq` stays public (listed, linked) and is the reference example of the **read-only demo plus per-user rows** shape: signed-out visitors see the site owner's plants with all action buttons grayed out and a sign-in button top right, while any signed-in user gets their own private shelf (`plants.user_id`), no project role needed. Reads are public in `plants-controller.php` (the demo shelf is the first active admin's), writes sit behind `Auth::requireLogin()` and are scoped to the caller's own rows. See "Authentication and Permissions" below.

A view directory may include its own `CLAUDE.md` for project-specific notes that don't belong in this root file (grid contracts, tricky invariants, file-map for a complex subtree, etc.). These are auto-loaded when working inside that directory. Existing per-view CLAUDE.md files: [views/admin/CLAUDE.md](views/admin/CLAUDE.md) (also documents the site-wide authorization pattern), [views/garden/CLAUDE.md](views/garden/CLAUDE.md) (the reusable 3D CSS toolkit: transform pipeline contract, non-inheritance of pipeline vars, and the recipe for building new 3D scenes from flat divs), [views/maze/CLAUDE.md](views/maze/CLAUDE.md), [views/music/CLAUDE.md](views/music/CLAUDE.md), [views/workout/CLAUDE.md](views/workout/CLAUDE.md) (screen map, session lifecycle, soft-delete and type-immutability contracts). When a view grows complex enough that re-deriving its conventions from the code wastes context, add a `CLAUDE.md` to that view rather than expanding this root file.

### Frontend: Styling

Default to **Tailwind CSS** for styling on any new view. Pull it in via the CDN (`<script src="https://cdn.tailwindcss.com"></script>`) and, if needed, configure custom colors and fonts inline with `tailwind.config = { ... }`. See [views/rocks/index.html](views/rocks/index.html) and [views/ip/index.html](views/ip/index.html) for examples. There is no build step.

Use the view's `style.css` only for things Tailwind can't cleanly express:
- `@keyframes` and named animations
- `::before` / `::after` pseudo-element decorations (terminal prompts, glitch overlays, scanlines, generated content)
- Complex hover/focus effects that involve sweeping pseudo-elements, multi-layer text-shadows, or stacked filters
- State classes toggled by JS where the *default* must be `display: none` (e.g., `.loading`, `.error`, `.visible`)
- Print styles, `prefers-reduced-motion` overrides, and other rare media queries

Existing views written before this convention (e.g. `homepage`, `about`, `tarok`) still use a plain `style.css`. Don't migrate them as part of unrelated work; convert only when explicitly asked.

Gotcha: `base-style.css` paints `body` with a navy **gradient** via the `background` shorthand. A gradient is a background-image, so it visually overrides any Tailwind `bg-*` utility (which only sets background-color). A view with its own full-page background must reassert it in its `style.css` (`body { background: <color>; }`), as `views/workout` does.

**Pixel-alignment (discolored seams / "glitchy" edges on big or high-DPI displays).** Stacked, absolutely-positioned elements that use CSS gradients and/or `clip-path` (CSS-drawn art, color swatches, the iliana envelope) render thin discolored hairline seams when their anti-aliased edges land on fractional device pixels. The fix is to promote each layer onto its own GPU layer so it rasterizes on the device pixel grid: add `transform: translateZ(0)` (append it to any existing transform, e.g. `translate(-50%,-50%) translateZ(0)`, never replace) and `backface-visibility: hidden`. **Exception:** do NOT add `backface-visibility: hidden` to an element that rotates past 90° (e.g. a flap doing `rotateX(178deg)`) or its backface will vanish; use `translateZ(0)` alone there. Precedents: [views/ip/style.css](views/ip/style.css) (`.color-swatch`/`.legend-dot` under a `min-resolution: 192dpi` query) and [views/iliana/anniversary/style.css](views/iliana/anniversary/style.css) (the envelope layers).

### Frontend: Component System

Reusable web components live in [components/](components/) and are imported as ES modules via `<script type="module">`:

- [components/gallery.js](components/gallery.js): Dynamic image gallery/carousel component
- [components/main-navbar.js](components/main-navbar.js): Site-wide navigation bar
- [components/project-card.js](components/project-card.js): Project display card
- [components/project-data.js](components/project-data.js): **Central data registry** for all portfolio projects; add new projects here
- [components/projects-grid.js](components/projects-grid.js): `<projects-grid category="...">` web component; auto-renders one `<project-card>` for every `project-data.js` entry matching that `category`, newest first. Used by `views/about`; the homepage projects section uses `<projects-index>` instead.
- [components/projects-index.js](components/projects-index.js): `<projects-index category="..." label="...">` editorial index rows for the homepage projects section, reading the same `project-data.js` registry (newest first). The whole row is one stretched-link tap target pointing at the entry's primary link (visitSite, else readMore, else code, else demo); remaining links render as small chips. The clay/cobalt/pine accent cycle runs continuously across all instances on the page (custom elements upgrade in document order). Each group collapses to 3 rows behind its own Show More toggle. Desktop-pointer hover wipes the title letters to the row accent (background-clip: text sweep) and shows a cursor-following icon stamp, both skipped on touch and reduced-motion; styles live in [views/homepage/kinetic.css](views/homepage/kinetic.css).
- [components/rocks/](components/rocks/): the Rocks feature. `rock-builder.js` is the shared Three.js geometry/mesh builder and `rocks-showcase.js` is the `<rocks-showcase>` embeddable rotating view. The editor at `views/rocks` imports the builder so both stay visually in sync.
- [components/auth-gate.js](components/auth-gate.js): reusable login-wall *behavior* (not markup) for any view gated by `Auth::requireProjectRole()`. Exports `gatedFetch(url, options, { onSignedOut, onForbidden, onOk, onError })` to classify a gated endpoint's response, and `loginUrl()` to build the `../account/?redirect=...` link. Each view still owns its own "please sign in" markup/styling, matching its own visual language, this only removes the repeated 401/403 branching and redirect-URL logic. `views/botaniq` uses `loginUrl()` for its sign-in links; `gatedFetch` currently has no consumer (botaniq moved from a whole-page login wall to a public read-only demo) but stays for the next whole-page-gated view.
- [components/back-link.js](components/back-link.js): plain (non-module) script that upgrades a view's back arrow (`<a id="back-link" href="../../">`) to real history-back navigation when the visitor arrived from the same origin (e.g. from the hub launcher); the hardcoded href stays as the fallback for direct visits and cross-origin referrers. Include it as a plain `<script>` before the view's own script tag. Used by `views/botaniq` and `views/sourdough`.

Site-wide third-party embeds are imported by most view pages: [components/google-analytics.js](components/google-analytics.js), [components/gtranslate.js](components/gtranslate.js) (translate widget: en/sl/de/es/fr/zh-CN), and [components/tawk-chat.js](components/tawk-chat.js) (live chat). Include all three on new public views for consistency, loaded as plain `<script>` tags before `</body>` (use `../../` relative paths from a view). The navbar's language dropdown is **not** self-contained: `main-navbar.js` only renders the picker shell with an empty `.gtranslate_wrapper`; `gtranslate.js` injects the actual language links into it. Omit `gtranslate.js` and the dropdown renders but does nothing. (This bit the `views/blog` pages, which had only `google-analytics.js`.)

When a feature grows to need multiple component files (shared builders + extra web components), group them under `components/<feature>/` rather than flat at the root.

### Backend (PHP and Python)

The [app/](app/) directory contains the backend, structured as follows:

- [app/config/](app/config/): Database access and other configuration (e.g., `database.php`, `dev-mode.php`, `auth.php`)
- [app/models/](app/models/): SQL / data storage definitions
- [app/controllers/](app/controllers/): CRUD operations for the database
- [app/services/](app/services/): Higher-level functions that compose controllers; called by the frontend when logic is complex
- [app/proxys/](app/proxys/): External API proxies (hide API keys from the client) and small server-side endpoints. Current: `apod-proxy.php` (NASA APOD), `otd-proxy.php` (On This Day), `stats-proxy.php` (codebase line/file counts, cached daily), `tabs-proxy.php` (Songsterr tab search for the music view; Songsterr has no CORS), `vrata.php` (backend for the private `vrata` tool).
- [app/cache/](app/cache/): Cached responses from proxies and the Python scripts, to avoid redundant external fetches
- [app/data/](app/data/): Static JSON data files (e.g., `rocks.json`)
- [app/admin/](app/admin/): Internal HTML admin tools (image manager, upload test); not linked from the public site
- [app/scripts/](app/scripts/): Standalone Python scripts. `check_stocks.py` fetches quotes, logs to `app/cache/`, and sends a Telegram alert on moves >=2%; helpers are `yahoo.py` (quote fetch), `telegram.py` (Telegram client), and `notify.py`; these run periodically (e.g. via cron), not from PHP. Exception: `analyze_audio.py` (MP3 musical analysis for the music view, numpy + ffmpeg) IS invoked from PHP by `music-controller.php` via `exec()`.
- [app/vendor/](app/vendor/): Composer dependencies (phpdotenv for `.env` loading)

When developing locally without XAMPP running, requests that go through PHP proxies/services will fail.

### Authentication and Permissions

Global user accounts with Google Sign-In as the primary login (GSI ID token verified server-side via Google's tokeninfo endpoint in [app/services/google-auth-service.php](app/services/google-auth-service.php)) and an optional backup username/password set after the first Google login. Sessions are DB-backed: an opaque token in an httpOnly `portfolio_sid` cookie, stored only as a SHA-256 hash in the `sessions` table (30 days, sliding). Schema lives in [app/models/auth-model.sql](app/models/auth-model.sql) (`users`, `sessions`, `projects`, `user_project_roles`, `password_resets`, `login_attempts`). The admin account self-bootstraps: a Google login matching `ADMIN_EMAIL` in `.env` gets `is_admin = 1`.

Key pieces:
- [app/config/auth.php](app/config/auth.php): the static `Auth` class, the **single shared auth include** (do NOT copy-paste auth checks like other controller helpers; a drifted copy is a security bug). Gates: `Auth::requireLogin()`, `Auth::requireAdmin()`, `Auth::requireProjectRole($key, $role)` (site admins implicitly pass all project checks). Each denies with a JSON 401/403 and exits.
- [app/controllers/auth-controller.php](app/controllers/auth-controller.php): login (Google + password), logout, `me`, `config`, set-credentials, one-time reset consumption, own sessions. Rate limits password logins via `login_attempts`.
- [app/controllers/admin-controller.php](app/controllers/admin-controller.php): admin-only user/role/project/session/reset management, backing `views/admin`.
- `views/account`: sign-in and account page (supports `?redirect=` and `?reset=<token>`); `views/admin`: the dashboard.

**Wiring a view into the user system:** register the project (from the admin dashboard, or a seed `INSERT` into `projects`), then gate the controller with two lines: `require_once __DIR__ . '/../config/auth.php';` and `Auth::requireProjectRole('<project_key>', '<role>');`. Role names are free-form per project (e.g. `editor`, `viewer`, `player`). Four backend shapes exist depending on the feature's audience: `images-controller.php` (public GETs, project-role-gated writes), the **read-only demo plus per-user rows** shape (public GETs serve the signed-in user's own rows or, signed out, the site owner's as a demo; writes need only `Auth::requireLogin()` and are scoped by a `user_id` column, no project registration at all), the **public catalog plus login-gated own rows** shape (`recipes-controller.php`, `views/recipes`: public GETs list EVERYONE's rows with the author's `COALESCE(display_name, username)` joined in, never the email; writes need only `Auth::requireLogin()` scoped `AND user_id = ?`; per-user ratings upsert against `UNIQUE(recipe_id, user_id)`; the whole recipe document saves atomically in one transaction, child rows rewritten), and project-role gating for a private audience. The demo shape's helpers are the same in each controller (`showcaseUserId()` = first active admin, `shelfUserId()` = viewer or showcase) and every write query carries `AND user_id = ?`; current examples are `plants-controller.php` (`views/botaniq`, per-row plants), `sourdough-controller.php` (`views/sourdough`, a lazily-created one-per-user starter plus per-user loaves, with a `?resource=session` endpoint returning `{demo, viewer}`), `jeger-controller.php` (`views/jeger`, one JSON checklist row per user, upserted with `ON DUPLICATE KEY`), and `workout-controller.php` (`views/workout`, per-user workouts/exercises plus session logging; introduces the repo's **soft delete** convention: `deleted_at DATETIME NULL` on `workouts`/`workout_exercises`, every read filters `deleted_at IS NULL`, so analytics history survives deletion; see [views/workout/CLAUDE.md](views/workout/CLAUDE.md)). When a feature additionally needs per-user visibility of individual rows (e.g. shopping collections shared with different people), layer a `<feature>_<resource>_access` ACL table on top of the project gate; that pattern is documented in [views/admin/CLAUDE.md](views/admin/CLAUDE.md), first integration `shopping-controller.php`.

On the frontend, a whole-page-gated view uses [components/auth-gate.js](components/auth-gate.js) to turn a 401/403 from its own controller into a "please sign in" / "no access yet" state, without hand-rolling that branching per view. The gate's markup and styling stay local to the view (see the styling rules above), only the fetch classification and the `../account/?redirect=...` URL building are shared. A demo-shaped view (`views/botaniq`, `views/sourdough`, `views/jeger`, `views/workout`) instead loads data for everyone, shows a sign-in button top right plus a read-only "you're viewing the owner's data" banner when the payload says `demo: true`, disables/greys its action controls in that state, and links its sign-in buttons through a `loginUrl()` (imported from `auth-gate.js` where the view is an ES module, or inlined as `../account/?redirect=<path>` where it is a plain script like sourdough and jeger).

**Gotchas:** cookie-authed controllers must NOT send `Access-Control-Allow-Origin: *` (invalid with credentials and dangerous; all consumers are same-origin). Auth/admin responses send `Cache-Control: no-store`. The session cookie's `Secure` flag comes from `!$DEV_MODE`, so prod must be https. Password resets are admin-driven only (the dashboard generates a one-time link, delivered manually); there is no email sending anywhere.

**XAMPP `exec()` gotcha:** XAMPP's Apache exports `LD_LIBRARY_PATH=/opt/lampp/lib`, whose bundled (ancient) libstdc++ breaks system binaries launched from PHP (`ffmpeg` fails with `CXXABI`/`GLIBCXX` version errors). Any `exec()` of a system tool must strip it, e.g. `exec('env -u LD_LIBRARY_PATH ...')`. Precedent: `music-controller.php` (and `analyze_audio.py` strips it again before spawning ffmpeg).

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

## Testing

The `tests/` directory holds two zero-dependency suites (no npm packages, no framework, keeping the no-build-system rule; the root `package.json` is only a `"type": "module"` marker so node parses `.js` ES modules, never add dependencies to it):

- `node --test tests/` runs unit tests for DOM-free frontend logic modules (currently `views/admin/logic.js`). When a view's script grows non-trivial decision logic, extract it into a `logic.js` module the page imports and test it here instead of leaving it tangled in DOM code. Name browser-imported modules `.js`, not `.mjs`: Apache serves `.mjs` without a MIME type and browsers block it.
- `/opt/lampp/bin/php tests/hub-controller.test.php` runs integration tests for hub tile visibility. It seeds throwaway fixtures, boots a PHP built-in server pointed at the LOCAL scratch DB (`127.0.0.1`/`portfolio`) via `DB_*` env overrides, and cleans up after itself. The overrides make `database.php` skip `app/.env` (which points at the remote production database), so the tests can never touch prod. Requires the seeded `admin@test.local` and `guest@test.local` users with their known session tokens in the local DB.

## External Dependencies

Loaded via CDN, no local install needed:
- FontAwesome (icons)
- Google Fonts
- Devicons (tech stack icons)

## Writing Style

Avoid em dashes (`—`) everywhere in this codebase: in descriptions, comments, HTML content, and any other text. Use a comma, colon, or a new sentence instead.
