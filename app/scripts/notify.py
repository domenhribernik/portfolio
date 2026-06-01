#!/usr/bin/env python3
"""Send a Telegram message from the command line. Usage: python notify.py [message]"""

import sys
from pathlib import Path

from telegram import send_message

SCRIPT_DIR = Path(__file__).resolve().parent
APP_DIR = SCRIPT_DIR.parent
ENV_FILE = APP_DIR / ".env"


def load_env(path):
    env = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        env[key.strip()] = val.strip().strip('"').strip("'")
    return env


def main():
    if len(sys.argv) > 1:
        message = " ".join(sys.argv[1:])
    else:
        message = input("Message: ").strip()

    if not message:
        print("No message provided.", file=sys.stderr)
        return 1

    env = load_env(ENV_FILE)
    token = env.get("TELEGRAM_BOT_TOKEN")
    chat_id = env.get("TELEGRAM_CHAT_ID")

    if not token or not chat_id:
        print("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in app/.env", file=sys.stderr)
        return 1

    ok = send_message(token, chat_id, message)
    print("Sent." if ok else "Failed to send.", file=sys.stderr)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
