# tests

Zero-dependency suites. No npm packages, no framework, keeping the repo's no-build-system
rule. The root `package.json` is **only** a `"type": "module"` marker so node parses `.js`
ES modules; never add dependencies to it.

```bash
node --test tests/                              # all JS unit suites
/opt/lampp/bin/php tests/<name>.test.php        # one PHP integration suite
python3 tests/stocks-sync-py.test.py            # the cron wrapper
```

On Windows the bare directory form fails, use `node --test "tests/**/*.test.mjs"`, and run
the PHP suites with `C:\xampp\php\php.exe`. They spawn whatever interpreter runs them.

## Conventions that transfer to new suites

- **Name browser-imported modules `.js`, not `.mjs`.** Apache serves `.mjs` without a MIME
  type and browsers block it. Test files themselves are `.test.mjs` (never loaded by a
  browser).
- **Extract before you test.** When a view's script grows non-trivial decision logic, pull
  it into a DOM-free `logic.js` the page imports, and test that here, rather than leaving
  it tangled in DOM code.
- **A classic script is testable too.** `back-link.test.mjs` cannot import
  `components/back-link.js` (no exports, loaded with a bare `<script src>`), so it runs the
  real file in a `node:vm` context against stub `document` / `history` / `location` globals
  and drives the listeners it registered. Reach for this only when a file genuinely cannot
  be a module; `logic.js` extraction is still the first answer.
- **The prod-DB guard.** PHP suites that need a database boot a PHP built-in server with
  `DB_*` env overrides pointing at the LOCAL scratch DB (`127.0.0.1` / `portfolio`). Those
  overrides make `database.php` skip `app/.env`, which points at the **remote production
  database**. This is the single most important thing to preserve when writing a new PHP
  suite: without it, a test run writes to prod.
- **Fixture users.** Suites with the guard require the seeded `admin@test.local` and
  `guest@test.local` users with their known session tokens in the local DB.
- **Clean up after yourself.** Teardown deletes only what the run created, usually via an
  id baseline taken at setup, so a scratch DB with real data survives a run.

## PHP integration suites

| Suite | Covers | Non-obvious setup |
|---|---|---|
| `dashboard-controller.test.php` | Shelf semantics (picked AND permitted, dormant rows), `?shelf=1` add/remove, `?manage=1` picker, `is_default` seeding, `PUT ?layout=1` (temp-id reconciliation via `created`, cross-user folder refs rejected 400, empty-folder dissolve vs. survival with a dormant member) | Setup migrates/creates the `dashboard_*` schema idempotently, RENAMEing from the old `hub_*` tables if present, so it runs against a fresh, pre-rework, or migrated scratch DB. Seeding is called in-process, the Google signup flow cannot run without a real ID token |
| `admin-roles.test.php` | The "All users" bulk grant (`user_id: "all"`): active users only, held roles never overwritten, `granted` count, guards | |
| `stocks-controller.test.php` | The `requireProjectRole('stocks')` gate on every branch, overview payload, history, per-user CRUD with cross-user 404s, dividend calendar | Quote assertions use throwaway TSTX/TSTY/TSTZ instruments, so real synced rows never break it |
| `stocks-sync.test.php` | Price upserts and idempotence, new-listing discovery, segment filtering, the once-per-market-day alert throttle (`last_fired_date`), staleness TTL, graceful failure, backfill | A **second** built-in server runs `fixtures/ljse-stub.php`, a fake ljse.si + Telegram driven by scenario JSON the suite writes. A missing scenario file doubles as the exchange-down case. Seams: `LJSE_BASE_URL`, `TELEGRAM_API_BASE`, `STOCKS_SYNC_TTL` |
| `pricing-controller.test.php` | Public POST create, IP privacy (stores only `ip_hash`, never returned), admin-gated list and hard DELETE | id-baseline teardown |
| `contact.test.php` | Accept+persist, per-field 422s, over-length caps, 405/400 guards, honeypot silent-drop | Leaves `TELEGRAM_*` unset, making the alert a no-op. Creates `contact_messages` if absent |
| `rocks-controller.test.php` | GET and per-rock actions stay public, destructive `clear` is admin-gated, no wildcard CORS | Backs up and restores `app/data/rocks.json` |
| `iliana-photos-controller.test.php` | Public reads, writes gated by `requireProjectRole('iliana', 'editor')`, `added_by` derived from the session (body values ignored, spoof-tested) | Real multipart upload through `ImageService`, **needs GD**; asserts the file appears on and disappears from disk |
| `music-controller.test.php` | Public reads, writes gated by `requireProjectRole('music', 'editor')`, analysis concurrency lock (fresh → 429, stale ignored) | Seam `MUSIC_ANALYSIS_LOCK`. Cases stop at the gate/lock/validation, so no Python or ffmpeg ever runs |
| `vrata.test.php` | The SEC-03 contract: POST-only (bare GET → 405), key from the JSON body only (URL key ignored), same-origin + content-type backstops, per-IP rate limiting, session-role bypass, happy-path unlock/stream | A **second** server runs `fixtures/tuya-stub.php`, a fake Tuya that logs every call, with `TUYA_BASE_URL` pointed at it, so no real door is touched and denied requests can be asserted to reach Tuya **zero** times. Seams: `VRATA_MAX_ATTEMPTS`, `VRATA_ATTEMPT_WINDOW`, `VRATA_ATTEMPTS_FILE` |
| `workout-controller.test.php` | Per-user rows, soft-delete reads, type immutability | |
| `beseda-controller.test.php` | The streak merge (re-upload is idempotent, a merge adds rather than replaces), `requireLogin` on both verbs, day validation (junk skipped without failing the request, today+1 allowed, far future and ancient dropped), cross-user isolation | Creates `beseda_activity` if absent. No project row or role: the feature is open to anyone, so there is no gate to test |
| `flowers-share.test.php` | Save/load/validation/pruning of the share endpoint | **No database.** Boots against the repo root, unlinks everything it created in `app/cache/flowers/` |
| `download.test.php` | Graceful 503s, health booleans, URL validation, ffmpeg fail-fast, full prepare/file/cleanup lifecycle, python3 fallback, per-host cache cap | **No network, no yt-dlp, no ffmpeg, no DB.** Boots once per host flavor with `YTDLP_BIN` / `FFMPEG_BIN` / `DOWNLOAD_CACHE_MAX_MB` injected: dead paths, `/bin/false`, generated shell and python stubs, a `disable_functions=exec` boot |
| `stats-proxy.test.php` | Exact per-extension counting, dev-tooling exclusions, same-day cache, the version stamp that busts it | **No database.** `STATS_ROOT` / `STATS_CACHE` point at a generated fixture tree; the proxy reads them via `getenv()` for exactly this reason |
| `battleship-controller.test.php` | The two rules the game rests on: A FLEET IS A SECRET (the raw bytes of every payload are grepped for the other fleet, during placement, mid battle and after the verdict) and THE SERVER OWNS BOTH PLOTS (a body reporting its own hits, bank, plot and outcome is read straight past). Then the unlock ladder, sonar privacy, area fire not surveying, buoys, repositioning, the verdict and rematch, seat reclaim, abandonment | Port **8963**. Applies `battleship-model.sql` itself. `arm()` forces a seat's salvage and scuttles its own hulls, because most tools are gated on your own wrecks and a legitimately reached test state would take forty turns to set up. Reclaim is tested by backdating `last_seen` rather than sleeping |

