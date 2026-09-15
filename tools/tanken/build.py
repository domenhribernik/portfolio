#!/usr/bin/env python3
"""Build the hour-of-day fuel price statistics for views/tanken.

Reads the Tankerkoenig historical archive (every price change of every German
station since June 2014) and reduces it to the only thing the website needs:
the median deviation from a station's own daily mean, by hour of day, weekday
and fuel. That is 168 numbers per fuel, plus a 24-number summary curve.

This is a batch job. It is never run at request time, it never touches the
database, and its ~20 GB of input never leaves the machine it runs on. The
website reads the committed JSON and nothing else.

    git clone https://tankerkoenig@dev.azure.com/tankerkoenig/tankerkoenig-data/_git/tankerkoenig-data
    python3 tools/tanken/build.py --archive=/path/to/tankerkoenig-data --from=2024-09 --to=2026-08

Licence: the archive is CC BY-NC-SA 4.0, non-commercial only. See
tools/tanken/README.md before publishing anything built from it.

Stdlib only, and streaming throughout: no input file is ever read whole.

Run:   python3 tools/tanken/build.py --archive=PATH [--from=YYYY-MM] [--to=YYYY-MM] [--check]
Tests: python3 tests/tanken-build.test.py
"""

import argparse
import csv
import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
OUT_FILE = ROOT / "views" / "tanken" / "hourly-stats.json"

BERLIN = ZoneInfo("Europe/Berlin")
FUELS = ("e5", "e10", "diesel")

#? A station-day with fewer valid hours than this is thrown away rather than
#? normalized: its mean would be taken over a fragment of the day, which moves
#? every deviation derived from it.
MIN_HOURS_PER_DAY = 20

#? Prices outside this range are data errors (the archive contains a handful of
#? 0.00 and 9.99 rows) and would drag a mean far more than they would a median.
PRICE_MIN, PRICE_MAX = 0.50, 4.00

#? The medians are taken from a histogram rather than from a list of samples.
#? A decade of the archive is on the order of a billion hourly observations,
#? which cannot be held in memory or sorted; counting them into 0.1 cent bins
#? can, in a fixed 504 x 1001 array, regardless of how many years are asked
#? for. The cost is that a median is exact only to the bin width, which at a
#? tenth of a cent is finer than the pump prints.
BIN = 0.001
BIN_SPAN = 0.5
BIN_COUNT = int(2 * BIN_SPAN / BIN) + 1
BIN_ZERO = BIN_COUNT // 2


def parse_price(text):
    """A price field, or None when the station does not sell that fuel."""
    if not text:
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    if value < PRICE_MIN or value > PRICE_MAX:
        return None
    return value


def local_date_hour(stamp):
    """(YYYY-MM-DD, hour) in Europe/Berlin for one archive timestamp.

    The archive writes Postgres timestamptz rendered in the server's own zone,
    so the string is already Berlin local time and carries its offset:
    '2024-01-15 07:12:03+01'. When the offset is one Berlin actually uses we
    can read the date and hour straight off the string, which matters when
    there are a billion of them. Anything else (a file dumped in UTC, say) is
    converted properly rather than trusted.
    """
    offset = stamp[19:22]
    if offset in ("+01", "+02"):
        return stamp[0:10], int(stamp[11:13])
    moment = datetime.fromisoformat(stamp).astimezone(BERLIN)
    return moment.strftime("%Y-%m-%d"), moment.hour


def valid_hours(day):
    """The hour labels that exist on this Berlin date.

    Cutting days by UTC would misplace midnight, and assuming 24 hours would
    invent an 02:00 on the spring-forward day and silently average two
    different 02:00s on the autumn one. The spring gap is what this removes;
    the autumn repeat keeps the later of the two readings, which is what
    forward-filling does anyway.
    """
    hours = []
    for hour in range(24):
        moment = datetime(day.year, day.month, day.day, hour, tzinfo=BERLIN)
        #? The round trip through UTC is what detects the spring gap: an hour
        #? that does not exist is resolved with the pre-transition offset, so
        #? it comes back as a different wall clock. Converting Berlin straight
        #? to Berlin would be a no-op and would find nothing.
        if moment.astimezone(timezone.utc).astimezone(BERLIN).hour == hour:
            hours.append(hour)
    return hours


def month_range(start, end):
    """Inclusive YYYY-MM strings from start to end."""
    out, year, month = [], int(start[:4]), int(start[5:7])
    last_year, last_month = int(end[:4]), int(end[5:7])
    while (year, month) <= (last_year, last_month):
        out.append(f"{year:04d}-{month:02d}")
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return out


