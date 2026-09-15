# Tanken: how it works, and what is left to do

A German fuel price page. Pick a place, see the filling stations around it cheapest first,
and find out which hour of the day prices actually fall.

Written 2026-09-15. Not deployed: this file is in the `exclude` list of
`.github/workflows/deploy.yml`. Commands and environment variables live in
[tools/tanken/README.md](../../tools/tanken/README.md); this file explains the moving
parts and tracks what is unfinished.

**Status in one line:** the code is built and tested against a fake API, but it has never
talked to the real Tankerkönig API, never run against the real archive, and never been
opened in a browser. Section 5 is the list.

---

## 1. The big picture

There are two completely separate data paths. They use different sources, different
licences and different timescales, and they never share a table.

```
PATH 1: LIVE PRICES (minutes old)

  visitor ──► views/tanken/script.js
                    │  GET ?action=stations&lat&lng&rad
                    ▼
            tanken-controller.php ──► Tanken service ──► Tankerkönig API
                    │                     │               (at most once a minute)
                    │                     ▼
                    └──── reads ──── MySQL: tanken_stations
                                            tanken_current_prices
                                            tanken_poll_state  ◄── the rate limit


PATH 2: STATISTICS (built once, by hand)

  Tankerkönig archive (20 GB git repo, on your machine)
                    │
                    ▼
          tools/tanken/build.py  ──►  views/tanken/hourly-stats.json  (committed)
                                                    │
  visitor ──► views/tanken/script.js ── fetch ──────┘
```

The browser never calls Tankerkönig. It only ever calls our own controller (Path 1) and
fetches a static JSON file (Path 2).

---

## 2. Path 1 walkthrough: what happens when someone looks up prices

Follow one visitor from click to screen.

### Step 1: they pick a place

The page offers two ways, both in `script.js`:

- **"Use my location"** asks the browser for coordinates. The browser prompts first.
- **The search box** sends the typed text to OpenStreetMap's Nominatim, restricted to
  Germany (`countrycodes=de`), and takes the first hit's coordinates.

There is no list of favourite stations anywhere. Which stations get shown is decided
entirely by where the visitor points, which is what the MTS-K terms require.

### Step 2: the page asks our server

```
GET /app/controllers/tanken-controller.php?action=stations&lat=52.52&lng=13.405&rad=5
```

The controller checks the input before anything costs money:

- non-numeric or missing coordinates are a `422`;
- coordinates outside Germany get an empty answer with `outsideCoverage: true` and **no
  API call**;
- a radius above 25 km is clamped to 25, because that is the API's ceiling.

### Step 3: do we already know this area?

`Tanken::discover()` first asks the database whether any station inside the search box was
looked at in the last 30 minutes (`TANKEN_DISCOVER_TTL`).

- **Yes:** skip the API entirely. Just bump `last_requested_at` on those stations so they
  stay in the polling rotation.
- **No:** this is a new area, so it needs one `list.php` call, which returns every station
  in the radius *and* their current prices in a single request.

That question is answered from the station rows themselves, which is why no table ever
needs to record where a visitor searched.

### Step 4: the lease, which is the rate limit

Before **any** outbound call, the service must win this:

```sql
UPDATE tanken_poll_state
   SET last_call_at = NOW(), leased_until = NOW() + INTERVAL 30 SECOND, calls_today = calls_today + 1
 WHERE id = 1
   AND last_call_at <= NOW() - INTERVAL 60 SECOND
   AND leased_until <= NOW()
   AND calls_today < 1440;
```

If the `UPDATE` changed a row, this request owns the call. If it changed nothing, somebody
else called within the last minute, so this request skips the API and serves what is in
the database.

Because the check and the stamp happen in one statement, two visitors arriving in the same
millisecond cannot both win: MySQL's row lock picks one. This is why there is no cron job
and none is needed. The test suite fires fifty requests and asserts the fake API saw
exactly one.

### Step 5: the rotation refreshes old prices

Every request also calls `Tanken::runIfDue()`. If the lease is free, it picks the **ten
stalest** stations that someone looked at in the last 24 hours and refreshes them with one
`prices.php` call (ten is the most ids that endpoint accepts).

The arithmetic that decides freshness:

| Tracked stations | Calls needed for a full round | Worst-case price age |
|---|---|---|
| 10 | 1 | about 1 minute |
| 100 (the cap) | 10 | about 10 minutes |
| 300 | 30 | about 30 minutes |

That is why `TANKEN_POOL_CAP` exists. The rotation only advances while people visit; an
idle page makes no calls, which is correct.

The poll runs **before** the database read, so the visitor whose request paid for the call
is the one who sees the new prices.

### Step 6: the response

