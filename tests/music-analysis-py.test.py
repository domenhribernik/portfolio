#!/usr/bin/env python3
"""Unit tests for the music analysis engine (app/scripts/music_analysis.py).

Fast suite: synthesized audio with a known key/progression plus the pure
sequence and label logic. The real-MP3 accuracy corpus is a separate,
opt-in suite (MUSIC_CORPUS=1, see music-corpus-py.test.py).

    python3 tests/music-analysis-py.test.py
"""

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app', 'scripts'))

import music_analysis as ma  # noqa: E402

SR = 22050

# ---------------------------------------------------------------------------
# Synthesis: a plucked-string-ish rendering of a chord progression.
# Voicings are written the way a guitarist would play them so the bass note is
# the chord root, which is what the analyzer's bass chroma keys off.
# ---------------------------------------------------------------------------

NOTE_TO_PC = {'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'F': 5,
              'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11}


def voicing(name):
    """MIDI notes for a chord name, root in the bass."""
    quality = 'min' if name.endswith('m') else 'maj'
    root_name = name[:-1] if quality == 'min' else name
    pc = NOTE_TO_PC[root_name]
    third = 3 if quality == 'min' else 4
    bass = 40 + ((pc - 4) % 12)          # E2..Eb3, guitar-ish bass register
    upper = 52 + ((pc - 4) % 12)         # E3..Eb4
    return [bass, upper, upper + third, upper + 7, upper + 12]


def pluck(midi, dur, sr=SR, amp=1.0):
    n = int(dur * sr)
    t = np.arange(n) / sr
    freq = 440.0 * 2 ** ((midi - 69) / 12.0)
    out = np.zeros(n)
    for h in range(1, 9):
        if freq * h > sr / 2 - 100:
            break
        out += (1.0 / h ** 1.3) * np.sin(2 * np.pi * freq * h * t + h * 0.7)
    env = np.exp(-t * 2.2) * (1 - np.exp(-t * 300))
    return out * env * amp


def render(chords, bpm=100, beats_per_chord=4, sr=SR, seed=7, drums=True, noise=0.002):
    """Render a chord sequence as strummed chords over a simple drum bed."""
    rng = np.random.default_rng(seed)
    beat = 60.0 / bpm
    chord_dur = beat * beats_per_chord
    total = int(len(chords) * chord_dur * sr) + sr
    buf = np.zeros(total)

    for i, name in enumerate(chords):
        start = int(i * chord_dur * sr)
        notes = voicing(name)
        # one strum per beat, alternating full / partial like a guitar pattern
        for b in range(beats_per_chord):
            at = start + int(b * beat * sr)
            amp = 1.0 if b % 2 == 0 else 0.65
            for j, midi in enumerate(notes):
                off = at + int(j * 0.012 * sr)
                seg = pluck(midi, chord_dur, sr, amp * (1.0 if j == 0 else 0.8))
                end = min(total, off + len(seg))
                buf[off:end] += seg[:end - off]

    if drums:
        for b in range(int(len(chords) * beats_per_chord)):
            at = int(b * beat * sr)
            kick = np.exp(-np.arange(int(0.12 * sr)) / sr * 30) * \
                np.sin(2 * np.pi * 55 * np.arange(int(0.12 * sr)) / sr)
            end = min(total, at + len(kick))
            buf[at:end] += kick[:end - at] * 1.4
            hat = rng.standard_normal(int(0.05 * sr)) * \
                np.exp(-np.arange(int(0.05 * sr)) / sr * 90)
            end = min(total, at + len(hat))
            buf[at:end] += hat[:end - at] * 0.25

    buf += rng.standard_normal(total) * noise
    peak = np.abs(buf).max()
    return (buf / peak * 0.8) if peak > 0 else buf


class KeyConfidence(unittest.TestCase):
    def test_an_ambiguous_song_is_less_confident_than_a_clear_one(self):
        """Confidence has to move, or it is decoration.

        A I-V-vi-IV with a dominant resolving home names its key outright; a
        bare two chord vamp shared by a relative pair does not, and the page
        should say so rather than print the same number either way.
        """
        clear = ma.analyze(render(['Am', 'G', 'F', 'E'] * 4, bpm=100), SR)
        vamp = ma.analyze(render(['Am', 'C'] * 8, bpm=100), SR)
        self.assertEqual(clear['key']['name'], 'A minor')
        self.assertGreater(clear['key']['confidence'], vamp['key']['confidence'],
                           'a dominant naming the key should read as more certain '
                           'than a vamp two keys share')
        for result in (clear, vamp):
            self.assertGreaterEqual(result['key']['confidence'], 0.0)
            self.assertLessEqual(result['key']['confidence'], 1.0)


class ChordCoverage(unittest.TestCase):
    """N.C. must mean "nothing is playing", not "the mix is dense"."""

    def test_silence_is_a_gap_and_music_is_not(self):
        music = render(['C', 'G', 'Am', 'F'] * 2, bpm=100)
        gap = np.zeros(int(4.0 * SR))
        audio = np.concatenate([music, gap, music])
        result = ma.analyze(audio, SR)
        segments = result['segments']
        self.assertTrue(segments, result['warnings'])

        played = sum(s['duration'] for s in segments if s['chord'] != 'N.C.')
        total = sum(s['duration'] for s in segments)
        self.assertGreater(played / total, 0.8,
                           f'too much of the song went unlabelled: {segments}')

        gap_start = len(music) / SR
        covering = [s for s in segments
                    if s['time'] <= gap_start + 2.0 < s['time'] + s['duration']]
        self.assertEqual([s['chord'] for s in covering], ['N.C.'],
                         'the silent passage should read as a gap')

    def test_a_noisy_mix_is_still_chorded(self):
        """The gap test must not be a threshold tuned to clean studio audio."""
        audio = render(['Am', 'F', 'C', 'G'] * 3, bpm=92, noise=0.09)
        result = ma.analyze(audio, SR)
        segments = result['segments']
        played = sum(s['duration'] for s in segments if s['chord'] != 'N.C.')
        total = sum(s['duration'] for s in segments)
        self.assertGreater(played / total, 0.8,
                           f'a noisy mix went mostly unlabelled: '
                           f'{[(s["chord"], round(s["duration"], 1)) for s in segments]}')


class KeyFromAudio(unittest.TestCase):
    def test_major_progression_reports_its_own_key(self):
        # I-V-vi-IV in C major, four times over.
        audio = render(['C', 'G', 'Am', 'F'] * 4, bpm=100)
        result = ma.analyze(audio, SR)
        self.assertIsNotNone(result['key'], result['warnings'])
        self.assertEqual(result['key']['name'], 'C major')

    def test_relative_pairs_are_told_apart_by_where_the_loop_rests(self):
        """C major and A minor share all seven chords; only structure separates them.

        Same four triads either way: what decides is which one the loop starts
        and ends on, and which one holds the most time.
        """
        major = ma.analyze(render(['C', 'Am', 'F', 'G'] * 4, bpm=104), SR)
        minor = ma.analyze(render(['Am', 'F', 'C', 'G'] * 4, bpm=104), SR)
        self.assertEqual(major['key']['name'], 'C major')
        self.assertEqual(minor['key']['name'], 'A minor')

    def test_a_dominant_chord_marks_the_minor_key(self):
        """E major has no place in C major; against Am it is the V that names the key."""
        result = ma.analyze(render(['Am', 'G', 'F', 'E'] * 4, bpm=96), SR)
        self.assertEqual(result['key']['name'], 'A minor')


class TempoAndMeter(unittest.TestCase):
    def test_tempo_matches_the_rendered_beat(self):
        result = ma.analyze(render(['C', 'G', 'Am', 'F'] * 4, bpm=96), SR)
        self.assertIsNotNone(result['tempo'], result['warnings'])
        self.assertAlmostEqual(result['tempo']['bpm'], 96, delta=3.5)

    def test_a_faster_song_is_not_reported_at_half_speed(self):
        result = ma.analyze(render(['Am', 'F', 'C', 'G'] * 5, bpm=140), SR)
        self.assertAlmostEqual(result['tempo']['bpm'], 140, delta=5)

    def test_four_four_is_reported_for_a_four_beat_bar(self):
        result = ma.analyze(render(['C', 'G', 'Am', 'F'] * 4, bpm=110), SR)
        self.assertEqual(result['time_signature']['value'], '4/4')


class SeventhChords(unittest.TestCase):
    """Sevenths are reported only when the extra tone is really there."""

    def test_a_plain_triad_is_not_dressed_up(self):
        result = ma.analyze(render(['C', 'G', 'Am', 'F'] * 4, bpm=100), SR)
        names = {s['chord'] for s in result['segments']}
        self.assertFalse([n for n in names if '7' in n],
                         f'invented sevenths on plain triads: {names}')


class ResultContract(unittest.TestCase):
    """What the analysis page reads off the payload."""

    def test_every_field_the_page_renders_is_present(self):
        result = ma.analyze(render(['Am', 'F', 'C', 'G'] * 4, bpm=100), SR)
        for field in ('tempo', 'time_signature', 'key', 'chords', 'degrees',
                      'scales', 'improvise', 'capo', 'tuning_cents',
                      'duration_analyzed', 'warnings'):
            self.assertIn(field, result)
        self.assertIn('progression', result['chords'])
        self.assertIn('timeline', result['chords'])
        self.assertEqual({d['chord'] for d in result['degrees']},
                         set(result['chords']['progression']))
        self.assertIn('relative', result['key'])
        for event in result['chords']['timeline']:
            self.assertEqual(sorted(event), ['chord', 'time'])

    def test_a_detuned_recording_is_reported_in_concert_pitch(self):
        """A song mastered a quarter tone sharp is still the same key."""
        audio = render(['C', 'G', 'Am', 'F'] * 4, bpm=100)
        # resample by 2^(0.30/12): the same take, 30 cents sharp
        ratio = 2 ** (0.30 / 12)
        index = np.arange(0, len(audio) - 1, ratio)
        sharp = np.interp(index, np.arange(len(audio)), audio)
        result = ma.analyze(sharp, SR)
        self.assertEqual(result['key']['name'], 'C major')
        self.assertAlmostEqual(result['tuning_cents'], 30, delta=12)


def seg(chord, duration=2.0, start=0.0):
    root, quality, _suffix = ma.parse_chord(chord)
    return {'time': start, 'chord': chord, 'root': root, 'quality': quality,
            'duration': duration, '_weight': duration}


def seq(chords, duration=2.0):
    out, t = [], 0.0
    for c in chords:
        out.append(seg(c, duration, t))
        t += duration
    return out


class Progression(unittest.TestCase):
    """The loop a guitarist would write on the page, in playing order."""

    def test_finds_the_repeating_loop(self):
        segments = seq(['C', 'G', 'Am', 'F'] * 5)
        self.assertEqual(ma.extract_progression(segments, 0, 'major'),
                         ['C', 'G', 'Am', 'F'])

    def test_rotates_the_loop_to_start_on_the_tonic(self):
        """Where the analyzer happened to come in is not where the loop starts."""
        segments = seq(['Am', 'F', 'C', 'G'] * 5)
        self.assertEqual(ma.extract_progression(segments, 0, 'major'),
                         ['C', 'G', 'Am', 'F'])
        self.assertEqual(ma.extract_progression(segments, 9, 'minor'),
                         ['Am', 'F', 'C', 'G'])

    def test_gaps_and_one_off_blips_do_not_break_the_loop(self):
        segments = seq(['C', 'G', 'N.C.', 'Am', 'F', 'C', 'G', 'Am', 'F',
                        'C', 'G', 'Am', 'F', 'Eb', 'C', 'G', 'Am', 'F'])
        self.assertEqual(ma.extract_progression(segments, 0, 'major'),
                         ['C', 'G', 'Am', 'F'])

    def test_a_six_chord_loop_is_not_truncated_to_four(self):
        segments = seq(['C', 'G', 'Am', 'Em', 'F', 'G'] * 4)
        self.assertEqual(ma.extract_progression(segments, 0, 'major'),
                         ['C', 'G', 'Am', 'Em', 'F', 'G'])

    def test_a_loop_that_is_itself_a_repeat_is_reported_once(self):
        """Dm-Bb-Dm-Bb is a two chord loop written twice."""
        segments = seq(['Dm', 'Bb'] * 8)
        self.assertEqual(ma.extract_progression(segments, 2, 'minor'), ['Dm', 'Bb'])

    def test_a_longer_window_winning_does_not_double_the_loop(self):
        """One wrong chord at the end makes the four bar window score best.

        It still describes a two chord loop, and that is what should be printed.
        """
        segments = seq(['Dm', 'Bb', 'Dm', 'Bb', 'Dm', 'Bb', 'Dm', 'F'])
        self.assertEqual(ma.extract_progression(segments, 2, 'minor'), ['Dm', 'Bb'])

    def test_a_song_with_no_loop_still_reports_its_chords_in_order(self):
        segments = seq(['C', 'F', 'G', 'Dm', 'Bb', 'Am', 'E'])
        got = ma.extract_progression(segments, 0, 'major')
        self.assertEqual(got[:4], ['C', 'F', 'G', 'Dm'])

    def test_a_seventh_on_one_pass_does_not_split_the_loop(self):
        """Am and Am7 are the same chord of the progression.

        The seventh refinement relabels segment by segment, so the same chord
        can come back spelled differently on a later pass. Matching on the
        literal name makes the loop look like it never repeats.
        """
        segments = seq(['C', 'G', 'Am', 'F', 'C', 'G', 'Am7', 'F',
                        'C', 'G', 'Am', 'F', 'Cmaj7', 'G', 'Am', 'F'])
        self.assertEqual(ma.extract_progression(segments, 0, 'major'),
                         ['C', 'G', 'Am', 'F'])

    def test_the_loop_keeps_a_seventh_the_song_really_holds(self):
        """When a chord is mostly played as a seventh, say so."""
        segments = seq(['C', 'G', 'Am7', 'F', 'C', 'G', 'Am7', 'F',
                        'C', 'G', 'Am7', 'F', 'C', 'G', 'Am', 'F'])
        self.assertEqual(ma.extract_progression(segments, 0, 'major'),
                         ['C', 'G', 'Am7', 'F'])

    def test_a_held_chord_outweighs_a_passing_one(self):
        """Duration decides the loop, not how many times a label appears."""
        segments = seq(['C'] * 1 + ['G'] * 1, duration=8.0) + seq(['Am', 'F'] * 6, duration=0.5)
        self.assertIn('C', ma.extract_progression(segments, 0, 'major'))


class RomanNumerals(unittest.TestCase):
    def test_major_key_degrees(self):
        degrees = ma.chord_degrees(['C', 'G', 'Am', 'F'], 0, 'major')
        self.assertEqual([d['degree'] for d in degrees], ['I', 'V', 'vi', 'IV'])
        self.assertTrue(all(d['diatonic'] for d in degrees))

    def test_minor_key_degrees(self):
        degrees = ma.chord_degrees(['Am', 'F', 'C', 'G'], 9, 'minor')
        self.assertEqual([d['degree'] for d in degrees], ['i', 'VI', 'III', 'VII'])

    def test_a_borrowed_chord_is_labelled_and_flagged(self):
        degrees = ma.chord_degrees(['C', 'Eb', 'E'], 0, 'major')
        self.assertEqual(degrees[1]['degree'], 'bIII')
        self.assertFalse(degrees[1]['diatonic'])
        self.assertEqual(degrees[2]['degree'], 'III')
        self.assertFalse(degrees[2]['diatonic'], 'E major is not the iii of C major')

    def test_a_chord_with_no_third_takes_the_keys_own_quality(self):
        """Esus4 has no third, so it cannot be the 'I' of an E minor song.

        Reading a third-less chord as major prints an uppercase numeral that
        contradicts the key stated two lines above it on the page.
        """
        degrees = ma.chord_degrees(['Em', 'Esus4', 'A5'], 4, 'minor')
        self.assertEqual(degrees[1]['degree'], 'i')
        self.assertTrue(degrees[1]['diatonic'])
        self.assertEqual(degrees[2]['degree'], 'iv')

    def test_the_major_five_of_a_minor_key_is_not_called_borrowed_twice_over(self):
        degrees = ma.chord_degrees(['Am', 'E'], 9, 'minor')
        self.assertEqual(degrees[1]['degree'], 'V')


class CapoAndScales(unittest.TestCase):
    def test_open_keys_need_no_capo(self):
        self.assertEqual(ma.capo_suggestion(7, 'major')['position'], 0)

    def test_a_capo_turns_an_awkward_key_into_open_shapes(self):
        suggestion = ma.capo_suggestion(5, 'major')      # F major
        self.assertEqual(suggestion['position'], 1)
        self.assertIn('E', suggestion['note'])

    def test_a_minor_key_capos_to_a_minor_shape(self):
        suggestion = ma.capo_suggestion(11, 'minor')     # B minor
        self.assertEqual(suggestion['position'], 2)
        self.assertIn('Am', suggestion['note'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
