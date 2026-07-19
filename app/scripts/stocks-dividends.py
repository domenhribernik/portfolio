#!/usr/bin/env python3
"""Scrape confirmed LJSE dividend dates from SEOnet and print the upcoming ones.

For every dividend confirmed at an AGM, the Ljubljana Stock Exchange publishes
a standardized "sprejeta dividenda" announcement on SEOnet (seonet.ljse.si)
with the symbol, gross amount, first ex-dividend trading day, record day
("presecni dan", the value stocks-model.sql stores as ex_date) and pay date.
This script searches those announcements, parses the labeled fields and logs
a console digest, so the stocks_dividends seed rows can be checked and updated
without clicking through SEOnet by hand.

Usage: python3 stocks-dividends.py [--days 365] [--all]
  --days N   how far back to search announcements (default 365)
  --all      also print announcements whose dates are all in the past

Stdlib only, like the other app/scripts tools. Read-only against SEOnet.
"""

import argparse
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from html import unescape

BASE_URL = "https://seonet.ljse.si"
USER_AGENT = "domenhribernik.com portfolio tracker (+https://domenhribernik.com)"
SEARCH_PHRASE = "sprejeta dividenda"
PAGE_CAP = 20
# SEOnet's search returns at most ~20 rows and silently drops the oldest
# matches beyond that, so a whole-year query loses spring confirmations. The
# scan walks the requested range in windows small enough that each stays under
# that cap (a peak dividend month has only 5-6 matching announcements).
WINDOW_DAYS = 30
CAP_WARN_ROWS = 18
FETCH_PAUSE = 0.5
TIMEOUT = 20

WEEKDAYS_SL = ["pon", "tor", "sre", "čet", "pet", "sob", "ned"]

# Labels as they appear in the announcement body, each with the wording
# variants seen across issuers; matched case-insensitively as line prefixes so
# small differences (e.g. "Datum izplačila" vs "Izplačila") don't break parse.
FIELD_LABELS = {
    "symbol": ["Oznaka delnic"],
    "amount": ["Višina potrjene dividende", "Višina dividende"],
    "pay_date": ["Datum izplačila dividend", "Izplačilo dividend", "Izplačila dividend"],
    "record_date": ["Presečni dan"],
    "ex_trading_date": ["Prvi trgovalni dan brez upravičenja"],
}

DATE_RE = re.compile(r"(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})")


def http(url, post_fields=None):
    data = urllib.parse.urlencode(post_fields).encode() if post_fields else None
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read().decode("utf-8", errors="replace")


