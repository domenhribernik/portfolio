# Tanken: German fuel prices

Operator notes for [views/tanken](../../views/tanken/). Lives under `tools/`, which is
excluded from the deploy, so none of this is served publicly.

The feature has two data paths and they never meet. Path 1 is live prices, polled
server-side and cached in MySQL. Path 2 is the statistics panel, computed offline from a
historical archive and shipped as a static JSON file. Different sources, different
licences, different cadences.

---

## Path 1: live prices

### 1. Get an API key

Register at <https://creativecommons.tankerkoenig.de>. The key is free and arrives as a
UUID. Mineral oil companies and station operators are barred from the API, which is worth
knowing if you ever hand this to someone else.

### 2. Put it in the environment, never in the repo

Add one line to `app/.env`:

```
TANKERKOENIG_API_KEY=your-uuid-here
```

`app/.env` is gitignored and is in the deploy exclude list, so it is never committed and
never uploaded by CI. Put it on production by hand over SFTP.

The service reads it through `$_ENV[...] ?? getenv(...)`, so the test suites can inject a
fake one. Nothing else in the codebase touches the key, and the controller is tested to
prove it never reaches a response body.

### 3. Apply the schema

Run [`app/models/tanken-model.sql`](../../app/models/tanken-model.sql) in phpMyAdmin. As
everywhere in this repo, SQL is applied by hand; nothing runs migrations from code. The
file is safe to re-run.

Without it every station lookup returns a 500.

### 4. There is nothing to schedule

Production has no cron (see `PRODUCT.md`), so the poll rides the page load. The rate limit
is not a timer, it is a row: `tanken_poll_state` hands out the right to make a call, and a
request only calls the API if it wins a conditional `UPDATE` against it. Fifty visitors
arriving at once produce one request; the rest read the cache.

Consequences worth knowing:

- **A page with no visitors makes no API calls.** That is correct, not a bug: there is
  nobody to serve.
- **The freshness ceiling is arithmetic.** `prices.php` takes ten station ids and the
  quota is one request a minute, so a hundred tracked stations come fully round in about
  ten minutes. `TANKEN_POOL_CAP` is what holds that ratio. Raising it makes prices older,
  not more plentiful.
- **A station stops being polled 24 hours after the last person looked at it**
  (`TANKEN_TRACK_TTL_HOURS`), so the pool follows actual interest.

To drive it by hand:

```bash
/opt/lampp/bin/php app/scripts/tanken-poll.php            # one pass, up to 10 stations
/opt/lampp/bin/php app/scripts/tanken-poll.php --ticks=6  # six passes, a minute apart
```

If a scheduler ever exists, the crontab line is in the script's docblock. It would not
change behaviour, only who triggers it.

### Environment seams

| Variable | Default | What it does |
|---|---|---|
| `TANKERKOENIG_API_KEY` | none | Required. With it unset, no call is ever made and the page serves cache. |
| `TANKERKOENIG_BASE_URL` | `https://creativecommons.tankerkoenig.de` | Pointed at a stub by the test suite. |
| `TANKEN_POLL_INTERVAL` | `60` | Seconds between calls. Values below 60 are ignored: that is the quota. |
| `TANKEN_POOL_CAP` | `100` | Stations kept in the rotation. |
| `TANKEN_TRACK_TTL_HOURS` | `24` | How long a looked-up station stays in the rotation. |
| `TANKEN_DISCOVER_TTL` | `1800` | Seconds before an area is re-discovered with `list.php`. |

---

## Path 2: the statistics archive

### 1. Ask for access

The historical archive is not public. Email <info@tankerkoenig.de> (or apply via
<https://onboarding.tankerkoenig.de>) and ask for access to the price history repository.
They enable your account on their self-hosted git.

### 2. Clone it

```bash
git clone https://tankerkoenig@dev.azure.com/tankerkoenig/tankerkoenig-data/_git/tankerkoenig-data
```

**It is about 20 GB unpacked.** Clone it somewhere with room, outside this repo. `git pull`
keeps it current; a new day's file is pushed every night.

Layout is `prices/YYYY/MM/YYYY-MM-DD-prices.csv`, one row per price change, columns
`date, station_uuid, diesel, e5, e10, dieselchange, e5change, e10change`.

### 3. Build the statistics

```bash
python3 tools/tanken/build.py --archive=/path/to/tankerkoenig-data --from=2024-09 --to=2026-08
```

Stdlib only, no dependencies to install. It streams the CSVs, so memory stays flat however
many years you ask for. Runtime has not been measured against the real archive yet; start
with a single month (`--from=2026-08 --to=2026-08`) to get a feel for it before asking for
years.

Output is [`views/tanken/hourly-stats.json`](../../views/tanken/hourly-stats.json), about
100 KB, and it is committed. That is the only thing the website reads: the archive itself
never goes near production and never enters the database.

Useful flags:

- `--from` / `--to` limit the window. Two years is plenty for a stable median; the full
  history back to `2014-06` mainly adds sample count, because the normalization already
  removes the long-term oil price.
- `--check` rebuilds and diffs against the committed file without writing, which is how
  you confirm a rebuild is reproducible.
- `--force` writes even when the sanity gate fails. You almost certainly do not want it.

### What the pipeline does, and the one thing that would silently ruin it

1. Streams the change events and forward-fills them into an hourly series per station and
   fuel, carrying the last price across midnight.
2. **Normalizes each station-day against its own mean.** This is the step that matters.
   Fuel cost roughly three times as much in 2022 as in 2016, and an autobahn station is
   dearer than a suburban one; without this the output would be a chart of the oil market
   with the daily pattern buried in it.
3. Takes the median deviation by hour of day, weekday and fuel. Medians come from a
   histogram rather than a list of samples, because a decade of the archive is on the
   order of a billion observations and cannot be sorted in memory.
4. Refuses to write unless the result has the German sawtooth: dear in the morning,
   falling through the day, dipping in the evening. A wrong pipeline still produces a
   smooth plausible curve, so the shape check is the only thing standing between a bug and
   a confident wrong answer on the page.

All aggregation is in **Europe/Berlin** local time. Cutting days by UTC would misplace
midnight for half the year and put changes on the wrong day during DST.

---

## Licences, which are implemented rather than noted

Two different licences, and the page states both next to the data each one covers.

- **Live prices are CC BY 4.0.** Attribution with a link to tankerkoenig.de is required
  wherever prices are shown. It is printed under the station list and also travels in the
  API payload.
- **The historical archive is CC BY-NC-SA 4.0, non-commercial only.** This is a real
  constraint on the whole page, not a footnote: no ads, no paid tier, no sponsored
  placement, nothing sold. If that ever changes, the statistics panel has to come out.
  ShareAlike also applies to derivative datasets, so `hourly-stats.json` carries the
  licence in the file itself.

`tests/tanken-logic.test.mjs` fails if either credit disappears from the page.

---

## Tests

```bash
node --test tests/                                    # logic, formatting, the licence credits
/opt/lampp/bin/php tests/tanken-controller.test.php   # the rate limit, clamping, no filtering
python3 tests/tanken-build.test.py                    # forward fill, DST, normalization
```

Only the `.mjs` suites run in CI. The PHP suite needs the local scratch DB and never
touches the real API: a stub stands in for it and logs every call, which is how "fifty
visitors, one request" is an assertion rather than a claim.
