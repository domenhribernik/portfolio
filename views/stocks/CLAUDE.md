# views/stocks (Tečajnica)

Slovenian-language Ljubljana Stock Exchange portfolio tracker covering every listed share
plus the ETFs, SLOTR included. Unlisted private tool: never register it in
`components/project-data.js`, `index.html`, or the navbar.

The whole UI is Slovenian. Dates follow the site-wide day-first `dd.mm.llll` convention,
and this view owns the reference implementation of it (see below).

## Data flow

Market data syncs from ljse.si's public JSON into the `stocks_*` tables by
[app/services/stocks-sync-service.php](../../app/services/stocks-sync-service.php),
which also evaluates per-user alert rules and sends **one Slovenian Telegram digest per
market day**. Two triggers:

- **Cron** calls [app/scripts/stocks-sync.py](../../app/scripts/stocks-sync.py), not the
  PHP entry directly. See [app/scripts/CLAUDE.md](../../app/scripts/CLAUDE.md) for why,
  and for the `stocks-sync.log` report it writes into the site root.
- **The page** triggers it lazily via `?action=refresh`, behind a TTL guard.

## Authorization

[app/controllers/stocks-controller.php](../../app/controllers/stocks-controller.php)
gates **every** branch with `Auth::requireProjectRole('stocks')`. Any role passes (e.g.
`investor`); admins pass implicitly. Transactions and alerts are per-user rows.

## The dividend calendar

Shared, not per-user. The 2026 LJSE payout dates ship **hardcoded as idempotent seed
rows** in [stocks-model.sql](../../app/models/stocks-model.sql). `ex_date` holds the
Slovenian *presečni dan*. Accumulating ETFs pay nothing, so they have no rows at all,
that is deliberate, not missing data.

## logic.js

The DOM-free brain: sl-SI formatting, FIFO holdings, dividend-calendar math, chart
geometry. Tested by [tests/stocks-logic.test.mjs](../../tests/stocks-logic.test.mjs).

`parseDateSl()` / `toDateSl()` here are the **site-wide reference pair** for day-first
date entry (root CLAUDE.md, "Frontend: Dates"). `parseDateSl` accepts `dd.mm.yyyy` with
`.`, `/` or `-` separators and stray spaces, a bare `ddmmyyyy` digit run for numeric
keypads, and a pasted ISO `yyyy-mm-dd`. It **rejects** impossible days (`31.02.2026`)
rather than rolling them over, returning ISO or `null`.

The page has **no tax section** (removed by request), but the tested capital-gains-ladder
helpers remain in `logic.js` should it ever return. Don't delete them as dead code.

## Tests

- [tests/stocks-controller.test.php](../../tests/stocks-controller.test.php): the gate on
  every branch, overview payload, history, per-user CRUD, dividend calendar.
- [tests/stocks-sync.test.php](../../tests/stocks-sync.test.php): the sync + alert engine
  against a fake ljse.si.
- [tests/stocks-sync-py.test.py](../../tests/stocks-sync-py.test.py): the cron wrapper.
