#!/usr/bin/env python3
"""Accuracy corpus: the analysis engine against real recordings with known keys.

Opt-in, because it decodes and analyzes the whole local track library (~20s) and
needs ffmpeg plus the MP3s, neither of which a checkout is guaranteed to have:

    MUSIC_CORPUS=1 python3 tests/music-corpus-py.test.py

Ground truth lives in fixtures/music-corpus.json and is written from published
chord charts, never from this analyzer's own output. Assertions are hit rates
rather than per-song, so one oddly mastered recording cannot wedge the build
while a real regression still fails it.
"""

import json
import os
import shutil
import subprocess
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'app', 'scripts'))

import music_analysis as ma  # noqa: E402

MUSIC = os.path.join(ROOT, 'assets', 'music')
CORPUS = json.load(open(os.path.join(HERE, 'fixtures', 'music-corpus.json')))['songs']

KEY_PASS_RATE = 0.80        # exact tonic AND mode
CHORD_RECALL = 0.90         # charted chords the analyzer actually found
MIN_COVERAGE = 0.75         # median share of a song that gets a chord, not N.C.
PROGRESSION_PRECISION = 0.70    # chords in the reported loop that are really in the song


def _reason_to_skip():
    if os.environ.get('MUSIC_CORPUS') != '1':
        return 'set MUSIC_CORPUS=1 to run the real-recording accuracy corpus'
    if not shutil.which('ffmpeg'):
        return 'ffmpeg is not installed'
    missing = [s['file'] for s in CORPUS if not os.path.exists(os.path.join(MUSIC, s['file']))]
    if missing:
        return f'{len(missing)} corpus recordings are not in assets/music/'
    return None


SKIP = _reason_to_skip()


def decode(path, seconds=180):
    proc = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', path, '-t', str(seconds),
         '-ac', '1', '-ar', str(ma.SR), '-f', 'f32le', '-'],
        capture_output=True)
    return np.frombuffer(proc.stdout, dtype=np.float32).astype(np.float64)


@unittest.skipIf(SKIP, SKIP or '')
class Corpus(unittest.TestCase):
    results = {}

    @classmethod
    def setUpClass(cls):
        def one(song):
            audio = decode(os.path.join(MUSIC, song['file']))
            return song['file'], ma.analyze(audio, ma.SR)
        with ThreadPoolExecutor(max_workers=max(2, (os.cpu_count() or 4) // 2)) as pool:
            cls.results = dict(pool.map(one, CORPUS))

    def report(self, lines, headline):
        return headline + '\n' + '\n'.join('  ' + line for line in lines)

    def test_key_is_right_for_most_of_the_corpus(self):
        hits, lines = 0, []
        for song in CORPUS:
            key = self.results[song['file']].get('key')
            got = key['name'] if key else 'none'
            ok = got == song['key']
            hits += ok
            if not ok:
                lines.append(f'{os.path.basename(song["file"])}: want {song["key"]}, got {got}')
        rate = hits / len(CORPUS)
        self.assertGreaterEqual(
            rate, KEY_PASS_RATE,
            self.report(lines, f'key accuracy {hits}/{len(CORPUS)} = {rate:.0%}, '
                               f'below the {KEY_PASS_RATE:.0%} bar'))

    def test_the_charted_chords_are_the_ones_found(self):
        found_total, want_total, lines = 0, 0, []
        for song in CORPUS:
            want = song.get('chords')
            if not want:
                continue
            top = self.top_chords(song['file'], len(want) + 3)
            found = [c for c in want if c in top]
            found_total += len(found)
            want_total += len(want)
            if len(found) < len(want):
                lines.append(f'{os.path.basename(song["file"])}: missed '
                             f'{[c for c in want if c not in top]}, found {top}')
        rate = found_total / max(want_total, 1)
        self.assertGreaterEqual(
            rate, CHORD_RECALL,
            self.report(lines, f'chord recall {found_total}/{want_total} = {rate:.0%}, '
                               f'below the {CHORD_RECALL:.0%} bar'))

    def test_songs_are_not_mostly_reported_as_no_chord(self):
        shares, lines = [], []
        for song in CORPUS:
            segments = self.results[song['file']].get('segments') or []
            total = sum(s['duration'] for s in segments) or 1.0
            played = sum(s['duration'] for s in segments if s['chord'] != 'N.C.')
            shares.append(played / total)
            if played / total < 0.5:
                lines.append(f'{os.path.basename(song["file"])}: only '
                             f'{played / total:.0%} of the song got a chord')
        median = float(np.median(shares))
        self.assertGreaterEqual(
            median, MIN_COVERAGE,
            self.report(lines, f'median chord coverage {median:.0%}, '
                               f'below the {MIN_COVERAGE:.0%} bar'))

    def test_the_reported_progression_is_made_of_the_songs_own_chords(self):
        """The loop on the page is what a player copies down, so a chord in it
        that the song does not contain is the most visible kind of wrong."""
        rates, lines = [], []
        for song in CORPUS:
            want = song.get('chords')
            if not want:
                continue
            progression = (self.results[song['file']].get('chords') or {}).get('progression') or []
            if not progression:
                rates.append(0.0)
                lines.append(f'{os.path.basename(song["file"])}: no progression at all')
                continue
            triads = [ma.triad_name(c) for c in progression]
            right = [c for c in triads if c in want]
            rates.append(len(right) / len(triads))
            if len(right) < len(triads):
                lines.append(f'{os.path.basename(song["file"])}: reported {progression}, '
                             f'charted {want}')
        mean = float(np.mean(rates))
        self.assertGreaterEqual(
            mean, PROGRESSION_PRECISION,
            self.report(lines, f'progression precision {mean:.0%}, below the '
                               f'{PROGRESSION_PRECISION:.0%} bar'))

    def test_confidence_separates_the_right_answers_from_the_wrong_ones(self):
        """A number printed beside every key has to mean something.

        If it reads the same on the songs the analyzer got wrong as on the ones
        it nailed, it is worse than absent: it tells a player to trust the page
        exactly when they should not.
        """
        right, wrong = [], []
        for song in CORPUS:
            key = self.results[song['file']].get('key')
            if not key:
                continue
            (right if key['name'] == song['key'] else wrong).append(key['confidence'])
        every = right + wrong
        self.assertGreaterEqual(max(every) - min(every), 0.25,
                                f'confidence barely moves across the corpus: {sorted(every)}')
        if wrong:
            self.assertGreater(sum(right) / len(right), sum(wrong) / len(wrong),
                               f'mean confidence when right {sum(right) / len(right):.2f} '
                               f'is not above when wrong {sum(wrong) / len(wrong):.2f}')

    def top_chords(self, filename, count):
        """Longest-held chords, reduced to their triads.

        Ground truth comes from chord charts, which are written as triads, so a
        detected F#m7 counts as having found the charted F#m: the seventh is a
        refinement of a right answer, not a wrong one. Whether sevenths get
        invented on plain triads is a separate question, pinned by the
        synthesized suite where the true voicing is known.
        """
        totals = {}
        for seg in self.results[filename].get('segments') or []:
            if seg['chord'] == 'N.C.':
                continue
            root, quality, _suffix = ma.parse_chord(seg['chord'])
            if root is None:
                continue
            triad = ma.chord_name(root, quality, flats='b' in seg['chord'][1:2])
            totals[triad] = totals.get(triad, 0) + seg['duration']
        return sorted(totals, key=totals.get, reverse=True)[:count]


if __name__ == '__main__':
    unittest.main(verbosity=2)