## Python

`beseda-build.test.py` unit-tests the content pipeline `tools/beseda/build.py`: the
orthography fold (Wiktionary stores Slovene participles in a pronunciation spelling, and
folding it wrong silently strips the gloss off every past tense in the corpus), lookup
precedence when one spelling is several words, and the append-only merges that stop a
rebuild from re-dating a word someone already saw. Stdlib `unittest`, no network and no
large fixtures. The generated output is checked separately by `beseda-data.test.mjs`.

`stocks-sync-py.test.py` unit-tests the cron wrapper `app/scripts/stocks-sync.py`: secret
scrubbing (the report lands in the web root, so redaction is a **security property**), PHP
binary choice (newest 8+ with `pdo_mysql` wins, 7.x never), and log trimming. Stdlib
`unittest`, no dependencies, no network, no DB. Sync *behaviour* belongs to
`stocks-sync.test.php` instead.

### bearing

`bearing-logic.test.mjs` holds the instrument. Two tests are the point of the
suite: bracketing at half power must beat naive peak-reading by 2x, and a
badly set gate must be worse than not bracketing at all. If either stops being
true the instrument has stopped being a skill and is back to being a dice roll.
Two more guard the SNR gate, without which the loudest noise sample counts as a
lobe and the instrument reports a confident bearing off hiss. It also greps the
PHP for the constants that exist twice, in two homes: the valley's own
dimensions are in `app/controllers/bearing/valley.php`, everything else in
`bearing-controller.php`.

`bearing-sim.test.php` is the balance suite, and it holds the chain the whole
game rests on: bracket well, get a tight fix, see the animal's shape, predict
where she goes. It runs the real movement model over hundreds of seeds and plays
the intercept, measuring how far the call landed in metres. Two properties must
hold: **a night of half-power brackets lands more intercepts than the same night
of naive peak reads** (the instrument feeds the game), and **reading the shape
beats extrapolating in a straight line** (the behaviour profiles earn their
place). It also checks nothing walks off the plate, nothing freezes, and the
generator still makes ridges worth having. **No database and no server**: it
requires the two pure modules under `app/controllers/bearing/` and calls straight
into them, which is why neither may gain a side effect on include.

`bearing-controller.test.php` (port **8964**) holds the room rules: AN ANIMAL'S
SECRETS (the raw response bytes are searched for every collar's true cell, its
hidden profile, its den and its track, during the night and after it), A FORGED
COMMIT CHANGES NOTHING, and AN INTERCEPT NEEDS TWO SEATS (a call one player makes
and seconds alone must not be able to score, however good the guess). It also
runs a whole night to dawn. Note the deliberate non-secret: a sweep returns the
full 360-sample trace, because reading it is the game and there is no opponent to
cheat against.
