#!/usr/bin/env python3
"""Cron entry for the LJSE tracker (views/stocks) that says why it failed.

The sync itself stays in PHP (app/scripts/stocks-sync.php -> the tested
app/services/stocks-sync-service.php): it is the same engine the website runs,
and duplicating LJSE parsing, alert rules and MySQL access in a second language
would mean two things to keep in step. What this wrapper adds is everything the
host makes hard: it finds a working PHP binary itself instead of trusting a
hardcoded /usr/bin/php82, runs the sync, and writes a readable report to

    <site root>/stocks-sync.log

so a broken run can be read over SFTP (or in a browser) on a host with no
shell. Successful runs add one line; failures add a full block: the layout
database.php resolves, every PHP binary on the host with its version and
extensions, whether the exchange and Telegram are reachable from here, and the
sync's own output. Secrets from .env are scrubbed from everything written.

Usage (all optional):
    python3 app/scripts/stocks-sync.py                one sync pass + alerts
    python3 app/scripts/stocks-sync.py --diagnose     report only, no sync
    python3 app/scripts/stocks-sync.py --backfill=365 seed daily history
    python3 app/scripts/stocks-sync.py --php=/path/to/php   pin the binary

Cron (LJSE trades roughly 9:15-14:00 CET on weekdays):
    */15 8-15 * * 1-5 /usr/bin/python3 public_html/app/scripts/stocks-sync.py

Exit codes: 0 synced, 1 the sync failed, 2 no usable PHP binary found.
Stdlib only, like the other app/scripts tools.
"""

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from glob import glob
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PHP_ENTRY = ROOT / "app" / "scripts" / "stocks-sync.php"
LOG_FILE = ROOT / "stocks-sync.log"
STATE_FILE = ROOT / "app" / "cache" / "stocks-sync-cron.json"
DEV_MODE_FILE = ROOT / "app" / "config" / "dev-mode.php"

# Production .env and vendor live outside public_html; this mirrors the
# $basePath line in app/config/database.php, so the report can say whether
# what PHP is about to look for is actually there.
PROD_BASE = Path("/usr/home/meuhdy")

LOG_MAX_BYTES = 256 * 1024
BLOCK_RULE = "=" * 72
MIN_PHP_VERSION_ID = 80000
DEFAULT_TIMEOUT = 600

# Named first (a shared host usually versions the binary), then a sweep of the
# places one hides. The sweep is why this exists: cron runs with PATH=/usr/bin:/bin,
# where a php82 installed under /usr/local is simply invisible.
PHP_NAMES = ("php82", "php8.2", "php83", "php8.3", "php84", "php8.4",
             "php81", "php8.1", "php80", "php8.0", "php8", "php")
PHP_GLOBS = (
    "/usr/bin/php*", "/usr/local/bin/php*", "/bin/php*",
    "/usr/local/php*/bin/php", "/usr/local/php*/bin/php*",
    "/opt/php*/bin/php", "/opt/alt/php*/usr/bin/php",
    "/opt/cpanel/ea-php*/root/usr/bin/php", "/opt/plesk/php/*/bin/php",
    "/usr/iports/php*/bin/php", "/usr/home/*/bin/php*",
    "/opt/lampp/bin/php",  # local XAMPP, so a dev run finds the same engine
)

PROBE = ("echo PHP_VERSION, '|', PHP_VERSION_ID, '|', (int) extension_loaded('pdo_mysql'),"
         " '|', (int) extension_loaded('curl'), '|', (int) (bool) ini_get('allow_url_fopen');")

LJSE_PATH = "/json/TradingPriceList?lng=si&market_segment_ids=A,B,E&type=ALL&only_traded=0"
USER_AGENT = "domenhribernik.com portfolio tracker"

SECRET_VALUES = set()  # .env values scrubbed from anything this script writes

