# Stocks Watcher

Cron-driven Python script that fetches prices for tickers in `app/cache/stocks.json`,
logs every run to `app/cache/stocks-history.jsonl`, and sends a Telegram message when
any ticker moves at least ±2% since the previous check.

Stdlib only — no `pip install` required.

## Files

- `check_stocks.py` — entry point, called by cron.
- `yahoo.py` — fetches one ticker from `query1.finance.yahoo.com`.
- `telegram.py` — POSTs to the Telegram Bot API.

Side-effect files (auto-created under `app/cache/`):

- `stocks-last.json` — last seen price per ticker, used to compute % change.
- `stocks-history.jsonl` — append-only time series (one JSON object per line).
- `stocks-watcher.log` — cron stdout/stderr (path set by the cron line below).

## One-time setup — Telegram bot

1. Open Telegram, message `@BotFather`, send `/newbot`. Pick a name and a username.
   BotFather replies with a token like `123456:ABC-DEF...`. That's `TELEGRAM_BOT_TOKEN`.
2. Open a chat with your new bot and send it any message (e.g. `hi`). This is required
   so Telegram has a chat to surface in step 3.
3. In a browser, open:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
   Find `result[0].message.chat.id` in the JSON — that's `TELEGRAM_CHAT_ID`.
4. Add both to the project-root `.env` file (same one `app/proxys/vrata.php` reads):
   ```
   TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
   TELEGRAM_CHAT_ID=987654321
   ```

If the credentials are missing, the script still runs and still logs — it just skips
the Telegram step and prints a warning to stderr.

## Manual run (testing)

From the repo root:

```bash
python3 app/scripts/check_stocks.py
```

Expected stdout (one line per ticker):

```
AAPL      189.43  +0.42%
TSLA      201.10    (new)
```

`(new)` means this is the first time we've seen the ticker, so no % change is computed yet.

## Cron — shared hosting

Edit user crontab on the server with `crontab -e`, add:

```cron
# Stocks watcher — every 15 min, weekdays, covers NYSE/NASDAQ hours in CET year-round
*/15 14-22 * * 1-5 /usr/bin/python3 /usr/home/meuhdy/app/scripts/check_stocks.py >> /usr/home/meuhdy/app/cache/stocks-watcher.log 2>&1
```

Confirm the python3 path first with `which python3` on the host — adjust if it differs.

## Verification checklist

1. Local dry run with two real tickers in `stocks.json` → confirm `stocks-history.jsonl`
   gains 2 lines and `stocks-last.json` is populated.
2. Add a bogus symbol (e.g. `NOTASYMBOL`), rerun → stderr shows `NOTASYMBOL: fetch failed`,
   the other tickers still log fine.
3. Hand-edit `stocks-last.json` so one ticker's stored price is ~5% below current → rerun
   → stdout shows >2% change AND a Telegram message arrives.
4. Remove the Telegram env vars and rerun → script still completes, stderr warns
   `telegram: credentials missing in .env, skipping alert`.
