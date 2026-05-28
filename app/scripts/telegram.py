"""Tiny stdlib client for the Telegram Bot API."""

import json
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def send_message(token, chat_id, text):
    """Send a Telegram message. Return True on success, False otherwise (no raise)."""
    if not token or not chat_id:
        return False

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    body = json.dumps({
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }).encode("utf-8")

    req = Request(url, data=body, headers={"Content-Type": "application/json"})

    try:
        with urlopen(req, timeout=5) as resp:
            return resp.status == 200
    except (HTTPError, URLError, TimeoutError) as e:
        print(f"telegram: send failed ({type(e).__name__}: {e})", file=sys.stderr)
        return False
