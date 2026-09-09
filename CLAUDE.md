# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Rules for this file

This file is loaded on **every** session in this project, whether or not the work touches
what it describes. A `CLAUDE.md` in any subdirectory loads only when working there, and
costs nothing otherwise. So the default home for a fact is the subdirectory, not here.

Before adding anything to this file, apply these in order:

1. **The placement test.** Does it apply to work in more than one directory, or must you
   know it *before* deciding which directory to open? If no to both, it belongs in that
   directory's `CLAUDE.md`. One feature's internals are never root material, however
   interesting.
2. **Never enumerate what the filesystem already knows.** No directory listings, no test
   file inventories, no function catalogues. They drift silently and are wrong within
   weeks. Name the command instead (`ls views/`, `node --test tests/`). Enumerate only
   when the list itself carries a rule that cannot be derived, e.g. which views are
   private and must stay unregistered.
3. **One fact, one home.** Cross-reference, never restate. A summary that repeats a
   subdirectory file is two things to keep in sync, and the copy here is the one that
   goes stale.
4. **Write the gotcha, not the description.** Document what would bite someone, or what
   looks wrong but is deliberate. If the code plainly says it, don't.

**Tripwire:** this file should stay under ~20k chars. Past that, something in it has
failed rule 1. It was 51k once, and 71% of that was per-feature prose that belonged
next to the feature.

**When adding a subdirectory `CLAUDE.md`:** only once conventions have actually
accumulated, not by default with a new view. Link it with a relative path from its own
location, and keep it out of the deploy (`**/CLAUDE.md` is already excluded in
`.github/workflows/deploy.yml`, so nested files are not served publicly).

## Project Overview

Personal portfolio website for Domen Hribernik. Pure static site on the frontend: HTML, CSS, and vanilla JavaScript with no build system, package manager, or framework. The backend is PHP (API proxying and database CRUD) plus a few standalone Python scripts (scheduled data jobs and Telegram alerts).

## Architecture

### Frontend: Page Structure

The main entry point is `index.html` (root), which loads its page-specific logic from [views/homepage/script.js](views/homepage/script.js).

All page directories live under [views/](views/), **named to match their URL path** (e.g. `/views/rocks` → [views/rocks/](views/rocks/)). Each is self-contained with its own `index.html`, `style.css`, and `script.js`, and reaches shared code with `../../` paths. Global styles are in [base-style.css](base-style.css).

**Unlisted private tools.** These are intentionally not registered in `components/project-data.js`, not linked from `index.html`, and not in the main navbar. Do not add them to any of those:

`account`, `admin`, `dashboard`, `download`, `list`, `masaza`, `medication`, `narek`, `pricing`, `seo`, `stocks`, `valentine`, `vrata`.

Everything else under `views/` is public. Two exceptions to the "public means portfolio" rule: `views/store` is a product (the Everbloom storefront), and `views/wildflowers` is an unregistered experiment; neither belongs in `project-data.js` or the navbar.

### Frontend: Styling

Default to **Tailwind CSS** on any new view, via the CDN (`<script src="https://cdn.tailwindcss.com"></script>`). There is no build step.

**Do not retype the editorial palette.** A view in the house style loads the shared theme instead of declaring its own `tailwind.config`:

```html
<script src="https://cdn.tailwindcss.com"></script>
<script src="../../components/editorial/theme.js"></script>   <!-- classic script, NOT type="module" -->
<link rel="stylesheet" href="../../components/editorial/theme.css">
```

`theme.js` **must** be a classic `<script src>` immediately after the CDN tag: a `type="module"` script is deferred and would run after Tailwind's first pass, so the theme would silently not apply. Extra tokens or a different display face go through `editorialTheme({ colors: {...}, fonts: {...} })` on the next line, never by editing the shared file. `tests/editorial-theme.test.mjs` fails if a page declares the palette inline again, or if `theme.js` and `theme.css` drift apart.

A view with its own world (see the costume list in [DESIGN.md](DESIGN.md)) still configures Tailwind inline; that is what the shared theme is opting out of. See [views/rocks/index.html](views/rocks/index.html).

Views with the poster hero also load [components/editorial/poster.css](components/editorial/poster.css) and use `.poster-hero` / `.poster-grid` / `.poster-grain` rather than re-implementing the grain SVG and the 1/6 grid.

Use the view's `style.css` only for what Tailwind can't cleanly express:
- `@keyframes` and named animations
- `::before` / `::after` pseudo-element decorations (terminal prompts, glitch overlays, scanlines, generated content)
- Complex hover/focus effects involving sweeping pseudo-elements, multi-layer text-shadows, or stacked filters
- State classes toggled by JS where the *default* must be `display: none` (e.g. `.loading`, `.error`, `.visible`)
- Print styles, `prefers-reduced-motion` overrides, and other rare media queries