def day_files(archive, months):
    """Every prices CSV in the window, in chronological order."""
    for month in months:
        folder = archive / "prices" / month[:4] / month[5:7]
        if not folder.is_dir():
            continue
        for path in sorted(folder.glob("*-prices.csv")):
            yield path


def read_day(path, carry):
    """Stream one day file into {(station, fuel): {hour: price}}.

    Only the changes are held, not an hour grid per station: a day has a few
    hundred thousand changes and fifteen thousand stations, so the grid is
    built once per station at the end of the day instead of being carried
    through the scan.
    """
    events = {}
    day_label = None
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        header = next(reader, None)
        if header is None:
            return day_label, events
        try:
            columns = {name: header.index(name) for name in ("date", "station_uuid", *FUELS)}
        except ValueError:
            raise SystemExit(f"{path}: unexpected columns {header}")

        for row in reader:
            if len(row) <= columns["diesel"]:
                continue
            stamp = row[columns["date"]]
            if len(stamp) < 22:
                continue
            label, hour = local_date_hour(stamp)
            if day_label is None:
                day_label = label
            elif label != day_label:
                #? A change a few seconds either side of midnight lands in the
                #? neighbouring file. Fold it into the carry so the next day
                #? starts from it, rather than filing it under the wrong date.
                for fuel in FUELS:
                    price = parse_price(row[columns[fuel]])
                    if price is not None:
                        carry[(row[columns["station_uuid"]], fuel)] = price
                continue

            station = row[columns["station_uuid"]]
            for fuel in FUELS:
                price = parse_price(row[columns[fuel]])
                if price is not None:
                    events.setdefault((station, fuel), {})[hour] = price
    return day_label, events


def fill_day(events, carry, hours):
    """Forward-fill each station/fuel across the day's hour labels.

    A price stays valid until the next change for the same station and fuel,
    including across midnight, which is what `carry` is for: a station that
    did not move its price until noon still had one at 06:00.
    """
    keys = set(events) | set(carry)
    for key in keys:
        changes = events.get(key)
        value = carry.get(key)
        series = []
        for hour in hours:
            if changes is not None and hour in changes:
                value = changes[hour]
            series.append(value)
        if value is not None:
            carry[key] = value
        yield key, series


def accumulate(series, hours, weekday, histograms, totals):
    """Normalize one station-day and count it into the histograms.

    The normalization is the whole reason the output means anything: fuel cost
    three times as much in 2022 as in 2016, so the raw hourly prices would be
    a chart of the oil market rather than of the trading day. Expressing each
    hour as a deviation from that station's own mean for that day removes both
    the long-term trend and the fact that the autobahn is dearer than the
    suburbs, leaving only the shape of the day.
    """
    valid = [(hour, price) for hour, price in zip(hours, series) if price is not None]
    if len(valid) < MIN_HOURS_PER_DAY:
        return 0

    mean = sum(price for _, price in valid) / len(valid)
    counted = 0
    for hour, price in valid:
        index = BIN_ZERO + int(round((price - mean) / BIN))
        if index < 0 or index >= BIN_COUNT:
            continue
        histograms[weekday][hour][index] += 1
        totals[hour][index] += 1
        counted += 1
    return counted


def median_of(histogram):
    """The median deviation of a bin-counted distribution, or None if empty."""
    total = sum(histogram)
    if total == 0:
        return None
    half, seen = total / 2, 0
    for index, count in enumerate(histogram):
        seen += count
        if seen >= half:
            return round((index - BIN_ZERO) * BIN, 4)
    return None


def new_histograms():
    per_fuel = {}
    for fuel in FUELS:
        per_fuel[fuel] = (
            [[[0] * BIN_COUNT for _ in range(24)] for _ in range(7)],
            [[0] * BIN_COUNT for _ in range(24)],
        )
    return per_fuel


