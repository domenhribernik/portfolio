#!/usr/bin/env python3
"""Musician-oriented audio analysis for the music view.

Usage: python3 analyze_audio.py /path/to/song.mp3

Prints a single JSON object to stdout and nothing else, ever: the controller
runs this with 2>&1 and parses the lot as JSON, so a stray warning on stderr
would read as a failed analysis. Decoding is delegated to the system ffmpeg
binary; the analysis itself lives in music_analysis.py, which is pure numpy and
IO-free so it can be unit tested from a synthesized signal.
"""

import json
import os
import subprocess
import sys
import warnings

warnings.simplefilter('ignore')

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np  # noqa: E402

import music_analysis  # noqa: E402

MAX_SECONDS = 180          # analyze at most the first 3 minutes
MIN_SECONDS = 5


def fail(message):
    print(json.dumps({'ok': False, 'error': message}))
    sys.exit(0)


def decode_audio(path):
    cmd = ['ffmpeg', '-v', 'error', '-i', path, '-t', str(MAX_SECONDS),
           '-ac', '1', '-ar', str(music_analysis.SR), '-f', 'f32le', '-']
    # When called from XAMPP's PHP, LD_LIBRARY_PATH points at /opt/lampp/lib,
    # whose ancient libstdc++ breaks the system ffmpeg. Give ffmpeg a clean env.
    env = {k: v for k, v in os.environ.items() if k != 'LD_LIBRARY_PATH'}
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=120, env=env)
    except FileNotFoundError:
        fail('ffmpeg is not installed on the server')
    except subprocess.TimeoutExpired:
        fail('Audio decoding timed out')
    if proc.returncode != 0 or len(proc.stdout) < 4:
        detail = proc.stderr.decode('utf-8', 'replace').strip().splitlines()
        fail('Could not decode the file as audio. '
             + (detail[-1] if detail else 'Is it a valid MP3?'))
    return np.frombuffer(proc.stdout, dtype=np.float32).astype(np.float64)


def main():
    if len(sys.argv) != 2:
        fail('Usage: analyze_audio.py <audio file>')

    audio = decode_audio(sys.argv[1])
    if len(audio) / music_analysis.SR < MIN_SECONDS:
        fail(f'Audio is too short to analyze (need at least {MIN_SECONDS} seconds)')

    try:
        result = music_analysis.analyze(audio, music_analysis.SR)
    except Exception as e:  # noqa: BLE001 - the page would rather have the reason
        fail(f'Analysis failed: {e}')

    result.pop('segments', None)     # internal working state, not part of the payload
    result['ok'] = True
    print(json.dumps(result))


if __name__ == '__main__':
    main()