# The same env seams the PHP service honours; a value in the process
# environment wins over .env, exactly as Dotenv's immutable load does.
OVERRIDABLE = ("LJSE_BASE_URL", "TELEGRAM_API_BASE", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID")


# ----------------------------------------------------------------------
#  Output safety
# ----------------------------------------------------------------------

def redact(text):
    """Strip anything secret-shaped: the log is world-readable on the host."""
    if not text:
        return text
    for value in SECRET_VALUES:
        if len(value) >= 6:
            text = text.replace(value, "<REDACTED>")
    text = re.sub(r"(bot)\d{6,}:[A-Za-z0-9_-]{20,}", r"\1[token]", text)
    # Stop at a quote or bracket so a redaction never swallows the rest of a
    # sentence, e.g. MySQL's "(using password: YES)".
    text = re.sub(r"(?i)\b(pass(?:word)?|pwd|secret|token|api[_-]?key)(\s*[:=]\s*)[^\s)\]\"']+",
                  r"\1\2[redacted]", text)
    return text


def read_env_file(path):
    """KEY -> value from a .env, remembering the secret ones for redact()."""
    values = {}
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return values
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("'\"")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        values[key] = value
        if re.search(r"(PASS|TOKEN|SECRET|KEY)", key, re.I) and value:
            SECRET_VALUES.add(value)
    return values


# ----------------------------------------------------------------------
#  Host inspection
# ----------------------------------------------------------------------

def dev_mode():
    """The $DEV_MODE flag database.php will read, or None if unreadable."""
    try:
        match = re.search(r"\$DEV_MODE\s*=\s*(true|false)", DEV_MODE_FILE.read_text(encoding="utf-8"))
    except OSError:
        return None
    return match.group(1) == "true" if match else None


def config_base():
    """Where database.php will look for .env and vendor/, per $DEV_MODE."""
    flag = dev_mode()
    if flag is None:
        return None
    return (ROOT / "app") if flag else PROD_BASE


def php_candidates():
    """Every PHP binary on this host, named guesses first then the sweep."""
    found, seen = [], set()

    def add(path):
        try:
            real = os.path.realpath(path)
        except OSError:
            return
        if real in seen or not os.path.isfile(path) or not os.access(path, os.X_OK):
            return
        seen.add(real)
        found.append(path)

    for name in PHP_NAMES:
        located = shutil.which(name)
        if located:
            add(located)
    for pattern in PHP_GLOBS:
        for path in sorted(glob(pattern)):
            add(path)
    return found


def inspect_php(binary):
    """Version and the extensions the sync needs, or an error for the report."""
    info = {"path": binary, "version": None, "version_id": 0,
            "pdo_mysql": False, "curl": False, "url_fopen": False, "error": None}
    try:
        proc = subprocess.run([binary, "-r", PROBE], capture_output=True,
                              text=True, timeout=25)
    except (OSError, subprocess.SubprocessError) as exc:
        info["error"] = str(exc)
        return info

    stdout = (proc.stdout or "").strip()
    parts = stdout.splitlines()[-1].split("|") if stdout else []
    if len(parts) != 5:
        complaint = ((proc.stderr or "").strip() or stdout or "no output").splitlines()
        info["error"] = complaint[0] if complaint else "no output"
        return info

    info["version"] = parts[0]
    info["version_id"] = int(parts[1]) if parts[1].isdigit() else 0
    info["pdo_mysql"] = parts[2] == "1"
    info["curl"] = parts[3] == "1"
    info["url_fopen"] = parts[4] == "1"
    return info


def choose_php(reports):
    """Newest PHP 8+ that can reach MySQL; else newest PHP 8+; else nothing."""
    usable = [r for r in reports if not r["error"] and r["version_id"] >= MIN_PHP_VERSION_ID]
    with_pdo = [r for r in usable if r["pdo_mysql"]]
    pool = with_pdo or usable
    return max(pool, key=lambda r: r["version_id"]) if pool else None


def probe_url(url, timeout=20):
    """(status, body, error) without ever raising."""
    request = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read(400_000), None
    except urllib.error.HTTPError as exc:
        return exc.code, b"", None
    except Exception as exc:  # DNS, TLS, timeout, blocked egress
        return None, b"", redact(str(exc))


def probe_exchange(base_url):
    status, body, error = probe_url(base_url.rstrip("/") + LJSE_PATH)
    if error:
        return f"unreachable: {error}"
    if status != 200:
        return f"HTTP {status}"
    try:
        payload = json.loads(body)
        return (f"HTTP 200, {len(body)} bytes, market_data_date "
                f"{payload.get('market_data_date', '?')}, "
                f"{len(payload.get('priceList', []))} segments")
    except ValueError:
        return f"HTTP 200 but the body is not JSON ({len(body)} bytes)"


def probe_telegram(token, api_base):
    if not token:
        return "no TELEGRAM_BOT_TOKEN in .env, alerts cannot be sent"
    status, body, error = probe_url(f"{api_base.rstrip('/')}/bot{token}/getMe")
    if error:
        return f"unreachable: {error}"
    if status != 200:
        return f"HTTP {status}, the bot token looks wrong"
    try:
        name = json.loads(body).get("result", {}).get("username", "?")
        return f"HTTP 200, bot @{name} answers"
    except ValueError:
        return "HTTP 200 but the body is not JSON"


# ----------------------------------------------------------------------
#  The report
# ----------------------------------------------------------------------

def stamp():
    """Local wall clock with its zone, so log lines match the cron schedule."""
    return datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")


def indent(text, prefix="    "):
    text = (text or "").strip()
    if not text:
        return prefix + "(empty)"
    return "\n".join(prefix + line for line in text.splitlines())


def diagnostics(php_reports, chosen, env, run_probes):
    """The block written when something is wrong, or on --diagnose."""
    base = config_base()
    lines = ["--- where things are ---",
             f"    host          : {os.uname().nodename if hasattr(os, 'uname') else '?'}",
             f"    user          : {os.environ.get('USER') or os.environ.get('LOGNAME') or os.getuid()}",
             f"    cwd           : {os.getcwd()}",
             f"    python        : {sys.version.split()[0]} ({sys.executable})",
             f"    PATH          : {os.environ.get('PATH', '(unset)')}",
             f"    site root     : {ROOT}",
             f"    sync entry    : {PHP_ENTRY} "
             f"{'found' if PHP_ENTRY.is_file() else 'MISSING'}"]

    flag = dev_mode()
    lines.append(f"    $DEV_MODE     : {'?' if flag is None else str(flag).lower()}"
                 f"  ({DEV_MODE_FILE})")
    if base is None:
        lines.append("    config base   : could not read dev-mode.php, database.php will fail")
    else:
        env_file, vendor = base / ".env", base / "vendor" / "autoload.php"
        lines.append(f"    config base   : {base}")
        lines.append(f"      .env        : {'found, keys: ' + ', '.join(sorted(env)) if env_file.is_file() else 'MISSING, database.php cannot connect'}")
        lines.append(f"      vendor      : {'found' if vendor.is_file() else 'MISSING at ' + str(vendor) + ', database.php dies here'}")
    cache = ROOT / "app" / "cache"
    lines.append(f"    app/cache     : {'writable' if os.access(cache, os.W_OK) else 'NOT writable, the sync stamp cannot be saved'}")

    lines.append("")
    lines.append("--- php binaries on this host ---")
    if not php_reports:
        lines.append("    none found. Ask the host for the CLI path (often /usr/local/bin/php82)")
    for report in php_reports:
        mark = "  <-- used" if chosen and report["path"] == chosen["path"] else ""
        if report["error"]:
            lines.append(f"    {report['path']:<40} unusable: {redact(str(report['error']))}")
            continue
        flags = (f"pdo_mysql={'yes' if report['pdo_mysql'] else 'NO'} "
                 f"curl={'yes' if report['curl'] else 'NO'} "
                 f"allow_url_fopen={'yes' if report['url_fopen'] else 'NO'}")
        age = "" if report["version_id"] >= MIN_PHP_VERSION_ID else "  (too old, needs 8.0+)"
        lines.append(f"    {report['path']:<40} {report['version']:<8} {flags}{age}{mark}")

    if run_probes:
        lines.append("")
        lines.append("--- reachable from this host ---")
        lines.append(f"    ljse.si          : {probe_exchange(env.get('LJSE_BASE_URL') or 'https://ljse.si')}")
        lines.append(f"    api.telegram.org : {probe_telegram(env.get('TELEGRAM_BOT_TOKEN'), env.get('TELEGRAM_API_BASE') or 'https://api.telegram.org')}")
    return lines


def append_log(block):
    """Append one block, trimming the file's head when it grows past the cap."""
    try:
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > LOG_MAX_BYTES:
            kept = LOG_FILE.read_bytes()[-(LOG_MAX_BYTES // 2):]
            cut = kept.find(b"\n" + BLOCK_RULE.encode())
            kept = kept[cut + 1:] if cut >= 0 else kept
            LOG_FILE.write_bytes(b"[... older runs trimmed ...]\n" + kept)
        with LOG_FILE.open("a", encoding="utf-8") as handle:
            handle.write(block)
    except OSError as exc:
        print(f"stocks-sync: cannot write {LOG_FILE}: {exc}", file=sys.stderr)


def notify_failure(env, summary):
    """Best-effort Telegram ping, at most one per calendar day per message."""
    token, chat = env.get("TELEGRAM_BOT_TOKEN"), env.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        return
    today = datetime.now().strftime("%Y-%m-%d")
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    if state.get("failure_date") == today and state.get("failure_summary") == summary:
        return

    # HTML parse mode: a raw error line carrying < or > is rejected with a 400,
    # so the summary is escaped before it goes anywhere near Telegram.
    text = ("⚠️ <b>Sinhronizacija tečajnice ne teče</b>\n" + html.escape(summary) +
            "\nPodrobnosti: stocks-sync.log")
    body = json.dumps({"chat_id": chat, "text": text, "parse_mode": "HTML",
                       "disable_web_page_preview": True}).encode()
    base = (env.get("TELEGRAM_API_BASE") or "https://api.telegram.org").rstrip("/")
    request = urllib.request.Request(f"{base}/bot{token}/sendMessage", data=body,
                                     headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(request, timeout=10).read()
    except Exception:
        return  # the log is the durable channel; this is only a courtesy
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps({"failure_date": today, "failure_summary": summary}),
                              encoding="utf-8")
    except OSError:
        pass


# ----------------------------------------------------------------------
#  Main
# ----------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--diagnose", action="store_true",
                        help="write the host report without running the sync")
    parser.add_argument("--backfill", nargs="?", const="365", metavar="DAYS",
                        help="seed daily history instead of syncing (default 365 days)")
    parser.add_argument("--php", metavar="PATH", help="pin the PHP binary instead of searching")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT,
                        help=f"seconds to allow the sync (default {DEFAULT_TIMEOUT})")
    args = parser.parse_args()

    base = config_base()
    env = read_env_file(base / ".env") if base else {}
    env.update({key: os.environ[key] for key in OVERRIDABLE if os.environ.get(key)})
    when = stamp()

    reports = [inspect_php(p) for p in ([args.php] if args.php else php_candidates())]
    chosen = choose_php(reports)

    if args.diagnose:
        block = (f"\n{BLOCK_RULE}\nstocks-sync  DIAGNOSE  {when}\n{BLOCK_RULE}\n" +
                 "\n".join(diagnostics(reports, chosen, env, run_probes=True)) + "\n")
        append_log(redact(block))
        print(redact(block.strip()))
        return 0 if chosen else 2

    def fail(summary, extra_lines=()):
        block = [f"\n{BLOCK_RULE}", f"stocks-sync  FAILED  {when}", BLOCK_RULE,
                 f"what happened : {summary}", ""]
        block.extend(extra_lines)
        block.extend(diagnostics(reports, chosen, env, run_probes=True))
        append_log(redact("\n".join(block) + "\n"))
        print(redact(f"stocks-sync FAILED: {summary} (see {LOG_FILE})"), file=sys.stderr)
        notify_failure(env, redact(summary))
        return summary

    if not PHP_ENTRY.is_file():
        fail(f"the PHP sync entry is missing at {PHP_ENTRY}")
        return 2
    if chosen is None:
        fail("no usable PHP binary found on this host (needs 8.0+ with pdo_mysql)")
        return 2

    command = [chosen["path"], "-d", "variables_order=EGPCS", str(PHP_ENTRY)]
    if args.backfill:
        command.append(f"--backfill={args.backfill}")

    started = time.monotonic()
    try:
        proc = subprocess.run(command, capture_output=True, text=True,
                              timeout=args.timeout, cwd=str(ROOT))
        stdout, stderr, code = proc.stdout, proc.stderr, proc.returncode
    except subprocess.TimeoutExpired:
        stdout, stderr, code = "", f"killed after {args.timeout}s", -1
    except OSError as exc:
        stdout, stderr, code = "", str(exc), -1
    elapsed = time.monotonic() - started

    # database.php reports a bad config by die()ing with a message and exit 0,
    # so a clean exit code alone is not proof the sync ran.
    expected = re.compile(r"^(synced |backfill done:|[A-Z0-9]+\s+\d+ days$)", re.M)
    ok = code == 0 and bool(expected.search(stdout))

    php_run = ["--- the php run ---",
               f"    command : {' '.join(command)}",
               f"    exit    : {code} after {elapsed:.1f}s",
               "    stdout  :", indent(redact(stdout), "      "),
               "    stderr  :", indent(redact(stderr), "      "), ""]

    if not ok:
        detail = (stderr or stdout or "no output at all").strip().splitlines()
        fail(f"PHP exited {code}: " + (detail[0] if detail else "no output"), php_run)
        return 1

    # One line per good run: "synced ..." for a sync, "backfill done: ..." for a seed.
    summary = [line for line in stdout.splitlines() if line.strip()][-1]
    append_log(f"{when}  OK  {redact(summary.strip())}  "
               f"({elapsed:.1f}s, php {chosen['version']})\n")
    print(redact(stdout.strip()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