```json
{
  "stations": [
    {
      "id": "…uuid…", "brand": "ARAL", "place": "Berlin", "dist": 1.91,
      "prices": {
        "e5":     { "price": 1.859, "status": "open",      "observedAt": "2026-09-14T18:48:21" },
        "e10":    { "price": 1.809, "status": "open",      "observedAt": "2026-09-14T18:48:21" },
        "diesel": { "price": null,  "status": "no prices", "observedAt": "2026-09-14T18:48:21" }
      }
    }
  ],
  "radius": 5,
  "lastOkAt": "2026-09-14T18:48:21",
  "degraded": false,
  "attribution": { "text": "Prices: MTS-K via Tankerkönig, CC BY 4.0", "url": "https://www.tankerkoenig.de" }
}
```

Every station in the radius comes back. Closed stations and stations that do not sell a
fuel are included with their status, never dropped.

### Step 7: the page renders it

`logic.js` holds every decision, and `script.js` only draws:

- `sortByPrice()` orders the list in three bands: **open with a price**, then **closed
  showing a last price**, then **no price**. Cheapest first within each band. A closed
  station can never sit above somewhere you can actually buy.
- `bestPrice()` picks the headline, skipping closed stations.
- `formatPrice()` writes `1,859 €`: decimal comma, tenth of a cent, non-breaking space.
- `relativeAge()` prints "4 min ago" beside each price, so an old reading never passes for
  a live one.

### When things go wrong

| What fails | What the visitor sees |
|---|---|
| Tankerkönig is down or says `ok: false` | The last cached prices with their **original** timestamps, plus a note that the last refresh did not go through. Never an error page. |
| No API key configured | Cached prices only. No call is attempted. |
| One station has a malformed id | That station is skipped; the rest are served. |
| Our own database is down | "Could not reach the price service" with a retry button. |

---

## 3. Path 2 walkthrough: how "cheapest around 20:00" is computed

This runs on your machine, by hand, perhaps once a month. It never runs on the server.

### The input

The Tankerkönig archive is a git repository with one CSV per day since June 2014. Each row
is **a price change**, not a price reading:

```
date,station_uuid,diesel,e5,e10,dieselchange,e5change,e10change
2024-06-03 07:05:00+02,aaa…,1.749,1.899,1.849,1,1,1
```

A price stays valid until the next change for the same station and fuel.

### Step 1: expand changes into an hourly series

For every station and fuel, `fill_day()` walks the day hour by hour and carries the last
known price forward. The last price of each day is kept in `carry`, so a station that did
not change its price until noon still has a 06:00 price from the night before.

Days are cut in **Europe/Berlin** local time. The spring daylight-saving day has 23 hours
(there is no 02:00) and the build knows that rather than inventing a reading.

### Step 2: normalize, which is the step that matters

Take one station on one day. Compute its mean price across the day, then express every
hour as a deviation from that mean:

```
hour     07:00   12:00   20:00        mean 1.800
price    1.860   1.800   1.740
deviation +0.06   0.00   -0.06
```

Without this, the result would be ruined by two things that have nothing to do with the
time of day: fuel cost about three times as much in 2022 as in 2016, and an autobahn
station is always dearer than a suburban one. After normalizing, a station at 1,50 € and one
at 2,10 € contribute the same shape. Station-days with fewer than 20 known hours are
dropped, since their mean would be unreliable.

### Step 3: aggregate with medians

Every deviation is counted into a bucket for its `(fuel, weekday, hour)`, giving 168
buckets per fuel, plus a simpler `(fuel, hour)` set of 24.

Medians are read from a **histogram** (0.1 cent bins) rather than by sorting a list. A
decade of the archive is around a billion hourly values, which will not fit in memory; a
histogram is the same fixed size whether you process one month or eleven years.

### Step 4: the sanity gate

German prices follow a known daily sawtooth: dear in the morning, falling through the day,
dipping in the evening. Before writing anything, `check_sawtooth()` requires every fuel to
have mornings above zero, evenings below zero, and a swing of at least a cent.

If the shape is missing the pipeline is wrong, and the build refuses to write. This matters
because a broken pipeline still produces a smooth, believable curve.

### Step 5: the page reads the file

`views/tanken/hourly-stats.json` is committed. The page fetches it, draws the curve as
inline SVG and prints the cheapest and dearest hour. While the file is still the empty
placeholder, the panel says the curve is not built yet instead of drawing a flat line.

---

## 4. The rules that must not be broken

These are conditions of using somebody else's data, not style preferences.

1. **No monetisation on this page, ever.** The archive is CC BY-NC-SA 4.0. No ads, no paid
   tier, no sponsorship. If that changes, the statistics panel has to go.
2. **Both licence credits stay beside their data.** CC BY 4.0 under the price list, BY-NC-SA
   4.0 under the chart. A test fails if either is removed.
3. **Never call the API without winning the lease.** One request a minute; keys get revoked
   for harvesting. Do not add retries.
4. **Never filter results the visitor did not ask to filter.** Sort them, never drop them.
5. **Never commit the API key.** It lives in `app/.env`, which is gitignored and excluded
   from deploy.
6. **Never store where a visitor searched.** The privacy page promises it.

---

## 5. To do

### Before it works in production (blocking)

