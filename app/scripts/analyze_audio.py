#!/usr/bin/env python3
"""Musician-oriented MP3 analysis for the music view.

Usage: python3 analyze_audio.py /path/to/song.mp3

Prints a single JSON object to stdout. Decoding is delegated to the system
ffmpeg binary; all DSP is plain numpy (no librosa or other audio packages).
Every analysis stage is independent: if one fails, its field is null and a
warning is appended, so partial results still reach the frontend.
"""

import json
import math
import os
import subprocess
import sys

import numpy as np

SR = 22050
N_FFT = 2048
HOP = 512
MAX_SECONDS = 180          # analyze at most the first 3 minutes
FRAME_RATE = SR / HOP

NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

# Krumhansl-Kessler key profiles
KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]

# Diatonic triads: semitone offset from tonic -> (roman numeral, quality)
DIATONIC_MAJOR = {0: ('I', 'maj'), 2: ('ii', 'min'), 4: ('iii', 'min'), 5: ('IV', 'maj'),
                  7: ('V', 'maj'), 9: ('vi', 'min'), 11: ('vii°', 'dim')}
DIATONIC_MINOR = {0: ('i', 'min'), 2: ('ii°', 'dim'), 3: ('III', 'maj'), 5: ('iv', 'min'),
                  7: ('v', 'min'), 8: ('VI', 'maj'), 10: ('VII', 'maj')}

# Fallback numerals for borrowed chords, by offset from the tonic
CHROMATIC_DEGREES_MAJOR = ['I', 'bII', 'II', 'bIII', 'III', 'IV', 'bV', 'V', 'bVI', 'VI', 'bVII', 'VII']
CHROMATIC_DEGREES_MINOR = ['I', 'bII', 'II', 'III', '#III', 'IV', 'bV', 'V', 'VI', '#VI', 'VII', '#VII']

OPEN_MAJOR_PCS = {0, 2, 4, 7, 9}   # C, D, E, G, A: comfy open major shapes
OPEN_MINOR_PCS = {2, 4, 9}         # Dm, Em, Am


def fail(message):
    print(json.dumps({'ok': False, 'error': message}))
    sys.exit(0)


def decode_audio(path):
    cmd = ['ffmpeg', '-v', 'error', '-i', path, '-t', str(MAX_SECONDS),
           '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-']
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
        fail('Could not decode the file as audio. ' + (detail[-1] if detail else 'Is it a valid MP3?'))
    return np.frombuffer(proc.stdout, dtype=np.float32).astype(np.float64)


def stft_magnitude(audio):
    n_frames = 1 + (len(audio) - N_FFT) // HOP
    window = np.hanning(N_FFT)
    frames = np.lib.stride_tricks.as_strided(
        audio,
        shape=(n_frames, N_FFT),
        strides=(audio.strides[0] * HOP, audio.strides[0]),
    )
    return np.abs(np.fft.rfft(frames * window, axis=1)).T  # (bins, frames)


def onset_envelope(mag):
    log_mag = np.log1p(10.0 * mag)
    flux = np.diff(log_mag, axis=1)
    flux[flux < 0] = 0
    env = flux.sum(axis=0)
    kernel = np.hanning(5)
    env = np.convolve(env, kernel / kernel.sum(), mode='same')
    env -= env.mean()
    return env


def detect_tempo(env):
    n = len(env)
    if n < int(FRAME_RATE * 8):
        raise ValueError('not enough audio for tempo detection')
    ac = np.correlate(env, env, mode='full')[n - 1:]
    ac /= (ac[0] + 1e-12)

    min_lag = max(2, int(FRAME_RATE * 60 / 210))
    max_lag = min(n - 2, int(FRAME_RATE * 60 / 50))
    lags = np.arange(min_lag, max_lag + 1)
    bpms = 60.0 * FRAME_RATE / lags
    # log-normal prior pulling toward typical song tempos (~115 BPM)
    prior = np.exp(-0.5 * ((np.log2(bpms / 115.0)) / 0.9) ** 2)
    scores = ac[min_lag:max_lag + 1] * prior

    best = int(np.argmax(scores))
    lag = lags[best]
    # parabolic interpolation for sub-frame precision
    if 0 < best < len(scores) - 1:
        a, b, c = scores[best - 1], scores[best], scores[best + 1]
        denom = a - 2 * b + c
        if abs(denom) > 1e-12:
            lag = lag + 0.5 * (a - c) / denom
    bpm = 60.0 * FRAME_RATE / lag

    peak = float(scores[best])
    baseline = float(np.mean(np.abs(scores))) + 1e-12
    ratio = peak / baseline
    confidence = 'high' if ratio > 3 else 'medium' if ratio > 1.8 else 'low'
    return bpm, lag, confidence


