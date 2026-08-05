# app/scripts

Standalone cron/CLI scripts. These run **via cron or by hand, not from PHP**, with one
exception noted at the bottom.

## The LJSE tracker: two entry points, and cron calls the Python one

- **`stocks-sync.php`** is the PHP entry that does the work: fetch plus alert digest via
  [app/services/stocks-sync-service.php](../services/stocks-sync-service.php).
  `--backfill=DAYS` seeds chart history, run it once after applying the model.
- **`stocks-sync.py` is what cron actually calls.**

The wrapper exists because the shared host has **no shell**. Cron's `PATH` is
`/usr/bin:/bin`, where a `php82` installed under `/usr/local` is invisible, which is
exactly what broke the original hardcoded `/usr/bin/php82` cron line. So the wrapper finds
a working PHP binary itself, runs the sync, and appends a report to **`stocks-sync.log` in
the site root** so a failed run can be read over SFTP or in a browser.

- Good runs add one line.
- Failures add a block: resolved config paths, every PHP binary on the host with its
  version and extensions, whether ljse.si and Telegram answer from there, and the sync's
  own output. **All `.env` values are scrubbed out.** The report lands in the web root, so
  that redaction is a security property, not a nicety, keep it that way and keep
  [tests/stocks-sync-py.test.py](../../tests/stocks-sync-py.test.py) passing.
- It pings Telegram once a day when the sync is down.
- `--diagnose` writes the report without syncing.
- Exit codes: **0** synced, **1** sync failed, **2** no usable PHP.

**Gotcha:** it runs PHP with `-d variables_order=EGPCS` so the `DB_*` / `LJSE_BASE_URL` /
`TELEGRAM_*` env seams reach `$_ENV`. Cron has none of them set, so prod still loads
`app/.env` exactly as before; the seams exist for the test suites.

PHP binary choice: newest 8+ with `pdo_mysql` wins, 7.x is never used.

## Telegram

`notify.py` sends an ad-hoc Telegram message from the command line, with `telegram.py` as
its helper.

## The exception: analyze_audio.py

`analyze_audio.py` (MP3 musical analysis for [views/music](../../views/music/), numpy +
ffmpeg) **IS** invoked from PHP, by `music-controller.php` via `exec()`.

**XAMPP `exec()` gotcha:** XAMPP's Apache exports `LD_LIBRARY_PATH=/opt/lampp/lib`, whose
bundled (ancient) libstdc++ breaks system binaries launched from PHP (`ffmpeg` fails with
`CXXABI` / `GLIBCXX` version errors). Any `exec()` of a system tool must strip it, e.g.
`exec('env -u LD_LIBRARY_PATH ...')`. `analyze_audio.py` strips it again before spawning
ffmpeg.