Views written before this convention (e.g. `homepage`, `about`, `tarok`) still use a plain `style.css`. Don't migrate them as part of unrelated work; convert only when explicitly asked.

**Gotcha: the body gradient beats Tailwind.** `base-style.css` paints `body` with a navy **gradient** via the `background` shorthand. A gradient is a background-image, so it visually overrides any Tailwind `bg-*` utility (which only sets background-color). A view with its own full-page background must reassert it in its `style.css` (`body { background: <color>; }`), as `views/workout` does.

**Gotcha: discolored seams on big or high-DPI displays.** Stacked, absolutely-positioned elements using CSS gradients and/or `clip-path` render thin discolored hairline seams when their anti-aliased edges land on fractional device pixels. Fix by promoting each layer onto its own GPU layer so it rasterizes on the device pixel grid: add `transform: translateZ(0)` (**append** it to any existing transform, e.g. `translate(-50%,-50%) translateZ(0)`, never replace) and `backface-visibility: hidden`. **Exception:** do NOT add `backface-visibility: hidden` to an element that rotates past 90° (e.g. a flap doing `rotateX(178deg)`) or its backface vanishes; use `translateZ(0)` alone. Precedents: [views/ip/style.css](views/ip/style.css) and [views/iliana/anniversary/style.css](views/iliana/anniversary/style.css).

### Frontend: Component System

Reusable web components live in [components/](components/), imported as ES modules via
`<script type="module">`. When a feature needs several files, group them under
`components/<feature>/` rather than flat at the root.
[components/project-data.js](components/project-data.js) is the **central data registry**
for all portfolio projects; add new projects there.

What each component is for, the `site` prefix convention, and the third-party embed
gotchas (including the navbar language dropdown that silently does nothing without
`gtranslate.js`) are in [components/CLAUDE.md](components/CLAUDE.md).

### Frontend: Page Chrome (applies to every view)

Three habits that produced clutter often enough to be worth naming. Full reasoning and
precedents are in [DESIGN.md](DESIGN.md); the short version:

1. **No decorative micro-copy in a header.** An eyebrow, ear or kicker prints only if it
   carries a count, date, state or section name. `Plate No. 4 · Network Cartography` and
   `Price: free` inform nobody and cost the most on a phone. Never add one unasked.
2. **End on `<site-footer>` and nothing else.** One line, the copyright. A licence credit
   or privacy note goes in the content beside what it describes, not in a colophon.
3. **The back arrow returns to the previous screen, not always the homepage.** Load
   `back-link.js`, which makes the `href` a fallback rather than the behaviour.

### Frontend: Dates (applies to every view)

**Never ship a bare `<input type="date">` for a date a person types.** A native date field renders in the *browser's* locale, not the page's: on a US-locale browser it shows `mm/dd/yyyy`, so a European user reads the fields as swapped and enters the wrong day. The `lang` attribute, CSS and the `value` format have no effect on how it is drawn.

The convention is **day-first, `dd.mm.yyyy`**, everywhere in the UI:

- Use a plain text input: `<input inputmode="numeric" maxlength="10" placeholder="dd.mm.llll">` (`llll` = leto on Slovenian pages; `dd.mm.yyyy` on English ones).
- Parsing and formatting live in the view's tested `logic.js`, never inline in DOM code. The reference pair is `parseDateSl()` / `toDateSl()` in [views/stocks/logic.js](views/stocks/logic.js). Normalize the field back through `toDateSl()` on `change` so what stays on screen is what gets stored.
- **ISO `yyyy-mm-dd` stays the only wire and storage format.** Day-first is presentation: parse on the way in, format on the way out, never send `dd.mm.yyyy` to a controller or store it in a column.
- Derive "today" from local time (`todayIso()`), not `new Date().toISOString().slice(0, 10)`: the UTC form is a day behind for the first hours of every CET/CEST morning. UTC slicing is fine only for arithmetic already anchored at noon.

Views written before this convention still use native date fields (`views/iliana`, `views/nebo`). Convert when asked, or when touching that form anyway.

### Backend (PHP and Python)

PHP for API proxying and database CRUD, plus a few standalone Python scripts (scheduled
data jobs and Telegram alerts). The directory map, the XAMPP `exec()` gotcha, and the
full auth model are in [app/CLAUDE.md](app/CLAUDE.md).

All media and data files live in [assets/](assets/). `app/data/` is **gitignored**
(server-side only), so any JSON a feature needs in version control must live in its view
folder instead (e.g. `views/nebo/stars.json`). When developing locally without XAMPP
running, requests through PHP proxies/services will fail.

### Authentication and Permissions

Global user accounts with Google Sign-In as the primary login, plus DB-backed sessions in
an httpOnly `portfolio_sid` cookie. [app/config/auth.php](app/config/auth.php) is the
**single shared auth include**, exposing `Auth::requireLogin()`, `Auth::requireAdmin()`
and `Auth::requireProjectRole($key, $role)`. Do NOT copy-paste auth checks the way other
controller helpers are copied, a drifted copy is a security bug.