def strip_tags(html):
    """Flatten HTML to text lines, one per tag boundary."""
    text = re.sub(r"<(script|style).*?</\1>", " ", html, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", "\n", text)
    return [line.strip() for line in unescape(text).split("\n") if line.strip()]


def parse_sl_date(text):
    """'četrtek, 23. 7. 2026' or '23.07.2026' -> date, else None."""
    m = DATE_RE.search(text)
    if not m:
        return None
    try:
        return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    except ValueError:
        return None


def search_window(date_from, date_to):
    """All (doc_id, published, title) rows in one date window, across pages."""
    rows = []
    seen_pages = set()
    for page in range(1, PAGE_CAP + 1):
        html = http(BASE_URL + "/default.aspx", {
            "doc": "LATEST_PUBLIC_ANNOUNCEMENTS",
            "field.page_no": str(page),
            "field.sort_field": "published",
            "field.sort_field_direction": "DESC",
            "field.words": SEARCH_PHRASE,
            "field.date_from": f"{date_from.day}.{date_from.month}.{date_from.year}",
            "field.date_to": f"{date_to.day}.{date_to.month}.{date_to.year}",
            "Search": "Iskanje",
        })
        table = re.search(r'<table[^>]*class="data_table".*?</table>', html, re.S)
        if not table:
            break
        page_docs = []
        for row in re.findall(r"<tr.*?</tr>", table.group(0), re.S):
            doc = re.search(r"doc_id=(\d+)", row)
            if not doc:
                continue
            cells = [re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", c))).strip()
                     for c in re.findall(r"<t[dh][^>]*>.*?</t[dh]>", row, re.S)]
            if len(cells) < 5:
                continue
            page_docs.append((doc.group(1), cells[1], cells[4]))
        first_id = page_docs[0][0] if page_docs else None
        if not page_docs or first_id in seen_pages:
            break  # empty page, or the server repeated the last page
        seen_pages.add(first_id)
        rows.extend(page_docs)
        if f"javascript:page({page + 1})" not in html:
            break
    return rows


def search_announcements(oldest, newest):
    """Yield confirmed-dividend announcements over [oldest, newest], deduped.

    Walks the range in WINDOW_DAYS windows so no single query hits SEOnet's
    result cap; warns if a window comes back near the cap anyway.
    """
    seen = set()
    start = oldest
    while start <= newest:
        stop = min(start + timedelta(days=WINDOW_DAYS - 1), newest)
        rows = search_window(start, stop)
        if len(rows) >= CAP_WARN_ROWS:
            print(f"  opozorilo: okno {start:%d.%m.%Y}-{stop:%d.%m.%Y} je vrnilo "
                  f"{len(rows)} vrstic, blizu meje; nekatere objave so morda izpuščene.",
                  file=sys.stderr)
        for doc_id, published, title in rows:
            # Keep only the exchange's Slovenian "sprejeta dividenda" notice,
            # skipping its English twin ("confirmed amount of dividend") and
            # any body-match noise, so each dividend is reported once.
            if doc_id in seen or SEARCH_PHRASE not in title.lower():
                continue
            seen.add(doc_id)
            yield doc_id, published, title
        start = stop + timedelta(days=1)


def parse_announcement(doc_id):
    """Fetch one announcement and pull out the labeled dividend fields."""
    lines = strip_tags(http(f"{BASE_URL}/?doc_id={doc_id}"))
    fields = {}
    for i, line in enumerate(lines):
        low = line.lower()
        for key, labels in FIELD_LABELS.items():
            if key in fields or not any(low.startswith(lbl.lower()) for lbl in labels):
                continue
            value = line.split(":", 1)[1].strip() if ":" in line else ""
            if not value and i + 1 < len(lines):
                value = lines[i + 1]
            fields[key] = value
    return {
        "symbol": fields.get("symbol", "?"),
        "amount": fields.get("amount", "?"),
        "ex_trading_date": parse_sl_date(fields.get("ex_trading_date", "")),
        "record_date": parse_sl_date(fields.get("record_date", "")),
        "pay_date": parse_sl_date(fields.get("pay_date", "")),
    }


def fmt(d):
    return f"{WEEKDAYS_SL[d.weekday()]} {d.strftime('%d.%m.%Y')}" if d else "?"


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--days", type=int, default=365,
                        help="how far back to search announcements (default 365)")
    parser.add_argument("--all", action="store_true",
                        help="also print announcements whose dates have all passed")
    args = parser.parse_args()

    today = date.today()
    print(f"SEOnet: potrjene dividende, objave od {today - timedelta(days=args.days):%d.%m.%Y} naprej ...")

    try:
        found = list(search_announcements(today - timedelta(days=args.days), today))
    except OSError as exc:
        print(f"SEOnet unreachable: {exc}", file=sys.stderr)
        return 1

    dividends = []
    for doc_id, published, _title in found:
        try:
            info = parse_announcement(doc_id)
        except OSError as exc:
            print(f"  doc {doc_id}: fetch failed ({exc})", file=sys.stderr)
            continue
        info["doc_id"] = doc_id
        pub = parse_sl_date(published)
        info["published"] = pub.strftime("%d.%m.%Y") if pub else published
        dividends.append(info)
        time.sleep(FETCH_PAUSE)

    if not dividends:
        print("Ni najdenih objav o sprejetih dividendah.")
        return 0

    dividends.sort(key=lambda d: d["pay_date"] or date.min)

    def has_pending(d):
        return any(x and x >= today
                   for x in (d["ex_trading_date"], d["record_date"], d["pay_date"]))

    shown = dividends if args.all else [d for d in dividends if has_pending(d)]
    suffix = "" if args.all else f" od skupno {len(dividends)} najdenih"
    print(f"\nDividende ({len(shown)}{suffix}):")
    upcoming = []
    for d in shown:
        print(f"  {d['symbol']:<6} {d['amount']:>10}   brez upravičenja: {fmt(d['ex_trading_date'])}"
              f"   presečni dan: {fmt(d['record_date'])}   izplačilo: {fmt(d['pay_date'])}"
              f"   (objava {d['published']}, doc {d['doc_id']})")
        for when, what in ((d["ex_trading_date"], "prvi dan brez upravičenja"),
                           (d["record_date"], "presečni dan"),
                           (d["pay_date"], "izplačilo dividende")):
            if when and when >= today:
                upcoming.append((when, d["symbol"], what))
    if not args.all and not shown:
        print("  (vse najdene dividende so že izplačane, --all pokaže tudi te)")

    print("\nPrihajajoči datumi:")
    if upcoming:
        for when, symbol, what in sorted(upcoming):
            print(f"  {fmt(when)}   {symbol:<6} {what}")
    else:
        print("  (nobenih)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