- [ ] **Get a Tankerkönig API key** at <https://creativecommons.tankerkoenig.de>.
- [ ] **Apply `app/models/tanken-model.sql`** in phpMyAdmin on production. Without it every
      lookup returns a 500.
- [ ] **Add `TANKERKOENIG_API_KEY=…` to the production `app/.env`** over SFTP. Without it the
      page loads but never shows a station.
- [ ] **Apply the SQL locally too**, and add the key to the local `app/.env`, to try it
      on XAMPP. (Remember the local `.env` points at the production database; see the
      root `CLAUDE.md`.)

### Verification nobody has done yet

- [ ] **First call against the real API.** Everything so far ran against
      `tests/fixtures/tankerkoenig-stub.php`, which was written from the API documentation.
      Check a real `list.php` and `prices.php` response against what the service expects:
      field names, `isOpen` on list, `status` on prices, and the shape of an error.
- [ ] **Open the page in a real browser.** Only the HTML and the controller were checked
      with `curl`. Still to see: layout at phone width, the location prompt, the search box,
      fuel tabs, the station list, and the empty and error states.
- [ ] **Watch the lease under real use.** Reload hard a few times and check
      `tanken_poll_state.last_call_at` moves at most once a minute and `calls_today`
      climbs slowly.
- [ ] **Read the privacy page paragraph** added under "Who else sees your data" and make
      sure you are happy with the wording.

### Statistics panel

- [ ] **Request archive access** by emailing <info@tankerkoenig.de> (or via
      <https://onboarding.tankerkoenig.de>).
- [ ] **Clone the archive** somewhere with about 20 GB free, outside this repository.
- [ ] **Try one month first:** `--from=2026-08 --to=2026-08`. The CSV format was taken from
      third-party documentation; the build stops loudly if the columns differ, but the
      timestamp format (`2024-06-03 07:05:00+02`) has not been seen in a real file yet.
      Runtime has not been measured either.
- [ ] **Run the chosen window**, confirm it passes the sanity gate, and commit
      `views/tanken/hourly-stats.json`.
- [ ] **Look at the chart with real data.** It has only been unit tested, never drawn.

### Known bugs

- [ ] **A brand-new area can say "No stations" when it means "not yet".** If two people
      search two different, never-seen areas inside the same minute, the second one loses
      the lease, gets an empty list, and the page tells them *"No stations reported inside
      this radius. Try a wider one."* That is false. The controller should pass the
      `rate-limited` reason through, and the page should say it is fetching and retry after
      the minute.
- [ ] **Widening the radius does not find new stations for 30 minutes.** Search at 2 km,
      then drag the slider to 25 km: the service sees recently looked-at stations inside the
      bigger box, decides the area is known, and skips `list.php`. The wider search only
      shows stations already in the database. Discovery needs to remember the radius it
      covered, not just that it has seen something nearby.

### Housekeeping the repo conventions expect

- [ ] Add `tanken-poll.php` to [app/scripts/CLAUDE.md](../../app/scripts/CLAUDE.md).
- [ ] Add `tanken-controller.test.php` and `tanken-build.test.py` to
      [tests/CLAUDE.md](../../tests/CLAUDE.md).
- [ ] `node --test tests/` fails on this machine's Node 22 before loading any test (it
      cannot resolve the directory). Unrelated to Tanken; it fails the same way in an empty
      project. Use `node --test "tests/**/*.test.mjs"` locally. CI runs Node 20 and is fine.

### Ideas, not commitments

- **Our own price history.** Keep every polled price in a history table and run the same
  statistics pipeline over it. That data is CC BY 4.0 with no non-commercial clause, so it
  would free the page from the NC restriction, and it would reflect the stations people
  here actually use.
- **A proper share image** instead of the default `og-default.png`.
- **Prerender the daily curve** into the HTML so search engines see the finding, not just
  the heading.
- **"Best time today"** combining the live price with the typical curve: if it is 07:00
  and the evening is usually 6 cents cheaper, say so.

---

## 6. Where everything lives

| File | What it is |
|---|---|
| `views/tanken/index.html`, `style.css`, `script.js` | The page |
| `views/tanken/logic.js` | Every decision the page makes, DOM-free and tested |
| `views/tanken/hourly-stats.json` | Statistics output (placeholder for now) |
| `app/controllers/tanken-controller.php` | The only endpoint the page calls |
| `app/services/tanken-service.php` | The lease, both API calls, all database writes |
| `app/models/tanken-model.sql` | Schema, applied by hand |
| `app/scripts/tanken-poll.php` | Manual or future-cron entry to the rotation |
| `tools/tanken/build.py` | The offline statistics pipeline |
| `tools/tanken/README.md` | Commands, environment variables, licence detail |
| `tests/tanken-logic.test.mjs` | Page logic, the licence credits, the shared constants |
| `tests/tanken-controller.test.php` | The rate limit, no filtering, failure behaviour |
| `tests/tanken-build.test.py` | Forward fill, daylight saving, normalization |
| `tests/fixtures/tankerkoenig-stub.php` | The fake API the PHP tests use |
