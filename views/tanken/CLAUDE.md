# views/tanken

German fuel prices. Public portfolio view. Operator instructions (API key, archive
access, running the jobs) are in [tools/tanken/README.md](../../tools/tanken/README.md);
this file is only the things that would bite you.

## This page may never be monetised

The statistics panel is derived from the Tankerkönig historical archive, which is
**CC BY-NC-SA 4.0, non-commercial only**. No ads, no paid tier, no sponsored placement,
nothing sold, on this page. That is a licence condition, not a preference.

The live prices are a *different* licence (CC BY 4.0) and carry a *different* credit. Both
credits are printed next to the data each one covers, and
[tests/tanken-logic.test.mjs](../../tests/tanken-logic.test.mjs) fails if either
disappears. Do not consolidate them into a colophon, and do not move them into
`<site-footer>`.

## The rate limit is a database row, not a timer

Tankerkönig allows **one request per minute** and revokes keys that harvest. Production has
no cron, so the poll rides the page load. What stops a traffic spike becoming a burst is
`tanken_poll_state`: a request may call the API only if it wins the conditional `UPDATE` in
`Tanken::claimLease()`. Fifty simultaneous visitors produce one call, and
[tests/tanken-controller.test.php](../../tests/tanken-controller.test.php) asserts exactly
that.

**There is no code path that calls the API without a lease. Do not add one**, and do not
"helpfully" retry a failed call: the failure has already spent the minute.

Two consequences that look like bugs and are not:

- A page with no visitors makes no API calls.
- Freshness is arithmetic, not a setting. `prices.php` takes ten ids and the quota is one
  call a minute, so `TANKEN_POOL_CAP` (100) stations come round in about ten minutes.
  Raising the cap makes prices *older*, not more plentiful.

## Nothing may be filtered out of the results

MTS-K's terms forbid narrowing results in ways the user did not ask for. A closed station
and one that does not sell the selected fuel both stay in the list; they sort below the
places you can actually buy (`sortByPrice` bands them) but are never dropped. The only
thing the service discards is a station id that is not a valid UUID, because it could not
be sent to `prices.php` anyway.

## No visitor coordinates are stored, anywhere

A lookup bumps `last_requested_at` on the stations it returned and writes nothing else. No
table records where someone searched, and the privacy page says so. Answering "do we
already know this area?" from the station rows themselves, rather than from a cache of
searched locations, is why that is possible. Keep it that way.

## The statistics are built offline and committed

`views/tanken/hourly-stats.json` comes from `tools/tanken/build.py` run by hand against a
20 GB archive clone. It is committed because `app/data/` is gitignored. The page reads it
statically; there is no controller branch for statistics and no table.

The build refuses to write unless the output has the German sawtooth (dear in the morning,
falling through the day). A broken pipeline still produces a smooth plausible curve, so
that gate is the only thing between a bug and a confident wrong answer.