def build(archive, first_month, last_month, verbose=True):
    archive = Path(archive)
    if not (archive / "prices").is_dir():
        raise SystemExit(f"{archive} does not look like the archive: no prices/ directory")

    histograms = new_histograms()
    #? One flat table of the last price known for every station and fuel,
    #? living across day boundaries. This is the only state the scan carries,
    #? and at roughly 15,000 stations by 3 fuels it stays small no matter how
    #? many years are processed.
    carry = {}
    samples = {fuel: 0 for fuel in FUELS}
    days_seen, first_seen, last_seen = 0, None, None

    for path in day_files(archive, month_range(first_month, last_month)):
        day_label, events = read_day(path, carry)
        if day_label is None:
            continue
        day = date.fromisoformat(day_label)
        hours = valid_hours(day)
        weekday = day.weekday()

        for (_station, fuel), series in fill_day(events, carry, hours):
            weekly, daily = histograms[fuel]
            samples[fuel] += accumulate(series, hours, weekday, weekly, daily)

        days_seen += 1
        first_seen = first_seen or day_label
        last_seen = day_label
        if verbose and days_seen % 100 == 0:
            print(f"  {day_label}  ({days_seen} days)", file=sys.stderr)

    if days_seen == 0:
        raise SystemExit(f"no day files found in {archive}/prices for {first_month}..{last_month}")

    by_hour_weekday, by_hour, cheapest = {}, {}, {}
    for fuel in FUELS:
        weekly, daily = histograms[fuel]
        by_hour_weekday[fuel] = [[median_of(weekly[wd][h]) for h in range(24)] for wd in range(7)]
        curve = [median_of(daily[h]) for h in range(24)]
        by_hour[fuel] = curve
        known = [(value, hour) for hour, value in enumerate(curve) if value is not None]
        cheapest[fuel] = min(known)[1] if known else None

    return {
        "generated": datetime.now(BERLIN).strftime("%Y-%m-%d"),
        "source": "Tankerkönig historical archive (MTS-K)",
        "licence": "CC BY-NC-SA 4.0",
        "timezone": "Europe/Berlin",
        "unit": "eur",
        "note": "Median deviation from each station's own mean price that day.",
        "window": {"from": first_seen, "to": last_seen, "days": days_seen},
        "fuels": list(FUELS),
        "weekdays": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        "samples": samples,
        "cheapestHour": cheapest,
        "byHour": by_hour,
        "byHourWeekday": by_hour_weekday,
    }


def check_sawtooth(stats):
    """German prices fall through the day from an expensive morning to evening
    dips. If the output does not have that shape the pipeline is wrong, and a
    wrong curve that looks plausible is worse than no curve, so refuse to
    write one."""
    problems = []
    for fuel in stats["fuels"]:
        curve = stats["byHour"][fuel]
        morning = [curve[h] for h in (6, 7, 8) if curve[h] is not None]
        evening = [curve[h] for h in (19, 20, 21) if curve[h] is not None]
        if not morning or not evening:
            problems.append(f"{fuel}: no data in the morning or evening hours")
            continue
        morning_mean = sum(morning) / len(morning)
        evening_mean = sum(evening) / len(evening)
        if morning_mean <= 0:
            problems.append(f"{fuel}: mornings are not above the daily mean ({morning_mean:+.4f})")
        if evening_mean >= 0:
            problems.append(f"{fuel}: evenings are not below the daily mean ({evening_mean:+.4f})")
        if morning_mean - evening_mean < 0.01:
            problems.append(
                f"{fuel}: daily swing is only {100 * (morning_mean - evening_mean):.2f} cents, "
                "which is too flat to be the German sawtooth"
            )
    return problems


def serialize(stats):
    """Deterministic, so an unchanged archive rebuilds byte for byte."""
    return json.dumps(stats, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--archive", required=True, help="path to the cloned tankerkoenig-data repo")
    parser.add_argument("--from", dest="first", default="2014-06", help="first month, YYYY-MM")
    parser.add_argument("--to", dest="last", default=date.today().strftime("%Y-%m"), help="last month, YYYY-MM")
    parser.add_argument("--check", action="store_true", help="rebuild and diff against the committed file, writing nothing")
    parser.add_argument("--force", action="store_true", help="write even if the sawtooth check fails")
    args = parser.parse_args()

    stats = build(args.archive, args.first, args.last)

    problems = check_sawtooth(stats)
    if problems:
        for problem in problems:
            print(f"sanity check failed: {problem}", file=sys.stderr)
        if not args.force:
            print("refusing to write; re-run with --force only if you know why", file=sys.stderr)
            return 1

    payload = serialize(stats)

    if args.check:
        current = OUT_FILE.read_text(encoding="utf-8") if OUT_FILE.exists() else ""
        #? `generated` is a clock reading, not a result, so it must not count
        #? as a difference when checking that a rebuild is reproducible.
        normalize = lambda text: "\n".join(
            line for line in text.splitlines() if not line.strip().startswith('"generated"')
        )
        if normalize(current) == normalize(payload):
            print("up to date")
            return 0
        print("hourly-stats.json differs from a fresh build", file=sys.stderr)
        return 1

    OUT_FILE.write_text(payload, encoding="utf-8")
    print(f"wrote {OUT_FILE.relative_to(ROOT)}  ({stats['window']['days']} days, "
          f"{sum(stats['samples'].values()):,} observations)")
    for fuel in stats["fuels"]:
        print(f"  {fuel:<7} cheapest around {stats['cheapestHour'][fuel]:02d}:00")
    return 0


if __name__ == "__main__":
    sys.exit(main())