Which gate a controller gets depends on its audience. The four backend shapes, how to
wire a new view in, the soft-delete convention and the cookie/CORS gotchas are all in
[app/CLAUDE.md](app/CLAUDE.md).

### SEO and Discoverability

Production domain `https://domenhribernik.com`. Two rules matter site-wide:

1. **Every public page's `<head>` is hand-edited** and must carry a `<title>` (`{Name} | {plain descriptor}`), meta description, absolute trailing-slash canonical, and the Open Graph + `twitter:card` block. Private/unlisted views carry `<meta name="robots" content="noindex, nofollow">` instead.
2. **`sitemap.xml` and the crawlable fallbacks are generated.** Do not hand-edit them; run `node tools/seo/generate.js` after touching `project-data.js` or the blog. CI re-runs it, so prod can never be stale.

Full details, including the blog authoring workflow and the `.htaccess` situation, are in [tools/seo/CLAUDE.md](tools/seo/CLAUDE.md). The playbook and per-page checklist live in [views/seo](views/seo/).

## Adding a New Project

1. **Register the project** in [components/project-data.js](components/project-data.js). Required: `category`, `gradient`, `title`, `description`, `links`, `iconClass`. Optional: `badge`, `noTarget`. Once registered it renders automatically in the `views/projects` full edition and (for academic entries) the about page. To feature it on the homepage, add its registry key to `FEATURED` in [components/projects-index/logic.js](components/projects-index/logic.js) at the right rank.
   - **`category` is what places the card**, not the `//? ...` comment headers (those are only visual grouping). Valid values: `"professional"`, `"academic"`, `"passion"`. Gotcha: the "Personal Projects" section uses `category: "passion"`, not `"personal"`.
   - `gradient` is the card background, a CSS `linear-gradient(...)`. It lives in the registry, not in `index.html`.
   - `links` is an object of named links (`visitSite`, `readMore`, `code`); the card renders one button per entry.

   **Writing the description:** Write it so a person actually wants to read it. Lead with the problem it solves or what makes it interesting, not a list of features or tech. Use plain conversational sentences. Keep it to 1-3 sentences. No em dashes (`—`) anywhere: use commas, colons, or split into two sentences instead. No hyphenated compound adjectives if a single word or short phrase works just as well. Look at the existing entries for tone.
2. **Create the project directory** under `views/` matching the desired URL path, containing `index.html`, `style.css`, and `script.js`. Import shared components and `base-style.css` using `../../` relative paths.
3. **If it uses a database**, create `app/models/<name>-model.sql` with the `CREATE TABLE` and seed `INSERT` statements. SQL is **always executed manually via phpMyAdmin**; never run SQL from code or migrations automatically. Add the matching `app/controllers/<name>-controller.php`.
   - **If it stores images**, do NOT duplicate image columns (`uuid`, `mime_type`, `width`, `height`, `file_size`) in the domain table. Add an `image_id INT NOT NULL` foreign-keyed to `images(id)` with `ON DELETE CASCADE`; the `images` table and `ImageService` handle file storage. Example: `iliana_photos.image_id → images.id`.
4. **Give the view a complete `<head>`** (see "SEO and Discoverability"), or `noindex, nofollow` if it is an unlisted private tool. If it should rank, add it to `FLAGSHIP` in `tools/seo/config.js`, run `node tools/seo/generate.js`, and add a row to `views/seo/checklist.json`.

## Testing

```bash
node --test tests/                              # all JS unit suites
/opt/lampp/bin/php tests/<name>.test.php        # one PHP integration suite
python3 tests/stocks-sync-py.test.py            # the cron wrapper
```

Zero dependencies, no framework, keeping the no-build-system rule. The root `package.json` is only a `"type": "module"` marker; **never add dependencies to it**.

Two rules that bite:

- **PHP suites needing a DB must boot with `DB_*` env overrides pointing at the LOCAL scratch DB.** Those overrides make `database.php` skip `app/.env`, which points at the **remote production database**. Copy an existing suite's setup rather than writing this from scratch.
- **Name browser-imported modules `.js`, not `.mjs`.** Apache serves `.mjs` without a MIME type and browsers block it. (Test files themselves are `.test.mjs`, never loaded by a browser.)

When a view's script grows non-trivial decision logic, extract it into a DOM-free `logic.js` the page imports and test that, rather than leaving it tangled in DOM code.

Per-suite detail and the remaining conventions are in [tests/CLAUDE.md](tests/CLAUDE.md).

## External Dependencies

Loaded via CDN, no local install needed:
- FontAwesome (icons)
- Google Fonts
- Devicons (tech stack icons)

## Writing Style

Avoid em dashes (`—`) everywhere in this codebase: in descriptions, comments, HTML content, and any other text. Use a comma, colon, or a new sentence instead.
