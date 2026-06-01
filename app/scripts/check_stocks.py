#!/usr/bin/env python3
"""Stocks watcher — fetch prices, log to history, alert on >=2% moves."""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from yahoo import fetch_quote
from telegram import send_message

ALERT_THRESHOLD_PCT = 2.0

SCRIPT_DIR = Path(__file__).resolve().parent
APP_DIR = SCRIPT_DIR.parent
REPO_ROOT = APP_DIR.parent
CACHE_DIR = APP_DIR / "cache"
ENV_FILE = APP_DIR / ".env"

TICKERS_FILE = CACHE_DIR / "stocks.json"
LAST_FILE = CACHE_DIR / "stocks-last.json"
HISTORY_FILE = CACHE_DIR / "stocks-history.jsonl"


def load_env(path):
    """Minimal .env parser: KEY=VALUE per line, # comments, strip surrounding quotes."""
    env = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        val = val.strip().strip('"').strip("'")
        env[key.strip()] = val
    return env


def load_json(path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return default


def write_json_atomic(path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def append_history(record):
    with HISTORY_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")


def format_alerts(alerts):
    lines = ["<b>📈 Stock alerts</b> (±{:.0f}% since last check)".format(ALERT_THRESHOLD_PCT), ""]
    for a in alerts:
        arrow = "↑" if a["pct"] > 0 else "↓"
        lines.append(f"<code>{a['ticker']:<6}</code> {a['price']:.2f} {a['pct']:+.2f}% {arrow}")
    return "\n".join(lines)


def main():
    tickers = load_json(TICKERS_FILE, [])
    if not tickers:
        return 0

    last = load_json(LAST_FILE, {})
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    new_last = {}
    alerts = []

    for ticker in tickers:
        quote = fetch_quote(ticker)
        if quote is None:
            continue

        price = quote["price"]
        prev_close = quote["prev_close"]

        append_history({
            "ts": now_iso,
            "ticker": ticker,
            "price": price,
            "prev_close": prev_close,
            "currency": quote["currency"],
        })

        prior = last.get(ticker)
        pct = None
        if prior and prior.get("price"):
            pct = (price - prior["price"]) / prior["price"] * 100.0

        pct_str = f"{pct:+.2f}%" if pct is not None else "  (new)"
        print(f"{ticker:<6} {price:>10.2f}  {pct_str}")

        if pct is not None and abs(pct) >= ALERT_THRESHOLD_PCT:
            alerts.append({"ticker": ticker, "price": price, "pct": pct})

        new_last[ticker] = {"price": price, "ts": now_iso}

    if new_last:
        write_json_atomic(LAST_FILE, new_last)

    if alerts:
        env = load_env(ENV_FILE)
        token = env.get("TELEGRAM_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN")
        chat_id = env.get("TELEGRAM_CHAT_ID") or os.environ.get("TELEGRAM_CHAT_ID")
        if token and chat_id:
            send_message(token, chat_id, format_alerts(alerts))
        else:
            print("telegram: credentials missing in .env, skipping alert", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