def beat_grid(env, lag):
    """Pick the beat phase that maximizes onset energy, return beat frame indices."""
    n = len(env)
    best_phase, best_score = 0.0, -np.inf
    for phase in np.arange(0.0, lag, max(lag / 16.0, 1.0)):
        idx = np.arange(phase, n - 1, lag).astype(int)
        score = env[idx].mean() if len(idx) else -np.inf
        if score > best_score:
            best_score, best_phase = score, phase
    return np.arange(best_phase, n - 1, lag).astype(int)


def estimate_meter(env, beats):
    if len(beats) < 12:
        raise ValueError('not enough beats for meter estimation')
    strengths = env[beats]
    strengths = strengths - strengths.min()
    mean_all = strengths.mean() + 1e-12

    def contrast(m):
        groups = [strengths[p::m].mean() for p in range(m)]
        return max(groups) / mean_all

    c3, c4 = contrast(3), contrast(4)
    # mild prior toward 4/4, by far the most common meter
    if c3 > c4 * 1.12:
        value, margin = '3/4', c3 / (c4 + 1e-12)
    else:
        value, margin = '4/4', c4 / (c3 + 1e-12)
    confidence = 'high' if margin > 1.25 else 'medium' if margin > 1.08 else 'low'
    return value, confidence


def chroma_matrix(mag):
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / SR)
    valid = (freqs >= 55.0) & (freqs <= 4200.0)
    midi = 69.0 + 12.0 * np.log2(freqs[valid] / 440.0)
    pcs = np.mod(np.round(midi).astype(int), 12)
    weights = np.log1p(mag[valid, :])

    chroma = np.zeros((12, mag.shape[1]))
    for pc in range(12):
        rows = pcs == pc
        if rows.any():
            chroma[pc] = weights[rows].sum(axis=0)

    frac = midi - np.round(midi)          # tuning deviation per bin, in semitones
    bin_energy = weights.sum(axis=1)
    return chroma, frac, bin_energy


def estimate_tuning_cents(frac, bin_energy):
    z = np.sum(bin_energy * np.exp(2j * np.pi * frac))
    if abs(z) < 1e-9:
        raise ValueError('no tonal content')
    return (np.angle(z) / (2 * np.pi)) * 100.0


def detect_key(chroma):
    mean_chroma = chroma.mean(axis=1)
    if mean_chroma.sum() < 1e-9:
        raise ValueError('no tonal content for key detection')

    def correlate(profile, shift):
        return np.corrcoef(np.roll(profile, shift), mean_chroma)[0, 1]

    scores = []
    for tonic in range(12):
        scores.append((correlate(KK_MAJOR, tonic), tonic, 'major'))
        scores.append((correlate(KK_MINOR, tonic), tonic, 'minor'))
    scores.sort(reverse=True)
    best, second = scores[0], scores[1]
    confidence = max(0.0, min(1.0, (best[0] - second[0]) * 4 + 0.5))
    return best[1], best[2], round(confidence, 2)


def chord_templates():
    templates = []
    for root in range(12):
        for quality, intervals in (('maj', (0, 4, 7)), ('min', (0, 3, 7))):
            t = np.zeros(12)
            t[root] = 1.0
            t[(root + intervals[1]) % 12] = 0.9
            t[(root + intervals[2]) % 12] = 0.8
            templates.append((NOTE_NAMES[root] + ('' if quality == 'maj' else 'm'), root, quality, t / np.linalg.norm(t)))
    return templates


