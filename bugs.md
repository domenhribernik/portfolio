# bugs.md — Security, correctness, performance & quality audit

Audit date: 2026-07-04. Scope: everything that ships (`app/` excl. `vendor/`+`cache/`, all of `views/`, `components/`, root `index.html`/`base-style.css`, Python scripts). Report only, no source changed.

**How to read this:** findings are ranked most-severe first, in severity buckets, each with a stable ID, `file:line`, impact, how to trigger it, and a concrete fix. The low-severity long tail is curated and grouped (one representative example + "applies to N more") rather than listed exhaustively.

**One-line takeaway:** the *new auth system itself is solid* (hashed tokens, prepared statements everywhere, timing-safe compares, sane CSRF backstops). The real exposure is the **large set of older controllers that were never wired into that auth system** and are reachable, unauthenticated, by anyone who knows the URL, one of which leaks other people's personal data.

Severity counts: **Critical 2 · High 4 · Medium 7 · Low 8 · Improvements 6**

---

## CRITICAL

### SEC-01 — `pricing-controller.php` leaks and lets anyone edit third parties' PII (IDOR, no auth)
- **Where:** [app/controllers/pricing-controller.php:20-33](app/controllers/pricing-controller.php#L20-L33), `getQuote()` [:177](app/controllers/pricing-controller.php#L177), `updateQuote()` [:128](app/controllers/pricing-controller.php#L128)
- **Impact:** The controller has **no authentication of any kind** and sets `Access-Control-Allow-Origin: *`. `GET pricing-controller.php?id=5` returns that quote's `ip_address`, `contact_name`, `contact_email`, `message`. IDs are sequential auto-increment, so an attacker can enumerate `?id=1,2,3…` and harvest the name, email, IP and message of **every person who ever requested a quote**. `PUT ?id=5` lets anyone silently rewrite any stored quote. This is exposure of *other people's* personal data, which is the worst category to leak.
- **Repro:** `curl 'https://site/portfolio/app/controllers/pricing-controller.php?id=1'` → full lead record. Increment the id.
- **Fix:** The *create* path (POST) is legitimately public (a lead form), but reads/edits must be admin-only. Gate `getQuote`/`updateQuote` behind `Auth::requireAdmin()` (add `require_once '../config/auth.php'`). Remove `Access-Control-Allow-Origin: *`. Do not return `ip_address` to non-admins.

### SEC-02 — Whole class of controllers is unauthenticated
(The original headline finding here, `presence-controller.php` exposing intimate personal data, is resolved: the presence project was removed entirely on 2026-07-05, view, controller, model and DB tables.)
- **Where:** [iliana-photos-controller.php](app/controllers/iliana-photos-controller.php), [stocks-controller.php](app/controllers/stocks-controller.php), [jeger-controller.php](app/controllers/jeger-controller.php), [rocks-controller.php](app/controllers/rocks-controller.php), [sourdough-controller.php](app/controllers/sourdough-controller.php), and the write paths of [music-controller.php](app/controllers/music-controller.php) (see SEC-05).
- **Impact:** A full auth system now exists (`Auth::requireProjectRole`), but these predate it and rely purely on the URL being unguessable ("unlisted private tools"). Anyone who knows/guesses the path can read and write:
  - **iliana-photos** — `POST` uploads new photos to the server, `DELETE ?id=` removes them, `POST ?id=` edits captions — all unauthenticated (`added_by` is restricted to `Domen`/`Iliana` but anyone can post as either).
  - **stocks / jeger / rocks / sourdough** — shared global state anyone can overwrite or destroy.
- **Fix:** Register each as a project and gate the controller with the two-line pattern from CLAUDE.md (`require_once '../config/auth.php'; Auth::requireProjectRole('<key>');`). For single-audience personal tools use `Auth::requireLogin()`/`requireAdmin()`. Drop `Access-Control-Allow-Origin: *` on all of them (they mutate server state and should be same-origin).

---

## HIGH

### SEC-03 — `vrata.php` unlocks a physical door on a `GET` with the key in the URL
- **Where:** [app/proxys/vrata.php:2](app/proxys/vrata.php#L2) (`*` CORS), [:29](app/proxys/vrata.php#L29) (key check), [:34](app/proxys/vrata.php#L34) + [:103](app/proxys/vrata.php#L103) (unlock runs on *any* method incl. GET)
- **Impact:** The gate is a shared secret passed as `?key=…`. Query strings land in web-server access logs, browser history, `Referer` headers and any proxy in between, so the door key is far more leak-prone than a header/body secret. Worse, unlock happens on a plain `GET`: any link-preview/prefetch bot (Telegram/WhatsApp/Slack unfurlers, antivirus URL scanners, browser prefetch) that ever sees the full URL will silently open the door. There is also no rate limit on the key check.
- **Repro:** `GET vrata.php?key=<key>` opens the lock. Paste that URL into any chat app that fetches link previews.
- **Fix:** Require `POST` for the unlock action (reject GET). Move the key out of the URL into a request header or JSON body. Better: now that real auth exists, gate the door behind a logged-in user + project role instead of a static shared key. Remove `Access-Control-Allow-Origin: *`. Add a short rate limit.

### SEC-04 — No web-server hardening: dotfiles, `.env`, `.git`, `.sql` are unprotected
- **Where:** repo root (no `.htaccess` anywhere), [app/.env](app/.env), [app/config/dev-mode.php:11](app/config/database.php#L11) (dev basePath), `.git/`
- **Impact:** There is **no `.htaccess` (or nginx equivalent) in the tree**. In dev, `app/.env` sits *inside* the document root (`$DEV_MODE` sets `basePath = dirname(__DIR__)` = `app/`), so `http://localhost/portfolio/app/.env` is served as plain text — and per your setup note that file holds the **production** DB credentials, Tuya door secrets, Telegram bot token, NASA key. `.git/` and `app/models/*.sql` are likewise servable as static files (source/schema disclosure) if the repo root maps under a web root. Prod mitigates the `.env` case by keeping it at `/usr/home/meuhdy/.env` (outside the web root — good), but nothing blocks `.git`, `.sql`, or a stray dotfile.
- **Repro (dev):** `curl http://localhost/portfolio/app/.env` → all secrets in cleartext.
- **Fix:** Add an `.htaccess` at the web root that denies dotfiles and sensitive extensions:
  ```apache
  <FilesMatch "(^\.|\.(env|sql|md|py|log)$)">
    Require all denied
  </FilesMatch>
  RedirectMatch 404 /\.git
  ```
  Move `app/.env` out of the doc root in dev too (mirror prod), and confirm `.git/` is not deployed to prod.

### SEC-05 — `music-controller.php` write/delete/analysis endpoints are open to the internet
- **Where:** [app/controllers/music-controller.php:10](app/controllers/music-controller.php#L10) (`*` CORS), `saveSync` [:140](app/controllers/music-controller.php#L140), `deleteSync` [:219](app/controllers/music-controller.php#L219), `runAnalysis` [:306](app/controllers/music-controller.php#L306)
- **Impact:** No auth. Anyone can overwrite/delete the chords & lyrics for any track (`POST`/`DELETE ?resource=sync`), and repeatedly `POST` 30 MB files to `?resource=analysis` — each one spawns a **synchronous Python + ffmpeg process** (`set_time_limit(180)`), so a handful of parallel requests exhausts PHP workers and CPU: a cheap denial-of-service. Input is validated (no command injection — args are `escapeshellarg`'d) and rendering is `textContent`, so this is authorization + resource-exhaustion, not RCE/XSS.
- **Repro:** loop `curl -X POST -F audio=@big.mp3 '…music-controller.php?resource=analysis'`.
- **Fix:** Gate `saveSync`/`deleteSync`/`runAnalysis` behind `Auth::requireProjectRole('music','editor')` (public GETs can stay open). Add a per-IP rate limit and a concurrency cap on analysis. Remove `Access-Control-Allow-Origin: *`.

### QUAL-01 / SEC — `dev-mode.php` is committed as `true`, and error bodies leak file:line
- **Where:** [app/config/dev-mode.php:3](app/config/dev-mode.php#L3), consumed by [hub-controller.php:73](app/controllers/hub-controller.php#L73), [images-controller.php:75](app/controllers/images-controller.php#L75)
- **Impact:** The single global `$DEV_MODE = true` drives three security-relevant behaviors: the session cookie's `Secure` flag (`!$DEV_MODE`), whether error responses include `get_class($e) . ': ' . message . ' [file:line]'`, and where `.env`/`vendor` are loaded from. Because it's committed as `true`, prod is entirely dependent on an out-of-band override; if the committed file ever reaches prod, cookies stop being `Secure` and internal paths/stack context leak to clients. This is fragile and easy to get wrong on deploy.
- **Fix:** Default the committed value to `false` (fail safe) and set `true` only locally via an untracked include or an env var (`getenv('APP_DEV')`). Never echo class/file/line to the client even in dev-of-record prod; log it instead.

---

## MEDIUM

### SEC-06 — Public JSON-file controllers allow destruction / disk-fill with no limits
- **Where:** [rocks-controller.php:79](app/controllers/rocks-controller.php#L79) (`clear` wipes all rocks), [jeger-controller.php:20](app/controllers/jeger-controller.php#L20) (POST overwrites the whole checklist), [tarok.php:40](app/proxys/tarok.php#L40) (unbounded number of 64 KB game files)
- **Impact:** `rocks` is a public, listed project: `POST {"action":"clear"}` deletes every visitor's rock instantly; `add` stores an arbitrary unvalidated `$rock` blob (size unchecked). `jeger` `POST` replaces the entire shared checklist JSON with whatever the client sends (no schema/size check). `tarok` accepts unlimited distinct `gameId`s (path traversal *is* prevented) so an attacker can fill the disk with 64 KB files (pruning only removes >7-day-old ones).
- **Fix:** Require auth for destructive actions (at minimum `clear`/full-overwrite). Validate and size-cap the stored payloads. For tarok, cap total files / add per-IP throttling.

### BUG-01 — `sanitize()`-on-input causes double-encoded display
- **Where:** server `sanitize()` = `htmlspecialchars` at write time in [plants-controller.php:82](app/controllers/plants-controller.php#L82), [sourdough-controller.php:53](app/controllers/sourdough-controller.php#L53), [pricing-controller.php:74](app/controllers/pricing-controller.php#L74); frontend *also* escapes, e.g. [views/botaniq/script.js:84](views/botaniq/script.js#L84) (`esc()`), rendered at [:277](views/botaniq/script.js#L277).
- **Impact:** A plant description with an apostrophe is stored as `&#039;`, then the frontend escapes again and the user literally sees `&#039;`. Every `&`, `<`, `>`, `'`, `"` in stored text is double-encoded on display. It also permanently mangles the data at rest. (Not an XSS hole — the double layer is "safe", just wrong output.)
- **Fix:** Adopt store-raw / encode-on-output. Remove the write-time `htmlspecialchars`; keep the frontend `esc()`/`textContent` as the single encoding step. (Fields already stored escaped will need a one-time cleanup.)

### PERF-01 — Plant images stored as BLOBs in the domain table (also violates CLAUDE.md)
- **Where:** [plants-controller.php](app/controllers/plants-controller.php) `image_data`/`image_mime`, served by `getPlantImage()` [:166](app/controllers/plants-controller.php#L166); [app/models/plants-model.sql](app/models/plants-model.sql)
- **Impact:** CLAUDE.md's own rule ("do NOT duplicate image columns; add `image_id` → `images(id)`") is followed by `iliana_photos` but not by `plants`. Storing image bytes inline bloats the `plants` table, forces PHP to stream every image through a DB round-trip, and every `SELECT *` risks pulling megabytes (the list query dodges it with `IF(image_data IS NOT NULL,1,0)`, so the pattern only half-works). 
- **Fix:** Migrate plant images to the `images` table + `ImageService` like `iliana_photos`, referencing by `image_id`.

### PERF-02 — List app polls every 2 s with a COUNT/MAX query each time
- **Where:** [views/list/script.js:6](views/list/script.js#L6) (`POLL_INTERVAL_MS = 2000`), server version via `collectionVersion()` [list-controller.php:210](app/controllers/list-controller.php#L210)
- **Impact:** Every active tab fires a request every 2 s; each runs `SELECT COUNT(*), MAX(updated_at)` plus an access check. Fine for a few users, but it's a steady DB load that scales with open tabs and never backs off.
- **Fix:** Increase the interval (5–10 s), back off when the tab is hidden (already partly done) and when idle, or move to SSE/long-poll. The `since`/version short-circuit is good; lengthening the base interval is the cheap win.

### BUG-02 — `apod-proxy.php` HTML-escapes the API key before putting it in a URL
- **Where:** [app/proxys/apod-proxy.php:23](app/proxys/apod-proxy.php#L23)
- **Impact:** `$apiKey = htmlspecialchars($_ENV['NASA_API_KEY'])` then interpolated raw into the request URL ([:66](app/proxys/apod-proxy.php#L66)). If the key ever contains `&`/`<`/`'` it's corrupted into `&amp;` etc.; it's also not URL-encoded. Works today only because the key happens to be alphanumeric. Also `?refresh` is public, so anyone can bypass the cache and burn the NASA quota.
- **Fix:** Drop `htmlspecialchars`; use `urlencode($_ENV['NASA_API_KEY'])` (or `http_build_query`). Rate-limit or ignore `?refresh` from anonymous callers.

### SEC-07 — HEIC uploads are handed to ImageMagick (untrusted-input surface)
- **Where:** [app/services/image-service.php:338](app/services/image-service.php#L338) `convertHeicToPng()` via `Imagick::readImageBlob()`
- **Impact:** MIME is validated by content first (`finfo`, and SVG is *not* allowed — good, so no SVG-XSS), but HEIC/HEIF bytes are then parsed by ImageMagick, which has a long history of parser CVEs (ImageTragick-class). The upload path that reaches this (`images`/`iliana`) is at least behind a role gate for `images`, but `iliana-photos` (SEC-02) is currently unauthenticated, so untrusted HEIC could reach Imagick.
- **Fix:** Keep Imagick patched and confine its delegates via `policy.xml` (disable coders you don't need). Prefer gating every upload path (fixing SEC-02 covers `iliana`).

---

## LOW

### LOW-01 — `iliana` "password" is client-side theater
[views/iliana/script.js:1-7](views/iliana/script.js#L1-L7): the two accepted passwords are hardcoded as base64 in the shipped JS and checked with `btoa()`; anyone can read them from source or call `initializeApp()` from the console. Combined with the unauthenticated backend (SEC-02) the page isn't private at all. If privacy matters, move it behind real auth; otherwise don't present it as protected.

### LOW-02 — `google_sub VARCHAR(32)` may truncate
[app/models/auth-model.sql:7](app/models/auth-model.sql#L7). Google's `sub` is spec'd up to 255 chars (currently ~21 digits); the verifier doesn't cap it. A future longer `sub` would error on insert or, worse, truncate and risk a collision. Widen to `VARCHAR(255)`.

### LOW-03 — `target="_blank"` without `rel="noopener"`
Representative: [index.html](index.html) (6×), [components/project-card.js](components/project-card.js) (4×), also `views/iliana`, `views/rocks`, `views/jeger`, `views/on-this-day`, `views/music` (**~15 occurrences across the site**). Modern browsers imply `noopener` for `_blank`, so impact is low, but add `rel="noopener noreferrer"` for older engines and to drop the referrer.

### LOW-04 — File-write endpoints have write races
`writeTickers` [stocks-controller.php:19](app/controllers/stocks-controller.php#L19), the tabs cache write [tabs-proxy.php:88](app/proxys/tabs-proxy.php#L88), and jeger all do read-modify-`file_put_contents` without a lock; concurrent writers can corrupt the JSON. `rocks-controller` already does the right thing (temp file + atomic `rename`, [:23](app/controllers/rocks-controller.php#L23)) — copy that pattern to the others.

### LOW-05 — Dead assignment in image upload
[app/controllers/images-controller.php:172](app/controllers/images-controller.php#L172): `$id = (int) Database::write()->lastInsertId();` is never used (the response is fetched by uuid). Remove it. (`uploadImage` also calls `Database::write()` a second time for `lastInsertId()`, opening on the write pool for what is effectively a read-back.)

### LOW-06 — Login/read paths use the write DB connection
e.g. [auth-controller.php:106-110](app/controllers/auth-controller.php#L106-L110) does the initial user `SELECT` on `Database::write()`, and list/plants read-then-write helpers open the write pool for reads. Harmless functionally, but it defeats the read/write split. Use `Database::read()` for pure reads.

### LOW-07 — `stats-proxy.php` reads every file fully to count lines
[app/proxys/stats-proxy.php:42](app/proxys/stats-proxy.php#L42) `count(file($path))` loads each file into memory. It's cached daily so the blast radius is small, but a stale-cache request triggers a full-tree walk any anonymous visitor can cause. Stream-count lines, or gate the recompute.

### LOW-08 — `assertSameOrigin()` short-circuits when `Origin` is absent
[app/config/auth.php:149-152](app/config/auth.php#L149-L152) returns early if no `Origin` header. This is a deliberate curl/non-browser allowance and the JSON-content-type requirement (`jsonBody()` 415s form posts) is the real CSRF backstop, so it's defensible — noting it so it's a conscious choice, not an accident. If you ever accept form-encoded bodies, this becomes a hole.

---

## IMPROVEMENTS (grouped, low urgency)

- **IMP-01 — Copy-pasted controller helpers.** `sendJson`/`sendError`/`jsonBody`/`sanitize` are duplicated verbatim across ~10 controllers (CLAUDE.md acknowledges this). A drifted copy is how bugs creep in. Extract to a shared `app/config/http.php` include, like `auth.php`/`database.php` already are.
- **IMP-02 — CORS policy is inconsistent and wrong on mutating endpoints.** The auth/admin/hub/images/list/plants controllers correctly omit `Access-Control-Allow-Origin`; the older ones (music, pricing, stocks, jeger, rocks, sourdough, iliana, tarok, apod, stats, vrata) send `*`. For state-changing, same-origin endpoints this is inappropriate. Default to no CORS header; add specific origins only where a cross-origin reader genuinely needs it.
- **IMP-03 — Adopt encode-on-output everywhere** (see BUG-01) and delete the write-time `htmlspecialchars` helpers.
- **IMP-04 — Consider a front controller / router.** Every controller re-implements method/param dispatch, `SECURE_ACCESS`, headers, and error handling. A thin router would remove that duplication and make it impossible to forget the auth include on a new endpoint (the root cause of SEC-01/02/05).
- **IMP-05 — Centralize upload validation.** `plants` and `iliana` hand-roll their own `finfo` MIME checks instead of going through `ImageService` (which already validates). Route all uploads through `ImageService::prepareFromUpload`.
- **IMP-06 — Add `rel="noopener noreferrer"`, `lang` attributes, and consistent third-party embeds.** Minor a11y/SEO/consistency pass across views (CLAUDE.md already notes the gtranslate/embed omission on `views/blog`).

---

### Notes on what was checked and found clean
- The auth core (`auth.php`, `google-auth-service.php`, `auth-controller.php`, `admin-controller.php`, `hub-controller.php`, `list-controller.php`) uses prepared statements throughout, hashes session/reset tokens with SHA-256, compares secrets with `hash_equals`, rate-limits password logins, and applies sensible CSRF backstops (JSON-only bodies + same-origin). No SQL injection was found in any controller (all dynamic SQL uses bound params; the only interpolated values — `LIMIT/OFFSET`, column-name lists — are integer-cast or from fixed allow-lists).
- Command execution in `music-controller.php` → `analyze_audio.py` is safe (`escapeshellarg`/`escapeshellcmd`, list-form `subprocess`, `LD_LIBRARY_PATH` stripped).
- Path traversal is correctly prevented in `ImageService::remove` (`realpath` + prefix check), `sanitizeFolder`, and `tarok.php`'s `sanitizeId`.
- Frontend rendering is largely XSS-safe: `list`, `iliana`, `music`, `botaniq` render server strings via `textContent`/`escapeHtml`/`esc`, and `account`'s `?redirect=` is validated to same-origin paths ([account/script.js:67](views/account/script.js#L67)).
