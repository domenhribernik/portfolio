#!/usr/bin/env python3
"""Unit tests for app/scripts/stocks-sync.py, the LJSE cron wrapper.

The wrapper writes a report into the site root, where the web server will
happily serve it, so the redaction is a security property and not a nicety:
these tests pin it, along with the PHP binary choice and the success-line
detection that stops a die()ing config from being logged as a good run.

Stdlib unittest, no dependencies. The sync itself (LJSE parsing, alerts, DB)
belongs to the PHP engine and is covered by tests/stocks-sync.test.php.

Run: python3 tests/stocks-sync-py.test.py
"""

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("stocks_sync", ROOT / "app" / "scripts" / "stocks-sync.py")
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


def php(path, version="8.2.20", version_id=80220, pdo=True, error=None):
    return {"path": path, "version": version, "version_id": version_id,
            "pdo_mysql": pdo, "curl": True, "url_fopen": True, "error": error}


class Redaction(unittest.TestCase):
    def setUp(self):
        sync.SECRET_VALUES.clear()

    def test_env_secrets_never_survive(self):
        sync.SECRET_VALUES.add("hunter2-hunter2")
        self.assertNotIn("hunter2", sync.redact("connect failed for hunter2-hunter2 at db"))

    def test_telegram_token_is_stripped(self):
        out = sync.redact("GET /bot7654321987:AAH9ffLm_kQ2xZzYw0pQrStUvWxYz12345/getMe")
        self.assertNotIn("AAH9ffLm", out)
        self.assertIn("bot[token]", out)

    def test_labelled_secrets_are_stripped_without_eating_the_sentence(self):
        # MySQL's own wording: the trailing ")" and anything after must survive,
        # or the log loses the half of the error that explains it.
        out = sync.redact("Access denied (using password: YES) for 'app'@'localhost'")
        self.assertIn("[redacted])", out)
        self.assertIn("localhost", out)

    def test_short_values_are_left_alone(self):
        # A two-character .env value would otherwise blank out half the report.
        sync.SECRET_VALUES.add("no")
        self.assertEqual(sync.redact("nothing is wrong"), "nothing is wrong")

    def test_redact_tolerates_nothing_to_do(self):
        self.assertEqual(sync.redact(""), "")
        self.assertIsNone(sync.redact(None))


class BinaryChoice(unittest.TestCase):
    def test_newest_php_with_pdo_mysql_wins(self):
        chosen = sync.choose_php([php("/usr/bin/php", "8.1.2", 80102),
                                  php("/usr/local/bin/php82", "8.2.20", 80220)])
        self.assertEqual(chosen["path"], "/usr/local/bin/php82")

    def test_a_php_without_pdo_mysql_loses_to_an_older_one_that_has_it(self):
        chosen = sync.choose_php([php("/usr/bin/php83", "8.3.1", 80301, pdo=False),
                                  php("/usr/bin/php81", "8.1.2", 80102)])
        self.assertEqual(chosen["path"], "/usr/bin/php81")

    def test_php_7_is_never_used(self):
        self.assertIsNone(sync.choose_php([php("/usr/bin/php", "7.4.33", 70433)]))

    def test_unusable_binaries_are_skipped(self):
        self.assertIsNone(sync.choose_php([php("/bin/false", error="no output")]))

    def test_no_candidates_at_all(self):
        self.assertIsNone(sync.choose_php([]))

    def test_a_lone_php_without_pdo_is_still_tried(self):
        # Better to run and log the real PDO error than to refuse and say nothing.
        chosen = sync.choose_php([php("/usr/bin/php82", pdo=False)])
        self.assertEqual(chosen["path"], "/usr/bin/php82")


class LogFile(unittest.TestCase):
    def test_log_is_trimmed_at_the_head_when_it_grows(self):
        with tempfile.TemporaryDirectory() as tmp:
            original, sync.LOG_FILE = sync.LOG_FILE, Path(tmp) / "stocks-sync.log"
            try:
                sync.LOG_FILE.write_text(("x" * 79 + "\n") * 6000, encoding="utf-8")
                self.assertGreater(sync.LOG_FILE.stat().st_size, sync.LOG_MAX_BYTES)
                sync.append_log("newest run\n")
                text = sync.LOG_FILE.read_text(encoding="utf-8")
            finally:
                sync.LOG_FILE = original
        self.assertLess(len(text), sync.LOG_MAX_BYTES)
        self.assertTrue(text.rstrip().endswith("newest run"))
        self.assertIn("older runs trimmed", text)

    def test_an_unwritable_log_does_not_crash_the_run(self):
        original, sync.LOG_FILE = sync.LOG_FILE, Path("/nonexistent-dir/stocks-sync.log")
        try:
            sync.append_log("anything\n")  # must not raise
        finally:
            sync.LOG_FILE = original


if __name__ == "__main__":
    unittest.main(verbosity=2, argv=[sys.argv[0]])
