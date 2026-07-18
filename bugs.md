# bugs.md: Security, correctness, performance & quality audit

Audit date: 2026-07-04. **Re-verified: 2026-07-18** against the current tree. Fixed findings were removed (they are listed in "Fixed since the audit" at the bottom), partially fixed ones were rescoped to what actually remains, and every open finding now carries a concrete, in-repo-precedented fix plan.

**How to read this:** findings are ranked most-severe first, in severity buckets, each with a stable ID, `file:line`, impact, how to trigger it, and a concrete fix. The low-severity long tail is curated and grouped rather than listed exhaustively.

**One-line takeaway (updated 2026-07-18):** the auth system is solid AND has now been retrofitted onto every controller that needed it (pricing, jeger, sourdough, plants, and as of today iliana-photos, stocks, rocks, the vrata door, and music writes). No unauthenticated mutation surface remains; web-server hardening (SEC-04) was accepted as low risk by the owner (secrets live outside `public_html`, the repo is intentionally open source). The top remaining item is QUAL-01 (`dev-mode.php` committed as `true`); one correctness bug (sanitize-on-input, BUG-01) still awaits its cleanup.

Severity counts: **Critical 0 · High 1 · Medium 7 · Low 9 (incl. the accepted SEC-04) · Improvements 6**

---

## CRITICAL

Nothing open. SEC-02 (the last Critical, unauthenticated iliana-photos/stocks/rocks) was fixed on 2026-07-18; see "Fixed since the audit" below. The music write paths it referenced stay tracked as SEC-05.

---

## HIGH

### SEC-03: `vrata.php` unlocks a physical door on a `GET` with the key in the URL
- **Status 2026-07-18: FIXED.** The proxy is now POST-only (bare GET → 405), the shared key is read from the JSON body only (a key in the URL counts as no key), it is same-origin gated via `Auth::assertSameOrigin()`, requires `Content-Type: application/json` (form-encoded → 415), and rate-limits failed key attempts per IP (a timestamp file in `app/cache/`, default 10 per 15 min, → 429). A signed-in user with a role in the new `vrata` project (admins implicitly) unlocks without needing the key at all. `Access-Control-Allow-Origin: *` removed; `Cache-Control: no-store` added. The PWA ([views/vrata/index.html](views/vrata/index.html)) now POSTs `{key, action}` with `credentials: 'same-origin'`. Covered by [tests/vrata.test.php](tests/vrata.test.php) (24 checks, incl. a fake Tuya cloud that proves denied requests reach the door zero times). **Prod deploy needs the project row:** run [app/models/vrata-model.sql](app/models/vrata-model.sql) (one `INSERT INTO projects`) so the session-role path resolves; the shared-key path works without it. Grant the `vrata` `user` role from the admin dashboard to anyone who should skip the key.
- **Original impact (for the record):** the gate was a shared secret passed as `?key=…`, so it landed in access logs, history, `Referer` and proxies, and unlock ran on a plain `GET`, meaning any link-preview/prefetch bot that saw the URL silently opened the door.