def detect_chords(chroma, beats):
    """Beat-synchronous chord recognition via triad template matching."""
    templates = chord_templates()
    bounds = list(beats) + [chroma.shape[1]]
    if len(bounds) < 3:
        raise ValueError('not enough beats for chord detection')

    energy_floor = chroma.sum(axis=0).mean() * 0.2
    raw = []
    for i in range(len(bounds) - 1):
        seg = chroma[:, bounds[i]:bounds[i + 1]]
        if seg.shape[1] == 0:
            continue
        vec = seg.mean(axis=1)
        time = bounds[i] / FRAME_RATE
        if vec.sum() < energy_floor:
            raw.append((time, 'N.C.', None, None))
            continue
        # suppress the broadband floor (drums/noise) so the triad stands out
        vec = np.clip(vec - np.median(vec), 0, None) ** 2
        norm = np.linalg.norm(vec)
        if norm < 1e-9:
            raw.append((time, 'N.C.', None, None))
            continue
        vec = vec / norm
        best = max(templates, key=lambda t: float(vec @ t[3]))
        score = float(vec @ best[3])
        if score < 0.5:
            raw.append((time, 'N.C.', None, None))
        else:
            raw.append((time, best[0], best[1], best[2]))

    # smooth out one-beat blips surrounded by the same chord
    names = [r[1] for r in raw]
    for i in range(1, len(raw) - 1):
        if names[i - 1] == names[i + 1] != names[i]:
            raw[i] = (raw[i][0], raw[i - 1][1], raw[i - 1][2], raw[i - 1][3])

    timeline, info = [], {}
    for time, name, root, quality in raw:
        if name != 'N.C.':
            info[name] = (root, quality)
        if not timeline or timeline[-1]['chord'] != name:
            timeline.append({'time': round(time, 2), 'chord': name})
    return timeline, info


def extract_progression(timeline):
    # collapse repeats that only looked separate because an N.C. gap sat between them
    seq = []
    for e in timeline:
        if e['chord'] != 'N.C.' and (not seq or seq[-1] != e['chord']):
            seq.append(e['chord'])
    if not seq:
        raise ValueError('no chords detected')
    if len(seq) >= 8:
        grams = {}
        for i in range(len(seq) - 3):
            gram = tuple(seq[i:i + 4])
            if len(set(gram)) < 2:
                continue
            grams[gram] = grams.get(gram, 0) + 1
        if grams:
            gram, count = max(grams.items(), key=lambda kv: kv[1])
            if count >= 2:
                return list(gram)
    # fallback: chords ordered by how often they appear
    counts = {}
    for c in seq:
        counts[c] = counts.get(c, 0) + 1
    return sorted(counts, key=counts.get, reverse=True)[:6]


def chord_degrees(progression, chord_info, tonic, mode):
    diatonic = DIATONIC_MAJOR if mode == 'major' else DIATONIC_MINOR
    chromatic = CHROMATIC_DEGREES_MAJOR if mode == 'major' else CHROMATIC_DEGREES_MINOR
    out = []
    for name in progression:
        if name not in chord_info:
            continue
        root, quality = chord_info[name]
        offset = (root - tonic) % 12
        entry = diatonic.get(offset)
        if entry and entry[1] == quality:
            out.append({'chord': name, 'degree': entry[0], 'diatonic': True})
        else:
            numeral = chromatic[offset]
            numeral = numeral.lower() if quality == 'min' else numeral
            out.append({'chord': name, 'degree': numeral, 'diatonic': False})
    return out


def scale_fit(chroma, tonic, mode):
    pcs = MAJOR_SCALE if mode == 'major' else MINOR_SCALE
    mean_chroma = chroma.mean(axis=1)
    total = mean_chroma.sum() + 1e-12
    inside = sum(mean_chroma[(tonic + p) % 12] for p in pcs)
    return round(float(inside / total) * 100.0, 1)


def build_scales_and_tips(tonic, mode, degrees):
    tonic_name = NOTE_NAMES[tonic]
    rel = NOTE_NAMES[(tonic + 9) % 12] + ' minor' if mode == 'major' else NOTE_NAMES[(tonic + 3) % 12] + ' major'
    degree_set = {d['degree'] for d in degrees}

    if mode == 'major':
        scales = [f'{tonic_name} Major (Ionian)', f'{tonic_name} Major Pentatonic']
        tips = [f'{tonic_name} Major Pentatonic is the safe everywhere choice.',
                f'The relative minor, {rel.split()[0]} Minor Pentatonic, hits the same notes with a darker flavor.']
        if 'bVII' in degree_set or 'vii' in degree_set:
            scales.append(f'{tonic_name} Mixolydian')
            tips.append(f'The bVII chord suggests a Mixolydian sound: try {tonic_name} Mixolydian over it.')
    else:
        scales = [f'{tonic_name} Natural Minor (Aeolian)', f'{tonic_name} Minor Pentatonic']
        tips = [f'{tonic_name} Minor Pentatonic works over the whole progression.',
                f'Add the b6 from {tonic_name} Natural Minor for a sadder color.']
        if 'IV' in degree_set:
            scales.append(f'{tonic_name} Dorian')
            tips.append(f'A major IV chord points at Dorian: {tonic_name} Dorian will sound intentional over it.')
        if 'V' in degree_set:
            scales.append(f'{tonic_name} Harmonic Minor')
            tips.append(f'The major V chord comes from {tonic_name} Harmonic Minor; lean on it during that chord.')
        tips.append(f'The relative major is {rel}: the same notes from a brighter angle.')
    return scales, tips, rel


