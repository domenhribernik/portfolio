"""Unit tests for tools/tanken/build.py, the fuel price statistics pipeline.

The build reduces a billion price changes to 168 numbers per fuel, so nothing
downstream can tell you it went wrong: a broken forward-fill or a mis-cut day
still produces a smooth, plausible curve. These tests hold the four steps that
have a right answer, plus the sanity gate that is the last line of defence.

The DST cases are the reason the module uses Europe/Berlin rather than UTC at
all: cutting days by UTC date misplaces midnight for half the year, and
assuming every day has 24 hours invents an 02:00 that did not happen.

Stdlib unittest, no network, no archive, no large fixtures.

Run: python3 tests/tanken-build.test.py
"""

import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("tanken_build", ROOT / "tools" / "tanken" / "build.py")
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)


class Timestamps(unittest.TestCase):
    def test_a_berlin_offset_is_read_straight_off_the_string(self):
        self.assertEqual(build.local_date_hour("2024-01-15 07:12:03+01"), ("2024-01-15", 7))
        self.assertEqual(build.local_date_hour("2024-07-15 07:12:03+02"), ("2024-07-15", 7))

    def test_any_other_offset_is_converted_rather_than_trusted(self):
        # 23:30 UTC in January is already the next day in Berlin. Reading the
        # string would file it under the wrong date, which is exactly the
        # midnight-misplacement the timezone rule exists to prevent.
        self.assertEqual(build.local_date_hour("2024-01-15 23:30:00+00"), ("2024-01-16", 0))

    def test_a_price_outside_plausible_range_is_dropped(self):
        self.assertIsNone(build.parse_price("0.000"))
        self.assertIsNone(build.parse_price("9.999"))
        self.assertIsNone(build.parse_price(""))
        self.assertEqual(build.parse_price("1.789"), 1.789)


class DaylightSaving(unittest.TestCase):
    def test_the_spring_forward_day_has_no_two_oclock(self):
        hours = build.valid_hours(date(2024, 3, 31))
        self.assertEqual(len(hours), 23)
        self.assertNotIn(2, hours)

    def test_the_autumn_day_keeps_a_single_two_oclock_label(self):
        # 02:00 happens twice; there is still only one bucket for it, and
        # forward-filling means the later reading wins.
        hours = build.valid_hours(date(2024, 10, 27))
        self.assertEqual(len(hours), 24)
        self.assertIn(2, hours)

    def test_an_ordinary_day_has_all_of_them(self):
        self.assertEqual(build.valid_hours(date(2024, 6, 12)), list(range(24)))


class ForwardFill(unittest.TestCase):
    def test_a_price_holds_until_the_next_change(self):
        events = {("s1", "e5"): {8: 1.80, 14: 1.70}}
        carry = {}
        filled = dict(build.fill_day(events, carry, list(range(24))))
        series = filled[("s1", "e5")]
        self.assertIsNone(series[7])          # nothing known before the first change
        self.assertEqual(series[8], 1.80)
        self.assertEqual(series[13], 1.80)    # held, not interpolated
        self.assertEqual(series[14], 1.70)
        self.assertEqual(series[23], 1.70)

    def test_the_last_price_of_a_day_carries_into_the_next(self):
        carry = {}
        dict(build.fill_day({("s1", "e5"): {20: 1.65}}, carry, list(range(24))))
        self.assertEqual(carry[("s1", "e5")], 1.65)

        # Next day, no changes at all: the station still has a price all day.
        series = dict(build.fill_day({}, carry, list(range(24))))[("s1", "e5")]
        self.assertEqual(series, [1.65] * 24)

    def test_a_short_dst_day_yields_only_its_real_hours(self):
        carry = {("s1", "e5"): 1.70}
        hours = build.valid_hours(date(2024, 3, 31))
        series = dict(build.fill_day({}, carry, hours))[("s1", "e5")]
        self.assertEqual(len(series), 23)