### SEC-05: `music-controller.php` write/delete/analysis endpoints are open to the internet
- **Status 2026-07-18: FIXED.** `saveSync`/`deleteSync`/`runAnalysis` are now behind `Auth::requireProjectRole('music', 'editor')` (public GETs stay open: the player, chord sheets, and analysis library still work for everyone). `Access-Control-Allow-Origin: *` removed, `Cache-Control: no-store` added. Analysis additionally has a **concurrency cap**: a lock file (`app/cache/music-analysis.lock`, mtime-based, stale after 300 s, released via a shutdown function so failed runs can't wedge it) makes a second simultaneous analysis return 429, so the synchronous Python + ffmpeg process can no longer be stacked. The per-IP rate limit from the original fix sketch was deliberately dropped: with the role gate, only authorized editors can reach `exec()` at all, so the anonymous DoS is gone and the lock only guards against accidental self-concurrency. Registered via a seed `INSERT` in [app/models/music-model.sql](app/models/music-model.sql) (run on prod, then grant the `editor` role from the admin dashboard). Editor and analysis pages show a sign-in hint on 401/403. Covered by [tests/music-controller.test.php](tests/music-controller.test.php) (26 checks; the analysis cases stop at the gate/lock/validation, so no Python ever runs in tests).
- **Original impact (for the record):** anyone could overwrite/delete the chords & lyrics for any track and stack 30 MB analysis uploads, each spawning a synchronous Python + ffmpeg process (`set_time_limit(180)`): a cheap denial-of-service. Input was already well validated (no command injection), so this was authorization + resource exhaustion, not RCE/XSS.

### QUAL-01 / SEC: `dev-mode.php` is committed as `true`, and error bodies leak file:line
- **Status 2026-07-18: unchanged.** [app/config/dev-mode.php:3](app/config/dev-mode.php#L3) still commits `$DEV_MODE = true;`.
- **Impact:** The single global `$DEV_MODE` drives three security-relevant behaviors: the session cookie's `Secure` flag (`!$DEV_MODE`), whether error responses include `get_class($e) . ': ' . message . ' [file:line]'`, and where `.env`/`vendor` are loaded from. Because it's committed as `true`, prod is entirely dependent on an out-of-band override; if the committed file ever reaches prod, cookies stop being `Secure` and internal paths leak to clients.
- **Fix:** Default the committed value to `false` (fail safe) and derive dev mode from the environment: `$DEV_MODE = getenv('APP_DEV') === '1';` plus an untracked local override. There is now solid in-repo precedent for the env-var seam: `stats-proxy.php` reads `STATS_ROOT`/`STATS_CACHE` via `getenv()` precisely so tests can override them, and every PHP integration suite already boots the built-in server with injected env vars, so a flipped default is directly testable. Never echo class/file/line to the client; log it instead.

---

## MEDIUM

### SEC-01: pricing `PUT` is still unauthenticated (the rest of the original Critical IDOR finding is fixed)
- **Status 2026-07-18: downgraded Critical → Medium; mostly fixed by the 2026-07-17 pricing rework.** Fixed: `GET ?id`, `GET ?all`, `PATCH`, `DELETE` are `Auth::requireAdmin()`-gated; `Access-Control-Allow-Origin: *` removed; raw IPs are no longer stored or returned (daily-salted `ip_hash` only). Covered by [tests/pricing-controller.test.php](tests/pricing-controller.test.php). The PII enumeration read leak is gone.
- **Remaining:** `PUT ?id=` → `updateQuote()` at [pricing-controller.php:26](app/controllers/pricing-controller.php#L26) has no auth. The quote wizard legitimately PUTs the visitor's own quote ([views/pricing/script.js:100](views/pricing/script.js#L100) keeps `currentQuoteId` after the initial POST), so admin-gating it would break the form. But ids are sequential, so anyone can overwrite any stored lead (data destruction, not a read leak: the response only echoes back what the caller just sent).
- **Fix:** ownership token. On create, generate `bin2hex(random_bytes(16))`, store its SHA-256 in a new `edit_token_hash` column, return the raw token only in the create response; require it on PUT and check with `hash_equals`. Frontend keeps it next to `currentQuoteId`. One manual `ALTER TABLE` in phpMyAdmin plus a case in the existing test suite. (Alternative: drop PUT entirely and make every submit an INSERT; dedupe in the admin leads inbox.)

### SEC-06: Public endpoints still allow disk-fill (rocks add, tarok; jeger and rocks clear fixed)
- **Status 2026-07-18: partially fixed.** `jeger` now stores one row per user behind `Auth::requireLogin()`, so the shared-checklist overwrite is gone. `rocks` `clear` is now admin-gated (fixed with SEC-02, covered by [tests/rocks-controller.test.php](tests/rocks-controller.test.php)). `tarok.php` now writes with `LOCK_EX` ([:71](app/proxys/tarok.php#L71)) but the file count is still unbounded.
- **Impact:** `rocks` `add` stays public by design (the toy) and still stores an arbitrary unvalidated `$rock` blob (size unchecked): a disk-fill / junk-data surface. `tarok` accepts unlimited distinct `gameId`s (path traversal is prevented) so an attacker can fill the disk with 64 KB files (pruning only removes >7-day-old ones).
- **Fix:** rocks: reject `add` bodies over a few KB and validate expected keys. tarok: refuse new gameIds once `count(glob($cacheDir . '/*.json'))` exceeds a cap (e.g. 2000) and return 429; optionally a small per-IP throttle file.

### BUG-01: `sanitize()`-on-input causes double-encoded display, and the pattern is spreading
- **Status 2026-07-18: still present, and now in MORE places.** Original sites remain ([plants-controller.php:113](app/controllers/plants-controller.php#L113), [sourdough-controller.php:64](app/controllers/sourdough-controller.php#L64), [iliana-photos-controller.php:70](app/controllers/iliana-photos-controller.php#L70), where the helper is now dead code, defined but never called, so it can simply be deleted, pricing's `sanitizeString` [:92](app/controllers/pricing-controller.php#L92)), and the helper was copy-pasted into the two NEWEST controllers: [recipes-controller.php:69](app/controllers/recipes-controller.php#L69) and [workout-controller.php:99](app/controllers/workout-controller.php#L99). Every new controller that copies it mangles more data at rest, so this is worth fixing soon even though it is not a security hole.
- **Impact:** A description with an apostrophe is stored as `&#039;`, then the frontend escapes again (`esc()`/`textContent`) and the user literally sees `&#039;`. Every `&`, `<`, `>`, `'`, `"` in stored text is double-encoded on display and permanently mangled at rest.
- **Fix:** Adopt store-raw / encode-on-output. Remove the write-time `htmlspecialchars` from all six controllers (keep `trim` + length caps); the frontends already escape on render, so they need no change. Run a one-time cleanup on existing rows (a small PHP script per table applying `htmlspecialchars_decode(..., ENT_QUOTES)`; safe to run twice since decode of already-clean text is a no-op). Ship the code change and the cleanup together.

### PERF-01: Plant images stored as BLOBs in the domain table (also violates CLAUDE.md)
- **Status 2026-07-18: unchanged.** `plants` still carries `image_data`/`image_mime`, served by `getPlantImage()` ([plants-controller.php:199](app/controllers/plants-controller.php#L199)).
- **Impact:** CLAUDE.md's own rule ("do NOT duplicate image columns; add `image_id` → `images(id)`") is followed by `iliana_photos` but not by `plants`. Inline bytes bloat the table, force PHP to stream every image through a DB round-trip, and every `SELECT *` risks pulling megabytes (the list query dodges it with `IF(image_data IS NOT NULL,1,0)`, so the pattern only half-works).
- **Fix (migration sketch):** add `image_id INT NULL` FK to `images(id)`; one-off script reads each `image_data` row and inserts it through `ImageService`; repoint `getPlantImage()` (keep the `?resource=image&id=` URL shape so the frontend does not change); drop the BLOB columns. SQL applied manually via phpMyAdmin per repo convention.

### PERF-02: List app polls every 2 s with a COUNT/MAX query each time
- **Status 2026-07-18: unchanged.** [views/list/script.js:6](views/list/script.js#L6) (`POLL_INTERVAL_MS = 2000`, collections 5000), server version via `collectionVersion()` in [list-controller.php](app/controllers/list-controller.php).
- **Impact:** Every active tab fires a request every 2 s; each runs `SELECT COUNT(*), MAX(updated_at)` plus an access check. Fine for a few users, but a steady DB load that scales with open tabs and never backs off when idle.
- **Fix:** The `since`/version short-circuit is good; the cheap win is lengthening the base interval (5–10 s) and backing off when the tab is hidden or the user is idle. SSE/long-poll only if it ever actually matters.

### BUG-02: `apod-proxy.php` HTML-escapes the API key before putting it in a URL
- **Status 2026-07-18: unchanged.** [apod-proxy.php:23](app/proxys/apod-proxy.php#L23) still `htmlspecialchars($_ENV['NASA_API_KEY'])`; `?refresh` ([:54](app/proxys/apod-proxy.php#L54)) is still public.
- **Impact:** If the key ever contains `&`/`<`/`'` it's corrupted into `&amp;` etc.; it's also not URL-encoded. Works today only because the key happens to be alphanumeric. Anyone can hit `?refresh` to bypass the cache and burn the NASA quota.
- **Fix:** Drop `htmlspecialchars`; use `urlencode($_ENV['NASA_API_KEY'])` (or `http_build_query`). Ignore `?refresh` from anonymous callers or rate-limit it (a per-day counter file in `app/cache/` is enough).

### SEC-07: HEIC uploads are handed to ImageMagick (untrusted-input surface)
- **Status 2026-07-18: shrunk by the SEC-02 fix.** [image-service.php:97](app/services/image-service.php#L97) → `convertHeicToPng()` [:338](app/services/image-service.php#L338) via `Imagick::readImageBlob()`. The last **anonymous** path to it (`iliana-photos` uploads) is now project-role-gated, so only authenticated, role-holding users can feed bytes to Imagick.
- **Impact:** MIME is validated by content first (`finfo`, SVG not allowed, so no SVG-XSS), but HEIC/HEIF bytes are then parsed by ImageMagick, which has a long history of parser CVEs. Remaining surface: authenticated users only.
- **Fix:** Keep Imagick patched and confine its delegates via `policy.xml` (disable every coder except the handful actually needed).

---

## LOW

### LOW-01: `iliana` "password" is client-side theater
**Rescoped by the SEC-02 fix (2026-07-18):** writes are now genuinely gated by `Auth::requireProjectRole('iliana', 'editor')`, so the client-side password ([views/iliana/script.js:1-7](views/iliana/script.js#L1-L7), both passwords as base64 in the source) is decoration in front of a real lock. Remaining: **reads are still public**, so anyone with the URL can view the photos and captions. If that matters, gate the GET branch behind the same project role and give the view a proper sign-in state; otherwise drop the fake password so it stops implying privacy the reads don't have.

### LOW-02: `google_sub VARCHAR(32)` may truncate
Unchanged: [app/models/auth-model.sql:7](app/models/auth-model.sql#L7). Google's `sub` is spec'd up to 255 chars (currently ~21 digits); the verifier doesn't cap it. Fix: `ALTER TABLE users MODIFY google_sub VARCHAR(255) DEFAULT NULL` (manually in phpMyAdmin, prod and local scratch DB) and update the model file in the same commit.

### LOW-03: `target="_blank"` without `rel="noopener"`
**Mostly fixed:** `index.html`'s external links now all carry `rel="noopener"`. Remaining: [components/project-card.js](components/project-card.js) (4 template links at [:27](components/project-card.js#L27), [:35](components/project-card.js#L35), [:43](components/project-card.js#L43), [:51](components/project-card.js#L51)) and [views/rocks/index.html:43](views/rocks/index.html#L43), which uses `<base target="_blank">` (`<base>` cannot carry `rel`, so either add `rel` per link or drop the `<base>`). Impact is low (modern browsers imply `noopener` for `_blank`).

### LOW-04: File-write endpoints have write races
**Partially fixed:** `tarok.php` now writes with `LOCK_EX` and `jeger` moved to the DB. Remaining: `writeTickers` ([stocks-controller.php:19](app/controllers/stocks-controller.php#L19)) and the tabs cache write ([tabs-proxy.php](app/proxys/tabs-proxy.php)) still do read-modify-`file_put_contents` without a lock. Copy `rocks-controller`'s temp-file + atomic `rename` pattern, or at minimum add `LOCK_EX` like tarok.

### LOW-05: Dead assignment in image upload
Unchanged: [images-controller.php:172](app/controllers/images-controller.php#L172) `$id = (int) Database::write()->lastInsertId();` is never used (the response is fetched by uuid). Remove it.

### LOW-06: Login/read paths use the write DB connection
Unchanged: e.g. [auth-controller.php:106](app/controllers/auth-controller.php#L106) does the initial user `SELECT` on `Database::write()`. Harmless functionally, but defeats the read/write split. Use `Database::read()` for pure reads.

### LOW-07: `stats-proxy.php` reads every file fully to count lines
**Still present** despite the 2026-07-18 rework (which added the versioned daily cache, dev-tooling exclusions, and `STATS_ROOT`/`STATS_CACHE` test seams): [stats-proxy.php:59](app/proxys/stats-proxy.php#L59) still does `count(file(...))`, loading each file into memory on a recompute any anonymous visitor can trigger once per day. Fix: stream-count with `fgets` in a loop; [tests/stats-proxy.test.php](tests/stats-proxy.test.php) already asserts exact per-extension counts, so the refactor is safely guarded.

### LOW-08: `assertSameOrigin()` short-circuits when `Origin` is absent
Unchanged and still deliberate: [auth.php:149-152](app/config/auth.php#L149-L152) returns early if no `Origin` header (curl/non-browser allowance); the JSON-content-type requirement is the real CSRF backstop. Noting it so it stays a conscious choice: if any gated endpoint ever accepts form-encoded bodies, this becomes a hole.

### LOW-09 (was SEC-04): No web-server hardening: dotfiles, `.env`, `.git`, `.sql` are unprotected
**Downgraded High → Low 2026-07-18, accepted risk (owner decision).** Rationale recorded from the owner: on prod, `.env` and `vendor/` live in the server root **outside** `public_html` (the SFTP deploy only pushes into `public_html`), so the production secrets are not servable; and the repository is intentionally **open source** on GitHub, so `.git` contents, `app/models/*.sql`, and CLAUDE.md are public anyway and serving them leaks nothing that is not already published. Remaining sliver (accepted): in dev, `app/.env` sits inside the document root and holds the production DB credentials, so `http://localhost/portfolio/app/.env` serves them in cleartext to anyone who can reach the dev machine's Apache (localhost/LAN). If that ever becomes a concern, the cheap fix stays the same: a `<FilesMatch "(^\.|\.(env)$)">` deny in the root `.htaccess` (do NOT blanket-deny `.md` or `.sql` site-wide; the blog reader fetches `posts/<slug>.md` client-side, and open-sourcing makes the wider denies pointless anyway), or move the dev `.env` outside the doc root to mirror prod.

**Sliver closed later the same day (2026-07-18):** the root `.htaccess` was merged with the server's real one (dotfile `FilesMatch` deny plus `app/config|models|vendor|cache` blocks, active in dev too; pretty-URL rules prod-only via a host-anchored skip) and untracked from git. Verified locally: `app/.env`, `app/config/*`, `app/models/*` all 403.

---

## IMPROVEMENTS (grouped, low urgency)

- **IMP-01: Copy-pasted controller helpers.** Still open and grew since the audit: `sendJson`/`sendError`/`readBody`/`sanitize` variants are now also in `contact.php`, `store.php` and the reworked `pricing-controller.php`. Extract to a shared `app/config/http.php` include, like `auth.php`/`database.php` already are.
- **IMP-02: CORS policy on mutating endpoints.** Resolved for every mutating endpoint: everything wired into the auth system (auth, admin, hub, images, list, plants, sourdough, jeger, recipes, workout, pricing, parlour, contact, store, and since 2026-07-18 stocks, rocks, iliana-photos, vrata, music) correctly omits `Access-Control-Allow-Origin`. Still sending `*`: only the read-only public proxies (apod, otd, stats, tabs, tarok), which is defensible.
- **IMP-03: Adopt encode-on-output everywhere** (see BUG-01, which is now spreading) and delete the write-time `htmlspecialchars` helpers so new controllers stop inheriting the bug.
- **IMP-04: Consider a front controller / router.** Every controller re-implements method/param dispatch, `SECURE_ACCESS`, headers, and error handling. A thin router would make it impossible to forget the auth include on a new endpoint, which is still the root cause of everything left in SEC-02/05.
- **IMP-05: Centralize upload validation.** Unchanged: `plants` and `iliana` still hand-roll their own `finfo` MIME checks instead of going through `ImageService` (which already validates). Route all uploads through `ImageService::prepareFromUpload`.
- **IMP-06: a11y/consistency pass.** The `index.html` `rel="noopener"` and blog gtranslate-embed items from the original entry are done; remaining is the `project-card.js` rel fix (LOW-03) and a `lang` attribute sweep.

---

## Fixed since the audit (removed from the list above)

Verified fixed on 2026-07-18 and removed:

- **SEC-02 (the last Critical: unauthenticated iliana-photos, stocks, rocks):** fixed 2026-07-18. `stocks` is `Auth::requireAdmin()` on every branch (single-owner tool; the cron reads the JSON file directly and is unaffected). `rocks` keeps GET/add/update/delete public but gates `clear` behind `Auth::requireAdmin()`. `iliana-photos` keeps reads public (see LOW-01) and gates every write behind `Auth::requireProjectRole('iliana', 'editor')`; `added_by` is now derived from the session user's display name (body values ignored, spoof-tested) and preserved on edit, with the model migrated `ENUM` → `VARCHAR(100)`. All three dropped `Access-Control-Allow-Origin: *` and send `Cache-Control: no-store`. Covered by [tests/stocks-controller.test.php](tests/stocks-controller.test.php), [tests/rocks-controller.test.php](tests/rocks-controller.test.php), [tests/iliana-photos-controller.test.php](tests/iliana-photos-controller.test.php) (51 checks). Frontends updated: stocks shows a sign-in wall, rocks no longer pretends a denied clear worked, iliana explains the sign-in requirement on write failures. **Prod deploy needs manual SQL:** the `ALTER TABLE iliana_photos MODIFY added_by VARCHAR(100) NOT NULL` and the `iliana` project INSERT (both in [app/models/iliana-photos-model.sql](app/models/iliana-photos-model.sql)), plus granting the two `editor` roles from the admin dashboard. The music write paths remain open, tracked as SEC-05.
- **presence-controller** (the original SEC-02 headline, intimate personal data exposed): the presence project was removed entirely on 2026-07-05 (view, controller, model, DB tables).
- **SEC-01 headline (pricing IDOR):** fixed by the 2026-07-17 pricing rework. Admin-only `GET ?id`/`GET ?all`/`PATCH`/`DELETE`, no more `*` CORS, raw IP replaced by a daily-salted `ip_hash` that is never returned to any client, all covered by `tests/pricing-controller.test.php`. Only the ungated `PUT` remains (rescoped as Medium SEC-01 above).
- **jeger** (was in SEC-02 and SEC-06): migrated to one JSON checklist row per user behind `Auth::requireLogin()`, upserted with `ON DUPLICATE KEY`; no shared state left to destroy, CORS header removed.
- **sourdough** (was in SEC-02): migrated to per-user starter + loaves behind `Auth::requireLogin()`, demo shape for signed-out visitors, CORS header removed.
- **plants writes** (adjacent to SEC-02): now `Auth::requireLogin()` with every write scoped `AND user_id = ?`, CORS header removed. (Its BLOB storage and sanitize-on-input remain: PERF-01, BUG-01.)
- **tarok write race** (was in LOW-04): now writes with `LOCK_EX`. (Its unbounded file count remains: SEC-06.)
- **`index.html` noopener** (part of LOW-03) and the **blog gtranslate embed** (part of IMP-06): both done.
- **SEC-05 (music write/delete/analysis endpoints open):** fixed 2026-07-18. Writes behind `Auth::requireProjectRole('music', 'editor')`, public reads untouched, wildcard CORS gone, analysis capped to one concurrent run via a stale-aware lock file. See the full SEC-05 entry above; covered by [tests/music-controller.test.php](tests/music-controller.test.php). Prod needs the `music` project `INSERT` from [app/models/music-model.sql](app/models/music-model.sql) plus an `editor` role grant, or saving chords from the editor will 401/403.
- **SEC-03 (vrata door on a GET with the key in the URL):** fixed 2026-07-18. POST-only, key in the JSON body only, same-origin + JSON-content-type CSRF backstops, per-IP rate limit on failed key attempts, optional session-role bypass via the new `vrata` project, no wildcard CORS. See the full SEC-03 entry above; covered by [tests/vrata.test.php](tests/vrata.test.php). LOW-04 note: the new attempts file writes with `LOCK_EX`.

### Notes on what was checked and found clean
- The auth core (`auth.php`, `google-auth-service.php`, `auth-controller.php`, `admin-controller.php`, `hub-controller.php`, `list-controller.php`) uses prepared statements throughout, hashes session/reset tokens with SHA-256, compares secrets with `hash_equals`, rate-limits password logins, and applies sensible CSRF backstops (JSON-only bodies + same-origin). No SQL injection was found in any controller (all dynamic SQL uses bound params; the only interpolated values, `LIMIT/OFFSET` and column-name lists, are integer-cast or from fixed allow-lists).
- Command execution in `music-controller.php` → `analyze_audio.py` is safe (`escapeshellarg`/`escapeshellcmd`, list-form `subprocess`, `LD_LIBRARY_PATH` stripped).
- Path traversal is correctly prevented in `ImageService::remove` (`realpath` + prefix check), `sanitizeFolder`, and `tarok.php`'s `sanitizeId`.
- Frontend rendering is largely XSS-safe: `list`, `iliana`, `music`, `botaniq` render server strings via `textContent`/`escapeHtml`/`esc`, and `account`'s `?redirect=` is validated to same-origin paths ([account/script.js:67](views/account/script.js#L67)).
- The controllers gated since the audit (pricing, jeger, sourdough, plants) plus contact/store follow the no-CORS-with-cookies rule and `Cache-Control: no-store` convention correctly.