def capo_suggestion(tonic, mode):
    open_set = OPEN_MAJOR_PCS if mode == 'major' else OPEN_MINOR_PCS
    suffix = '' if mode == 'major' else 'm'
    if tonic in open_set:
        return {'position': 0, 'note': f'No capo needed: {NOTE_NAMES[tonic]}{suffix} already has open shapes.'}
    for capo in range(1, 8):
        shape = (tonic - capo) % 12
        if shape in open_set:
            return {'position': capo,
                    'note': f'Capo {capo}: play {NOTE_NAMES[shape]}{suffix}-shape chords to sound in {NOTE_NAMES[tonic]}{suffix}.'}
    return {'position': 0, 'note': 'No comfortable capo position found.'}


def main():
    if len(sys.argv) != 2:
        fail('Usage: analyze_audio.py <audio file>')

    audio = decode_audio(sys.argv[1])
    duration = len(audio) / SR
    if duration < 5:
        fail('Audio is too short to analyze (need at least 5 seconds)')

    result = {'ok': True, 'warnings': [], 'duration_analyzed': round(duration, 1)}

    mag = stft_magnitude(audio)
    env = onset_envelope(mag)
    chroma, frac, bin_energy = chroma_matrix(mag)

    lag = None
    try:
        bpm, lag, conf = detect_tempo(env)
        result['tempo'] = {'bpm': round(float(bpm), 1), 'confidence': conf}
    except Exception as e:
        result['tempo'] = None
        result['warnings'].append(f'Tempo detection failed: {e}')

    beats = beat_grid(env, lag) if lag is not None else np.arange(0, mag.shape[1], int(FRAME_RATE / 2))

    try:
        value, conf = estimate_meter(env, beats)
        result['time_signature'] = {'value': value, 'confidence': conf}
    except Exception as e:
        result['time_signature'] = None
        result['warnings'].append(f'Time signature estimation failed: {e}')

    tonic = mode = None
    try:
        tonic, mode, key_conf = detect_key(chroma)
        suffix = '' if mode == 'major' else 'm'
        result['key'] = {
            'tonic': NOTE_NAMES[tonic],
            'mode': mode,
            'name': f'{NOTE_NAMES[tonic]} {mode}',
            'confidence': key_conf,
            'parallel': f"{NOTE_NAMES[tonic]} {'minor' if mode == 'major' else 'major'}",
        }
    except Exception as e:
        result['key'] = None
        result['warnings'].append(f'Key detection failed: {e}')

    progression, chord_info = None, {}
    try:
        timeline, chord_info = detect_chords(chroma, beats)
        progression = extract_progression(timeline)
        result['chords'] = {'progression': progression, 'timeline': timeline[:150]}
    except Exception as e:
        result['chords'] = None
        result['warnings'].append(f'Chord detection failed: {e}')

    if tonic is not None:
        try:
            degrees = chord_degrees(progression or [], chord_info, tonic, mode)
            scales, tips, relative = build_scales_and_tips(tonic, mode, degrees)
            result['key']['relative'] = relative
            result['degrees'] = degrees
            result['scales'] = {'primary': scales[0], 'suggestions': scales, 'fit_percent': scale_fit(chroma, tonic, mode)}
            result['improvise'] = tips
            result['capo'] = capo_suggestion(tonic, mode)
        except Exception as e:
            result['warnings'].append(f'Scale/degree mapping failed: {e}')
    else:
        result['warnings'].append('Scale suggestions skipped: no key detected.')

    try:
        result['tuning_cents'] = round(float(estimate_tuning_cents(frac, bin_energy)), 1)
    except Exception as e:
        result['tuning_cents'] = None
        result['warnings'].append(f'Tuning estimation failed: {e}')

    print(json.dumps(result))


if __name__ == '__main__':
    main()