class Normalization(unittest.TestCase):
    def setUp(self):
        self.weekly = [[[0] * build.BIN_COUNT for _ in range(24)] for _ in range(7)]
        self.daily = [[0] * build.BIN_COUNT for _ in range(24)]

    def test_deviations_are_measured_against_that_days_own_mean(self):
        # A flat 2.00 day and a flat 1.00 day must both contribute zero, which
        # is what removes the long-term oil price from the result.
        for level in (1.00, 2.00):
            build.accumulate([level] * 24, list(range(24)), 0, self.weekly, self.daily)
        self.assertEqual(build.median_of(self.daily[7]), 0.0)

    def test_a_fragmentary_station_day_is_discarded(self):
        series = [1.70] * 10 + [None] * 14
        counted = build.accumulate(series, list(range(24)), 0, self.weekly, self.daily)
        self.assertEqual(counted, 0, "a day with 10 known hours must not set a daily mean")

    def test_the_histogram_median_matches_a_known_distribution(self):
        # 0.01 five times, 0.03 once: the median is 0.01, while the mean is not.
        histogram = [0] * build.BIN_COUNT
        histogram[build.BIN_ZERO + 10] = 5
        histogram[build.BIN_ZERO + 30] = 1
        self.assertEqual(build.median_of(histogram), 0.01)

    def test_an_empty_bucket_has_no_median_rather_than_a_zero(self):
        self.assertIsNone(build.median_of([0] * build.BIN_COUNT))


def write_archive(root, days, shape):
    """A tiny synthetic archive: two stations, `days` days, `shape[hour]` cents
    above that day's level."""
    for offset in range(days):
        day = date(2024, 6, 3) + timedelta(days=offset)
        folder = root / "prices" / f"{day.year:04d}" / f"{day.month:02d}"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{day.isoformat()}-prices.csv"
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("date,station_uuid,diesel,e5,e10,dieselchange,e5change,e10change\n")
            for hour in range(24):
                for index, station in enumerate(("aaa", "bbb")):
                    base = 1.60 + 0.30 * index + 0.002 * offset
                    price = base + shape[hour]
                    stamp = f"{day.isoformat()} {hour:02d}:05:00+02"
                    handle.write(f"{stamp},{station},{price:.3f},{price + 0.1:.3f},{price + 0.05:.3f},1,1,1\n")


SAWTOOTH = [
    0.03, 0.03, 0.03, 0.03, 0.04, 0.05, 0.06, 0.06, 0.05, 0.03, 0.02, 0.01,
    0.00, -0.01, -0.01, -0.02, -0.02, -0.03, -0.04, -0.05, -0.06, -0.05, -0.03, 0.01,
]
FLAT = [0.0] * 24


class EndToEnd(unittest.TestCase):
    def test_a_sawtooth_archive_produces_a_sawtooth_curve(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_archive(root, 14, SAWTOOTH)
            stats = build.build(root, "2024-06", "2024-06", verbose=False)

            self.assertEqual(stats["window"]["days"], 14)
            for fuel in build.FUELS:
                curve = stats["byHour"][fuel]
                self.assertEqual(len(curve), 24)
                self.assertGreater(curve[7], 0, f"{fuel} mornings should be dear")
                self.assertLess(curve[20], 0, f"{fuel} evenings should be cheap")
                self.assertEqual(stats["cheapestHour"][fuel], 20)
                self.assertEqual(len(stats["byHourWeekday"][fuel]), 7)
                self.assertEqual(len(stats["byHourWeekday"][fuel][0]), 24)

            self.assertEqual(build.check_sawtooth(stats), [])

    def test_the_rising_oil_price_does_not_reach_the_output(self):
        # The fixture drifts 0.2 cents per day and the two stations are 30
        # cents apart. Neither may appear in a curve that is only about the
        # shape of the day.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_archive(root, 14, SAWTOOTH)
            stats = build.build(root, "2024-06", "2024-06", verbose=False)
            curve = stats["byHour"]["e5"]
            self.assertAlmostEqual(curve[7], SAWTOOTH[7] - sum(SAWTOOTH) / 24, places=2)

    def test_a_flat_archive_is_refused_rather_than_published(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_archive(root, 7, FLAT)
            stats = build.build(root, "2024-06", "2024-06", verbose=False)
            problems = build.check_sawtooth(stats)
            self.assertTrue(problems, "a flat day curve must fail the sanity gate")
            self.assertTrue(any("too flat" in p or "not above" in p for p in problems))

    def test_the_build_is_deterministic(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_archive(root, 7, SAWTOOTH)
            first = build.serialize(build.build(root, "2024-06", "2024-06", verbose=False))
            second = build.serialize(build.build(root, "2024-06", "2024-06", verbose=False))
            self.assertEqual(first, second)
            json.loads(first)

    def test_a_missing_archive_fails_loudly(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(SystemExit):
                build.build(Path(tmp), "2024-06", "2024-06", verbose=False)


if __name__ == "__main__":
    unittest.main(verbosity=2, argv=[sys.argv[0]])
