"""Tiny stdlib client for Yahoo Finance's public chart endpoint."""

import json
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)
_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1m&range=1d"


def fetch_quote(symbol):
    """Return {"price", "prev_close", "currency"} for symbol, or None on any failure."""
    url = _BASE.format(symbol=symbol)
    req = Request(url, headers={"User-Agent": _UA, "Accept": "application/json"})

    try:
        with urlopen(req, timeout=5) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, ValueError) as e:
        print(f"{symbol}: fetch failed ({type(e).__name__}: {e})", file=sys.stderr)
        return None

    try:
        meta = payload["chart"]["result"][0]["meta"]
        price = float(meta["regularMarketPrice"])
        prev_close = float(meta["chartPreviousClose"])
        currency = meta.get("currency", "USD")
    except (KeyError, IndexError, TypeError, ValueError) as e:
        err = (payload.get("chart") or {}).get("error")
        if err:
            print(f"{symbol}: yahoo error: {err}", file=sys.stderr)
        else:
            print(f"{symbol}: malformed response ({type(e).__name__})", file=sys.stderr)
        return None

    return {"price": price, "prev_close": prev_close, "currency": currency}
