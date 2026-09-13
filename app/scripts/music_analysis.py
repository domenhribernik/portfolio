#!/usr/bin/env python3
"""Musical analysis engine: decoded mono audio in, analysis dict out.

Pure numpy, no librosa. Kept free of file and process IO so the whole pipeline
is unit-testable from a synthesized signal; `analyze_audio.py` is the thin CLI
that decodes with ffmpeg and hands the samples over.

The chain is the standard one for chord recognition, in this order:

    STFT -> tuning estimate -> log-frequency (semitone) spectrogram
         -> spectral whitening -> NNLS harmonic deconvolution to note
            activations -> bass + treble chroma
         -> per-segment chord scoring -> Viterbi -> merged chord segments
         -> key from chord function (not from raw chroma) -> progression

Why NNLS rather than folding FFT bins straight into 12 pitch classes: a chord's
overtones land on other chords' notes (a C major triad's partials sit on G, E
and Bb), so a naive chroma reports the wrong triad and, averaged over a song,
the wrong key. Deconvolving against a harmonic dictionary removes the partials
that a lower note already explains.
"""

import numpy as np

SR = 22050
N_FFT = 8192               # 371 ms window: long enough to resolve bass semitones
HOP = 1024                 # 46 ms
FRAME_RATE = SR / HOP

ONSET_FFT = 2048
ONSET_HOP = 256
ONSET_RATE = SR / ONSET_HOP

MIDI_LOW = 28              # E1
MIDI_HIGH = 100            # E7
N_PITCH = MIDI_HIGH - MIDI_LOW + 1

NOTE_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
NOTE_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']

# Keys conventionally written with flats (by tonic pitch class, per mode).
FLAT_MAJOR = {1, 3, 5, 8, 10}      # Db, Eb, F, Ab, Bb
FLAT_MINOR = {0, 2, 5, 7, 10}      # C, D, F, G, Bb minor

MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]

DIATONIC_MAJOR = {0: ('I', 'maj'), 2: ('ii', 'min'), 4: ('iii', 'min'), 5: ('IV', 'maj'),
                  7: ('V', 'maj'), 9: ('vi', 'min'), 11: ('vii', 'dim')}
DIATONIC_MINOR = {0: ('i', 'min'), 2: ('ii', 'dim'), 3: ('III', 'maj'), 5: ('iv', 'min'),
                  7: ('v', 'min'), 8: ('VI', 'maj'), 10: ('VII', 'maj')}

CHROMATIC_MAJOR = ['I', 'bII', 'II', 'bIII', 'III', 'IV', 'bV', 'V', 'bVI', 'VI', 'bVII', 'VII']
CHROMATIC_MINOR = ['I', 'bII', 'II', 'III', '#III', 'IV', 'bV', 'V', 'VI', '#VI', 'VII', '#VII']

# ---------------------------------------------------------------------------
# Spectra
# ---------------------------------------------------------------------------


def _frames(audio, n_fft, hop):
    n = 1 + (len(audio) - n_fft) // hop
    if n < 1:
        raise ValueError('audio is shorter than one analysis window')
    return np.lib.stride_tricks.as_strided(
        audio, shape=(n, n_fft), strides=(audio.strides[0] * hop, audio.strides[0]))


def stft_magnitude(audio, n_fft=N_FFT, hop=HOP, block=256):
    """Magnitude STFT, computed in blocks so a long window stays cheap in RAM."""
    frames = _frames(audio, n_fft, hop)
    window = np.hanning(n_fft)
    out = np.empty((n_fft // 2 + 1, frames.shape[0]))
    for start in range(0, frames.shape[0], block):
        chunk = frames[start:start + block] * window
        out[:, start:start + chunk.shape[0]] = np.abs(np.fft.rfft(chunk, axis=1)).T
    return out


def estimate_tuning_cents(mag, n_fft=N_FFT, sr=SR):
    """Concert-pitch offset in cents, from interpolated spectral peak positions."""
    avg = mag.mean(axis=1)
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    lo = np.searchsorted(freqs, 80.0)
    hi = np.searchsorted(freqs, 1600.0)
    if hi - lo < 8:
        raise ValueError('not enough spectrum for tuning estimation')

    band = avg[lo - 1:hi + 1]
    peaks = np.where((band[1:-1] > band[:-2]) & (band[1:-1] >= band[2:]))[0] + lo
    if len(peaks) < 4:
        raise ValueError('no spectral peaks for tuning estimation')

    a, b, c = avg[peaks - 1], avg[peaks], avg[peaks + 1]
    denom = a - 2 * b + c
    shift = np.where(np.abs(denom) > 1e-12, 0.5 * (a - c) / np.where(denom == 0, 1, denom), 0.0)
    shift = np.clip(shift, -0.5, 0.5)
    exact = (peaks + shift) * sr / n_fft

    midi = 69.0 + 12.0 * np.log2(exact / 440.0)
    frac = midi - np.round(midi)                 # deviation in semitones
    z = np.sum(b * np.exp(2j * np.pi * frac))
    if abs(z) < 1e-12:
        raise ValueError('no tonal content for tuning estimation')
    return float(np.angle(z) / (2 * np.pi) * 100.0)


def pitch_projection(tuning_cents=0.0, n_fft=N_FFT, sr=SR):
    """(N_PITCH x bins) matrix mapping an FFT frame onto semitone bands."""
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    freqs[0] = 1e-6
    bin_hz = sr / n_fft
    proj = np.zeros((N_PITCH, len(freqs)))
    for i in range(N_PITCH):
        midi = MIDI_LOW + i
        center = 440.0 * 2 ** ((midi - 69) / 12.0) * 2 ** (tuning_cents / 1200.0)
        # a band at least as wide as the FFT's own resolution here, so low
        # pitches (where a semitone is under two bins) still collect energy
        width = max(1.0, 1.6 * 12.0 * np.log2((center + bin_hz) / center))
        delta = 12.0 * np.log2(freqs / center)
        w = np.clip(1.0 - np.abs(delta) / width, 0.0, None)
        total = w.sum()
        if total > 0:
            proj[i] = w / total
    return proj


def log_spectrogram(mag, tuning_cents=0.0):
    return pitch_projection(tuning_cents) @ mag


WHITEN_WINDOW = 9
WHITEN_FLOOR = 0.15


def whiten(spec, window=None, floor=None):
    """Flatten the spectral envelope so what is left is tonal peaks.

    Subtracting a running mean along the pitch axis removes the instrument's
    timbre and the broadband floor drums leave behind. Dividing by that same
    background afterwards is what rescues a dense, heavily limited mix: without
    it a song whose spectrum simply rolls off with pitch produces a chroma that
    slopes from C down to B, which is the shape of the spectrum rather than of
    any chord in the song.
    """
    window = WHITEN_WINDOW if window is None else window
    floor = WHITEN_FLOOR if floor is None else floor
    amp = np.sqrt(np.maximum(spec, 0.0))
    pad = window // 2
    padded = np.pad(amp, ((pad, pad), (0, 0)), mode='edge')
    cum = np.cumsum(padded, axis=0)
    cum = np.vstack([np.zeros((1, spec.shape[1])), cum])
    background = (cum[window:window + spec.shape[0]] - cum[:spec.shape[0]]) / window
    peaks = np.maximum(amp - background, 0.0)
    if floor <= 0:
        return peaks
    return peaks / (background + floor * amp.mean() + 1e-9)


# ---------------------------------------------------------------------------
# Harmonic deconvolution -> note activations -> chroma
# ---------------------------------------------------------------------------

NOTE_LOW = MIDI_LOW
NOTE_HIGH = 96
N_NOTES = NOTE_HIGH - NOTE_LOW + 1
HARMONIC_DECAY = 0.75
N_HARMONICS = 3


def harmonic_dictionary(decay=None, n_harmonics=None):
    """One column per note: its partials laid out on the semitone grid."""
    decay = HARMONIC_DECAY if decay is None else decay
    n_harmonics = N_HARMONICS if n_harmonics is None else n_harmonics
    d = np.zeros((N_PITCH, N_NOTES))
    for j in range(N_NOTES):
        midi = NOTE_LOW + j
        for h in range(1, n_harmonics + 1):
            pos = midi + 12.0 * np.log2(h) - MIDI_LOW
            if pos < 0 or pos > N_PITCH - 1:
                continue
            low = int(np.floor(pos))
            frac = pos - low
            amp = decay ** (h - 1)
            d[low, j] += amp * (1 - frac)
            if low + 1 < N_PITCH:
                d[low + 1, j] += amp * frac
        norm = np.linalg.norm(d[:, j])
        if norm > 0:
            d[:, j] /= norm
    return d


NNLS_ITERATIONS = 25


def nnls_notes(spec, iterations=None):
    """Non-negative activations X with spec ~= D @ X (multiplicative updates)."""
    iterations = NNLS_ITERATIONS if iterations is None else iterations
    d = harmonic_dictionary()
    dts = np.maximum(d.T @ spec, 0.0)
    dtd = d.T @ d
    x = np.full((N_NOTES, spec.shape[1]), 0.1)
    for _ in range(iterations):
        x *= dts / (dtd @ x + 1e-9)
    return x


BASS_RANGE = (NOTE_LOW, 54)        # E1 .. F#3
TREBLE_RANGE = (45, NOTE_HIGH)     # A2 .. C7: low enough to catch the third of
                                   # an open G or E chord, which sits under C3


def fold_chroma(notes, lo, hi):
    """Sum note activations onto pitch classes over a pitch range."""
    chroma = np.zeros((12, notes.shape[1]))
    for j in range(N_NOTES):
        midi = NOTE_LOW + j
        if lo <= midi <= hi:
            chroma[midi % 12] += notes[j]
    return chroma


# ---------------------------------------------------------------------------
# Chord recognition
# ---------------------------------------------------------------------------

# A power chord is a real answer, not a failed triad. Rock guitar plays root and
# fifth with no third at all, and forcing those bars to pick major or minor is
# how a whole song ends up in the wrong mode: the vote is decided by whichever
# third the noise floor happened to favour. Given its own state, such a bar can
# abstain. It is relabelled to the key's own triad before the result is shown,
# because that is the chord a player would write down.
TRIADS = (('maj', (0, 4, 7)), ('min', (0, 3, 7)), ('pow', (0, 7)))
POWER_PENALTY = 0.045
POWER_FUNCTION = 0.8
POWER_TONIC = 0.6
BASS_WEIGHT = 0.55
# N.C. is scored *relative* to how well the segment's best chord stands out from
# the field. An absolute cutoff on template fit is a trap: a dense or quietly
# recorded mix scores lower against every template, so a fixed bar silences half
# the song rather than the parts where nothing is playing.
NC_MARGIN = 0.055
QUIET_RATIO = 0.2
EMISSION_TEMP = 0.06
EXPECTED_CHORD_SECONDS = 1.9
SEGMENT_SECONDS = 0.232


def chord_labels():
    labels = []
    for root in range(12):
        for quality, intervals in TRIADS:
            labels.append((root, quality, intervals))
    return labels


def _templates():
    labels = chord_labels()
    t = np.zeros((len(labels), 12))
    bias = np.zeros(len(labels))
    for i, (root, quality, intervals) in enumerate(labels):
        for iv in intervals:
            t[i, (root + iv) % 12] = 1.0
        t[i] /= np.linalg.norm(t[i])
        if quality == 'pow':
            bias[i] = -POWER_PENALTY
    return labels, t, bias


def _aggregate(treble, bass, bounds, frame_rate):
    """Median-aggregate the chroma between frame boundaries (robust to transients)."""
    if len(bounds) < 3:
        raise ValueError('not enough audio for chord detection')
    t, b, times, durations = [], [], [], []
    for lo, hi in zip(bounds, bounds[1:]):
        if hi <= lo:
            continue
        t.append(np.median(treble[:, lo:hi], axis=1))
        b.append(np.median(bass[:, lo:hi], axis=1))
        times.append(lo / frame_rate)
        durations.append((hi - lo) / frame_rate)
    if len(times) < 2:
        raise ValueError('not enough audio for chord detection')
    return (np.stack(t, axis=1), np.stack(b, axis=1),
            np.array(times), np.array(durations))


def segment_chroma(treble, bass, seconds=SEGMENT_SECONDS, frame_rate=FRAME_RATE):
    """Aggregate frames into short fixed segments."""
    step = max(1, int(round(seconds * frame_rate)))
    bounds = list(range(0, treble.shape[1] + 1, step))
    return _aggregate(treble, bass, bounds, frame_rate)


def beat_segments(treble, bass, beat_times, frame_rate=FRAME_RATE):
    """Aggregate the chroma one beat at a time.

    Chords change on beats, so averaging inside a beat cancels noise without
    blurring across a change, and every boundary the detector can propose is one
    a player would actually count. Falls back to the fixed grid when beat
    tracking did not produce a usable pulse.
    """
    n_frames = treble.shape[1]
    bounds = sorted({0, n_frames} | {int(round(t * frame_rate)) for t in beat_times
                                     if 0 < t * frame_rate < n_frames})
    gaps = np.diff(bounds)
    if len(bounds) < 8 or np.median(gaps) < 2:
        raise ValueError('beat grid is too sparse for chord segmentation')
    return _aggregate(treble, bass, bounds, frame_rate)


def chord_scores(treble_seg, bass_seg, key_prior=None):
    labels, templates, bias = _templates()
    t = treble_seg / (np.linalg.norm(treble_seg, axis=0, keepdims=True) + 1e-9)
    b = bass_seg / (bass_seg.sum(axis=0, keepdims=True) + 1e-9)

    scores = templates @ t + bias[:, None]
    roots = np.array([root for root, _q, _i in labels])
    scores += BASS_WEIGHT * b[roots, :]

    if key_prior is not None:
        scores += key_prior[:, None]

    nc = scores.mean(axis=0) + NC_MARGIN
    energy = treble_seg.sum(axis=0)
    nc[energy < np.median(energy) * QUIET_RATIO] = scores.max(axis=0)[
        energy < np.median(energy) * QUIET_RATIO] + 1.0
    return labels, np.vstack([scores, nc[None, :]])


def viterbi(scores, seg_seconds):
    n_states, n_seg = scores.shape
    logp = scores / EMISSION_TEMP
    stay = float(np.exp(-float(np.median(seg_seconds)) / EXPECTED_CHORD_SECONDS))
    log_stay = np.log(stay)
    log_move = np.log((1.0 - stay) / (n_states - 1))

    delta = logp[:, 0].copy()
    back = np.zeros((n_states, n_seg), dtype=np.int16)
    for t in range(1, n_seg):
        best_prev = int(np.argmax(delta))
        move = delta[best_prev] + log_move
        stay_scores = delta + log_stay
        take_stay = stay_scores >= move
        back[:, t] = np.where(take_stay, np.arange(n_states), best_prev)
        delta = np.where(take_stay, stay_scores, move) + logp[:, t]
        delta -= delta.max()

    path = np.zeros(n_seg, dtype=np.int16)
    path[-1] = int(np.argmax(delta))
    for t in range(n_seg - 1, 0, -1):
        path[t - 1] = back[path[t], t]
    return path


_SUFFIX = {'maj': '', 'min': 'm', 'pow': '5'}


def chord_name(root, quality, flats=False):
    names = NOTE_FLAT if flats else NOTE_SHARP
    return names[root] + _SUFFIX.get(quality, '')


def merge_segments(path, labels, times, durations, scores=None, flats=False):
    """Path of per-segment state ids -> merged chord segments with durations.

    Each segment also carries a `strength`: how far its chord stood out from the
    field of 24. Weak stretches (a drum break, a vocal-only bar) still get a
    label from Viterbi, and letting them vote on the key as loudly as a ringing
    open chord is what pulls the key estimate around.
    """
    if scores is not None:
        field = scores[:-1].mean(axis=0)
        margins = np.maximum(scores[path, np.arange(len(path))] - field, 0.0)
    else:
        margins = np.ones(len(path))

    out = []
    for i, state in enumerate(path):
        if state >= len(labels):
            name, root, quality = 'N.C.', None, None
        else:
            root, quality, _ = labels[state]
            name = chord_name(root, quality, flats)
        weight = float(margins[i]) * float(durations[i])
        if out and out[-1]['chord'] == name:
            out[-1]['duration'] += float(durations[i])
            out[-1]['_weight'] += weight
        else:
            out.append({'time': float(times[i]), 'chord': name, 'root': root,
                        'quality': quality, 'duration': float(durations[i]),
                        '_weight': weight})
    return out


MIN_CHORD_SECONDS = 1.1


def drop_blips(segments, minimum=None):
    """Absorb sub-chord-length segments into whichever neighbour is stronger."""
    minimum = MIN_CHORD_SECONDS if minimum is None else minimum
    if len(segments) < 3:
        return segments
    out = list(segments)
    changed = True
    while changed and len(out) > 2:
        changed = False
        for i in range(1, len(out) - 1):
            if out[i]['duration'] >= minimum:
                continue
            prev, nxt = out[i - 1], out[i + 1]
            keep = prev if prev['duration'] >= nxt['duration'] else nxt
            keep = dict(keep)
            merged = out[:i - 1] + [keep] + out[i + 2:] if prev['chord'] == nxt['chord'] else None
            if merged is not None:
                keep['duration'] = prev['duration'] + out[i]['duration'] + nxt['duration']
                keep['_weight'] = prev['_weight'] + out[i]['_weight'] + nxt['_weight']
                keep['time'] = prev['time']
                out = merged
            else:
                target = i - 1 if prev['duration'] >= nxt['duration'] else i + 1
                out[target] = dict(out[target])
                out[target]['duration'] += out[i]['duration']
                out[target]['_weight'] += out[i]['_weight']
                if target > i:
                    out[target]['time'] = out[i]['time']
                out.pop(i)
            changed = True
            break
    return out


# ---------------------------------------------------------------------------
# Key
# ---------------------------------------------------------------------------

# Temperley's revision of the Krumhansl profiles; steadier on audio than KK.
PROFILE_MAJOR = np.array([5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0])
PROFILE_MINOR = np.array([5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0])

# How much a chord at this offset from the tonic argues for the key.
FUNCTION_MAJOR = {(0, 'maj'): 2.6, (7, 'maj'): 2.2, (5, 'maj'): 2.0, (9, 'min'): 1.6,
                  (2, 'min'): 1.5, (4, 'min'): 1.0, (10, 'maj'): 0.7, (2, 'maj'): 0.3,
                  (0, 'min'): -0.4, (5, 'min'): 0.1}
FUNCTION_MINOR = {(0, 'min'): 2.6, (5, 'min'): 1.9, (7, 'min'): 1.5, (7, 'maj'): 1.8,
                  (8, 'maj'): 1.9, (10, 'maj'): 1.9, (3, 'maj'): 1.7, (2, 'min'): 0.3,
                  (5, 'maj'): 0.6, (0, 'maj'): -0.4, (10, 'min'): 0.1}
OUT_OF_KEY = -1.4
MAX_FUNCTION = 2.6

# What resolving onto the tonic is worth, by the chord you arrive from.
CADENCE_MAJOR = {(7, 'maj'): 1.0, (5, 'maj'): 0.6, (10, 'maj'): 0.5, (2, 'min'): 0.4,
                 (7, 'min'): 0.3}
CADENCE_MINOR = {(7, 'maj'): 1.0, (10, 'maj'): 0.8, (5, 'min'): 0.6, (7, 'min'): 0.5,
                 (8, 'maj'): 0.4}

# A key is not just a set of chords: C major and A minor share all seven of
# them. These weights buy the structural evidence that separates a relative
# pair, which chord the music rests on and resolves to.
KEY_W_FUNCTION = 1.0
KEY_W_TONIC = 1.25
KEY_W_EDGE = 0.45
KEY_W_CADENCE = 0.80
KEY_W_PROFILE = 0.55
KEY_W_BASS = 0.30
KEY_W_THIRD = 0.60
KEY_W_SCALE = 0.60
KEY_CONFIDENCE_SCALE = 0.55


# The order key_feature_vector returns and key_weights multiplies. Keep the two
# in step: they are matched positionally, not by name.
KEY_FEATURES = ('function', 'tonic', 'cadence', 'edge', 'bass', 'third', 'scale', 'profile')


def key_feature_vector(played, total, transitions, n_trans, chroma_norm, bass_norm,
                       tonic, mode):
    """The eight pieces of evidence for one candidate key, before weighting."""
    table = FUNCTION_MAJOR if mode == 'major' else FUNCTION_MINOR
    cadences = CADENCE_MAJOR if mode == 'major' else CADENCE_MINOR
    tonic_quality = 'maj' if mode == 'major' else 'min'

    function = 0.0
    tonic_time = 0.0
    for s in played:
        offset = (s['root'] - tonic) % 12
        if s['quality'] == 'pow':
            # No third: it argues for the key, never for the mode.
            value = POWER_FUNCTION * max(table.get((offset, 'maj'), OUT_OF_KEY),
                                         table.get((offset, 'min'), OUT_OF_KEY))
            if offset == 0:
                tonic_time += s['weight'] * POWER_TONIC
        else:
            value = table.get((offset, s['quality']), OUT_OF_KEY)
            if offset == 0 and s['quality'] == tonic_quality:
                tonic_time += s['weight']
        function += value * s['weight']
    function = function / total / MAX_FUNCTION
    tonic_share = tonic_time / total

    cadence = 0.0
    for (from_root, from_quality), (to_root, to_quality), weight in transitions:
        if (to_root - tonic) % 12 == 0 and to_quality in (tonic_quality, 'pow'):
            cadence += cadences.get(((from_root - tonic) % 12, from_quality), 0.0) * weight
    cadence /= n_trans

    edge = 0.0
    for end in (played[0], played[-1]):
        if (end['root'] - tonic) % 12 == 0 and end['quality'] in (tonic_quality, 'pow'):
            edge += 0.5

    # What the bass player spends the song on is the most direct vote for a
    # tonic there is, and it survives a mislabelled triad above it.
    bass = 0.0 if bass_norm is None else float(bass_norm[tonic])

    # Major or minor is decided by one note: which third the song actually
    # plays. Asking the chroma directly beats reading it off chord labels,
    # because the third is exactly the note a mislabelled triad got wrong.
    major_third = chroma_norm[(tonic + 4) % 12]
    minor_third = chroma_norm[(tonic + 3) % 12]
    balance = (major_third - minor_third) / (major_third + minor_third + 1e-9)
    third = balance if mode == 'major' else -balance

    # How much of the song's tonal energy falls inside these seven notes. This
    # is what separates keys a fifth apart: G major and C major differ by one
    # note, and that note is usually the loudest evidence available.
    degrees = MAJOR_SCALE if mode == 'major' else MINOR_SCALE
    scale = float(sum(chroma_norm[(tonic + p) % 12] for p in degrees)
                  / (chroma_norm.sum() + 1e-9))

    profile = PROFILE_MAJOR if mode == 'major' else PROFILE_MINOR
    rolled = np.roll(profile, tonic)
    rolled = rolled / np.linalg.norm(rolled)

    return np.array([function, tonic_share, cadence, edge, bass, third, scale,
                     float(rolled @ chroma_norm)])


def key_weights():
    return np.array([KEY_W_FUNCTION, KEY_W_TONIC, KEY_W_CADENCE, KEY_W_EDGE,
                     KEY_W_BASS, KEY_W_THIRD, KEY_W_SCALE, KEY_W_PROFILE])


def key_evidence(segments, chroma_mean, bass_mean=None):
    """(24, 8) feature matrix plus the (tonic, mode) each row stands for."""
    played = [dict(s) for s in segments if s['root'] is not None]
    if not played:
        raise ValueError('no chords detected for key estimation')

    # Confidence-weight each chord: duration alone lets a mushy passage the
    # Viterbi had to label anyway outvote the chords a listener actually hears.
    raw = np.array([s.get('_weight', s['duration']) for s in played])
    mean_weight = raw.mean() or 1.0
    scaled = np.clip(raw / mean_weight, 0.25, 2.5)
    for s, w in zip(played, scaled):
        s['weight'] = s['duration'] * float(w)
    total = sum(s['weight'] for s in played) or 1.0

    transitions = []
    for a, b in zip(played, played[1:]):
        if a['root'] == b['root'] and a['quality'] == b['quality']:
            continue
        transitions.append(((a['root'], a['quality']), (b['root'], b['quality']),
                            min(a['weight'], b['weight'])))
    n_trans = sum(w for _a, _b, w in transitions) or 1.0

    chroma_norm = chroma_mean / (np.linalg.norm(chroma_mean) + 1e-9)
    bass_norm = None
    if bass_mean is not None and bass_mean.max() > 0:
        bass_norm = bass_mean / bass_mean.sum()
        bass_norm = bass_norm / (bass_norm.max() + 1e-9)

    candidates = [(tonic, mode) for tonic in range(12) for mode in ('major', 'minor')]
    matrix = np.array([key_feature_vector(played, total, transitions, n_trans,
                                          chroma_norm, bass_norm, tonic, mode)
                       for tonic, mode in candidates])
    return matrix, candidates


def estimate_key(segments, chroma_mean, bass_mean=None):
    matrix, candidates = key_evidence(segments, chroma_mean, bass_mean)
    scores = matrix @ key_weights()
    order = np.argsort(-scores)
    tonic, mode = candidates[int(order[0])]
    spread = float(scores[order[0]] - scores[order[1]])
    # How far clear of the runner-up, not how good the winner looked on its own:
    # in a relative pair both keys score well and only the gap means anything.
    # Saturating this is the difference between a confidence and a decoration.
    confidence = float(np.clip(1.0 - np.exp(-spread / KEY_CONFIDENCE_SCALE), 0.02, 0.99))
    return tonic, mode, round(confidence, 2)


# ---------------------------------------------------------------------------
# Tempo, beats and meter
# ---------------------------------------------------------------------------

TEMPO_MIN, TEMPO_MAX = 50.0, 200.0
TEMPO_CENTRE = 120.0
TEMPO_SPREAD = 0.85


def onset_envelope(audio, n_fft=ONSET_FFT, hop=ONSET_HOP, block=512):
    """Spectral flux at a fine hop: where the mix gets suddenly brighter."""
    frames = _frames(audio, n_fft, hop)
    window = np.hanning(n_fft)
    env = np.zeros(frames.shape[0])
    previous = None
    for start in range(0, frames.shape[0], block):
        chunk = np.abs(np.fft.rfft(frames[start:start + block] * window, axis=1))
        logm = np.log1p(20.0 * chunk)
        if previous is not None:
            env[start] = float(np.maximum(logm[0] - previous, 0).sum())
        diff = np.diff(logm, axis=0)
        np.clip(diff, 0, None, out=diff)
        env[start + 1:start + chunk.shape[0]] = diff.sum(axis=1)
        previous = logm[-1]

    kernel = np.hanning(5)
    env = np.convolve(env, kernel / kernel.sum(), mode='same')
    return env - env.mean()


def detect_tempo(env, rate=ONSET_RATE):
    n = len(env)
    if n < rate * 8:
        raise ValueError('not enough audio for tempo detection')
    ac = np.correlate(env, env, mode='full')[n - 1:]
    ac /= (ac[0] + 1e-12)

    min_lag = max(2, int(rate * 60 / TEMPO_MAX))
    max_lag = min(n - 2, int(rate * 60 / TEMPO_MIN))
    lags = np.arange(min_lag, max_lag + 1)
    bpms = 60.0 * rate / lags
    prior = np.exp(-0.5 * (np.log2(bpms / TEMPO_CENTRE) / TEMPO_SPREAD) ** 2)
    scores = ac[min_lag:max_lag + 1] * prior

    best = int(np.argmax(scores))
    lag = float(lags[best])
    if 0 < best < len(scores) - 1:
        a, b, c = scores[best - 1], scores[best], scores[best + 1]
        denom = a - 2 * b + c
        if abs(denom) > 1e-12:
            lag += 0.5 * float(a - c) / float(denom)

    peak = float(scores[best])
    baseline = float(np.mean(np.abs(scores))) + 1e-12
    ratio = peak / baseline
    confidence = 'high' if ratio > 3 else 'medium' if ratio > 1.8 else 'low'
    return 60.0 * rate / lag, lag, confidence


BEAT_TIGHTNESS = 120.0


def beat_track(env, period):
    """Ellis-style dynamic programming: the beat sequence that best trades
    landing on onsets against keeping a steady period."""
    n = len(env)
    if n < 4 or period < 2:
        raise ValueError('not enough audio for beat tracking')
    local = env / (env.std() + 1e-9)

    window = np.arange(-int(np.round(2 * period)), -int(np.round(period / 2)) + 1)
    if len(window) == 0:
        raise ValueError('degenerate beat period')
    transition = -BEAT_TIGHTNESS * (np.log(-window / period) ** 2)

    score = np.zeros(n)
    back = np.full(n, -1, dtype=np.int64)
    for i in range(n):
        candidates = i + window
        valid = candidates >= 0
        if not valid.any():
            score[i] = local[i]
            continue
        options = score[candidates[valid]] + transition[valid]
        pick = int(np.argmax(options))
        score[i] = local[i] + options[pick]
        back[i] = candidates[valid][pick]

    beats = [int(np.argmax(score))]
    while back[beats[-1]] >= 0:
        beats.append(int(back[beats[-1]]))
    return np.array(beats[::-1])


def estimate_meter(env, beats):
    """Which grouping of beats carries the accent: 4/4 or 3/4."""
    if len(beats) < 12:
        raise ValueError('not enough beats for meter estimation')
    strengths = env[beats]
    strengths = strengths - strengths.min()
    mean_all = strengths.mean() + 1e-12

    def contrast(m):
        return max(strengths[p::m].mean() for p in range(m)) / mean_all

    c3, c4 = contrast(3), contrast(4)
    if c3 > c4 * 1.12:          # mild prior toward 4/4, by far the most common
        value, margin = '3/4', c3 / (c4 + 1e-12)
    else:
        value, margin = '4/4', c4 / (c3 + 1e-12)
    confidence = 'high' if margin > 1.25 else 'medium' if margin > 1.08 else 'low'
    return value, confidence


# ---------------------------------------------------------------------------
# Seventh and suspended refinement
# ---------------------------------------------------------------------------

# An added tone counts only when it is at least this strong next to the triad it
# is being added to. Sevenths are where template matching invents detail, so the
# bar is deliberately high: a wrong Am7 is worse than a plain Am that was right.
ADDED_TONE_RATIO = 0.80
SUS_THIRD_RATIO = 0.62
REFINE_MIN_SECONDS = 1.0


def refine_qualities(segments, treble_seg, times):
    """Upgrade held triads to 7 / maj7 / m7 / sus4 when the tone is really there."""
    out = []
    n = treble_seg.shape[1]
    for s in segments:
        s = dict(s)
        root, quality = s['root'], s['quality']
        if root is None or s['duration'] < REFINE_MIN_SECONDS:
            out.append(s)
            continue
        lo = int(np.searchsorted(times, s['time'] - 1e-6))
        hi = min(n, int(np.searchsorted(times, s['time'] + s['duration'] - 1e-6)))
        if hi - lo < 2:
            out.append(s)
            continue
        chroma = treble_seg[:, lo:hi].mean(axis=1)
        chroma = chroma / (chroma.max() + 1e-9)

        third_iv = 4 if quality == 'maj' else 3
        triad = (chroma[root % 12] + chroma[(root + third_iv) % 12]
                 + chroma[(root + 7) % 12]) / 3.0
        minor7 = chroma[(root + 10) % 12]
        major7 = chroma[(root + 11) % 12]
        fourth = chroma[(root + 5) % 12]
        third = chroma[(root + third_iv) % 12]

        suffix = ''
        suspended = (quality == 'maj' and fourth > triad * ADDED_TONE_RATIO
                     and third < triad * SUS_THIRD_RATIO)
        if suspended:
            suffix = 'sus4'
        elif minor7 > triad * ADDED_TONE_RATIO and minor7 > major7:
            suffix = '7'
        elif quality == 'maj' and major7 > triad * ADDED_TONE_RATIO:
            suffix = 'maj7'
        if suffix:
            s['chord'] = s['chord'] + suffix
            s['suffix'] = suffix
        out.append(s)
    return out


# ---------------------------------------------------------------------------
# Progression, degrees, scales, capo
# ---------------------------------------------------------------------------

MIN_LOOP, MAX_LOOP = 2, 8
FALLBACK_LENGTH = 6


def parse_chord(name):
    """Chord name -> (root pitch class, triad quality, suffix). None for N.C."""
    if not name or name == 'N.C.':
        return None, None, ''
    root = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}.get(name[0])
    if root is None:
        return None, None, ''
    i = 1
    while i < len(name) and name[i] in '#b':
        root = (root + (1 if name[i] == '#' else -1)) % 12
        i += 1
    rest = name[i:]
    if rest.startswith('5'):
        return root, 'pow', rest
    quality = 'min' if rest.startswith('m') and not rest.startswith('maj') else 'maj'
    suffix = rest[1:] if quality == 'min' else rest
    return root, quality, suffix


def triad_name(chord, flats=None):
    """Chord name with any seventh or suspension dropped."""
    root, quality, _suffix = parse_chord(chord)
    if root is None:
        return chord
    if flats is None:
        flats = 'b' in chord[1:2]
    return chord_name(root, quality, flats)


def chord_run(segments):
    """Segments -> [[triad, duration]], gaps dropped and repeats collapsed.

    Collapsing on the triad matters: the seventh refinement works segment by
    segment, so one pass through a loop can come back as Am7 and the next as
    Am. Matched on the literal name those read as two different chords, and a
    loop that repeats perfectly well looks like it never repeats at all.
    """
    run = []
    for s in segments:
        if s['chord'] == 'N.C.':
            continue
        name = triad_name(s['chord'])
        if run and run[-1][0] == name:
            run[-1][1] += s['duration']
        else:
            run.append([name, s['duration']])
    return run


def _dominant_spellings(segments):
    """Triad -> the name the song spends most time on (Am7 over Am)."""
    totals = {}
    for s in segments:
        if s['chord'] == 'N.C.':
            continue
        totals.setdefault(triad_name(s['chord']), {})
        by_name = totals[triad_name(s['chord'])]
        by_name[s['chord']] = by_name.get(s['chord'], 0.0) + s['duration']
    return {triad: max(names, key=names.get) for triad, names in totals.items()}


LOOP_TOLERANCE = 1          # chords a repetition may get wrong and still count
LOOP_COVERAGE = 0.35        # share of playing time the loop must account for


def _occurrences(names, weights, window, tolerance):
    """Non-overlapping places the window repeats, allowing a few wrong chords.

    Exact matching is useless on a real recording: one pass through the loop
    comes back with a wrong chord somewhere, and every repetition after it stops
    counting. Allowing a mismatch is what lets the loop be found at all.

    Repetitions must also take comparable time. Without that, a window whose
    first chord happens to be held for half a verse matches a quick vamp of the
    same chords elsewhere, and one long stretch masquerades as a tight loop.
    """
    length = len(window)
    chosen, last = [], -length
    for j in range(len(names) - length + 1):
        if j < last + length:
            continue
        wrong = sum(1 for a, b in zip(window, names[j:j + length]) if a != b)
        if wrong <= tolerance:
            chosen.append(j)
            last = j
    if len(chosen) < 2:
        return []
    spans = [sum(weights[j:j + length]) for j in chosen]
    middle = sorted(spans)[len(spans) // 2]
    return [j for j, span in zip(chosen, spans) if 0.5 * middle <= span <= 2.0 * middle]


def _best_loop(names, weights, total):
    """(positions, length) of the repeated loop the song spends most time in."""
    best = None
    for length in range(MIN_LOOP, MAX_LOOP + 1):
        if len(names) < 2 * length:
            break
        tolerance = LOOP_TOLERANCE if length >= 4 else 0
        seen = set()
        for i in range(len(names) - length + 1):
            window = tuple(names[i:i + length])
            if len(set(window)) < 2 or window in seen:
                continue
            seen.add(window)
            chosen = _occurrences(names, weights, window, tolerance)
            if len(chosen) < 2:      # a loop is something that comes back
                continue
            covered = sum(sum(weights[j:j + length]) for j in chosen)
            if best is None or covered > best[0]:
                best = (covered, chosen, length)
    if best is None or best[0] < LOOP_COVERAGE * total:
        return None, None
    return best[1], best[2]


def _consensus(names, weights, positions, length):
    """Majority chord at each position of the loop, weighted by time held."""
    loop = []
    for p in range(length):
        votes = {}
        for j in positions:
            if j + p < len(names):
                votes[names[j + p]] = votes.get(names[j + p], 0.0) + weights[j + p]
        if not votes:
            return []
        loop.append(max(votes, key=votes.get))
    collapsed = []
    for name in loop:
        if not collapsed or collapsed[-1] != name:
            collapsed.append(name)
    if len(collapsed) > 1 and collapsed[0] == collapsed[-1]:
        collapsed.pop()
    return _shortest_period(collapsed)


def _shortest_period(loop):
    """Dm-Bb-Dm-Bb is a two chord loop written twice: print it once.

    A four bar window can score better than the two bar one it is built from,
    because a single wrong chord breaks the shorter window's repetitions but
    only dents the longer one's.
    """
    for length in range(1, len(loop) // 2 + 1):
        if len(loop) % length:
            continue
        if all(loop[i] == loop[i % length] for i in range(len(loop))):
            return loop[:length]
    return loop


def _rotate_to_tonic(loop, tonic, mode, totals):
    if tonic is not None:
        want = 'min' if mode == 'minor' else 'maj'
        for quality in (want, None):
            for i, name in enumerate(loop):
                root, chord_quality, _suffix = parse_chord(name)
                if root == tonic and (quality is None or chord_quality == quality):
                    return loop[i:] + loop[:i]
    longest = max(range(len(loop)), key=lambda i: totals.get(loop[i], 0.0))
    return loop[longest:] + loop[:longest]


def extract_progression(segments, tonic=None, mode=None):
    """The chord loop the song rests in, rotated to start on the tonic."""
    run = chord_run(segments)
    if not run:
        raise ValueError('no chords detected')
    names = [name for name, _d in run]
    weights = [duration for _n, duration in run]
    total = sum(weights) or 1.0

    totals = {}
    for name, duration in run:
        totals[name] = totals.get(name, 0.0) + duration

    spelling = _dominant_spellings(segments)
    positions, length = _best_loop(names, weights, total)
    loop = _consensus(names, weights, positions, length) if positions else []
    if not loop:
        ordered = []
        for name in names:
            if name not in ordered:
                ordered.append(name)
        loop = sorted(ordered, key=lambda n: -totals[n])[:FALLBACK_LENGTH]
        loop = [n for n in ordered if n in loop]
    else:
        loop = _rotate_to_tonic(loop, tonic, mode, totals)
    return [spelling.get(n, n) for n in loop]


def chord_degrees(progression, tonic, mode):
    diatonic = DIATONIC_MAJOR if mode == 'major' else DIATONIC_MINOR
    chromatic = CHROMATIC_MAJOR if mode == 'major' else CHROMATIC_MINOR
    out = []
    for name in progression:
        root, quality, suffix = parse_chord(name)
        if root is None:
            continue
        offset = (root - tonic) % 12
        entry = diatonic.get(offset)
        # A sus or power chord states no third, so it cannot be major or minor.
        # Reading it as major prints an uppercase numeral that contradicts the
        # key named right beside it; take the quality the key supplies instead.
        if entry and (quality == 'pow' or suffix.startswith('sus')):
            quality = entry[1]
        if entry and entry[1] == quality:
            out.append({'chord': name, 'degree': entry[0], 'diatonic': True})
        else:
            numeral = chromatic[offset]
            if quality == 'min':
                # lowercase the roman numeral only: 'bIII' must not become 'BIII'
                numeral = ''.join(c if c in '#b' else c.lower() for c in numeral)
            out.append({'chord': name, 'degree': numeral, 'diatonic': False})
    return out


def build_scales_and_tips(tonic, mode, degrees):
    flats = tonic in (FLAT_MAJOR if mode == 'major' else FLAT_MINOR)
    name = (NOTE_FLAT if flats else NOTE_SHARP)[tonic]
    relative_pc = (tonic + 9) % 12 if mode == 'major' else (tonic + 3) % 12
    relative_mode = 'minor' if mode == 'major' else 'major'
    relative_flats = relative_pc in (FLAT_MINOR if mode == 'major' else FLAT_MAJOR)
    relative_name = (NOTE_FLAT if relative_flats else NOTE_SHARP)[relative_pc]
    relative = f'{relative_name} {relative_mode}'
    degree_set = {d['degree'] for d in degrees}

    if mode == 'major':
        scales = [f'{name} Major (Ionian)', f'{name} Major Pentatonic']
        tips = [f'{name} Major Pentatonic is the safe everywhere choice.',
                f'The relative minor, {relative_name} Minor Pentatonic, hits the same '
                f'notes with a darker flavor.']
        if 'bVII' in degree_set:
            scales.append(f'{name} Mixolydian')
            tips.append(f'The bVII chord is a Mixolydian sound: try {name} Mixolydian over it.')
        if 'iv' in degree_set or 'bVI' in degree_set:
            tips.append(f'The borrowed minor chord comes from {name} minor: lean on the '
                        f'b3 and b6 while it lasts.')
    else:
        scales = [f'{name} Natural Minor (Aeolian)', f'{name} Minor Pentatonic']
        tips = [f'{name} Minor Pentatonic works over the whole progression.',
                f'Add the b6 from {name} Natural Minor for a sadder color.']
        if 'IV' in degree_set:
            scales.append(f'{name} Dorian')
            tips.append(f'A major IV chord points at Dorian: {name} Dorian will sound '
                        f'intentional over it.')
        if 'V' in degree_set:
            scales.append(f'{name} Harmonic Minor')
            tips.append(f'The major V chord comes from {name} Harmonic Minor; lean on it '
                        f'during that chord.')
        tips.append(f'The relative major is {relative}: the same notes from a brighter angle.')
    return scales, tips, relative


def scale_fit(chroma_mean, tonic, mode):
    pcs = MAJOR_SCALE if mode == 'major' else MINOR_SCALE
    total = chroma_mean.sum() + 1e-12
    inside = sum(chroma_mean[(tonic + p) % 12] for p in pcs)
    return round(float(inside / total) * 100.0, 1)


OPEN_MAJOR_SHAPES = {0: 'C', 2: 'D', 4: 'E', 7: 'G', 9: 'A'}
OPEN_MINOR_SHAPES = {2: 'Dm', 4: 'Em', 9: 'Am'}


def capo_suggestion(tonic, mode):
    shapes = OPEN_MAJOR_SHAPES if mode == 'major' else OPEN_MINOR_SHAPES
    flats = tonic in (FLAT_MAJOR if mode == 'major' else FLAT_MINOR)
    sounding = (NOTE_FLAT if flats else NOTE_SHARP)[tonic] + ('' if mode == 'major' else 'm')
    if tonic in shapes:
        return {'position': 0,
                'note': f'No capo needed: {sounding} already has open shapes.'}
    for capo in range(1, 8):
        shape = (tonic - capo) % 12
        if shape in shapes:
            return {'position': capo,
                    'note': f'Capo {capo}: play {shapes[shape]}-shape chords '
                            f'to sound in {sounding}.'}
    return {'position': 0, 'note': 'No comfortable capo position found.'}


# ---------------------------------------------------------------------------
# Top level
# ---------------------------------------------------------------------------


KEY_PRIOR_STRENGTH = 0.035


def key_chord_prior(tonic, mode, labels):
    """A small nudge toward the chords the detected key is built from.

    Second-pass only: a first-pass key is uncertain, so the nudge is deliberately
    weak. Enough to settle a coin-flip between a diatonic chord and the chromatic
    neighbour it was tying with, never enough to manufacture a chord.
    """
    diatonic = DIATONIC_MAJOR if mode == 'major' else DIATONIC_MINOR
    prior = np.zeros(len(labels))
    for i, (root, quality, _iv) in enumerate(labels):
        entry = diatonic.get((root - tonic) % 12)
        if entry and entry[1] == quality:
            prior[i] = KEY_PRIOR_STRENGTH
    return prior


def name_segments(segments, tonic, mode):
    """Spell the segments for the detected key, resolving third-less chords.

    A power chord has no opinion about major or minor, so once the key is known
    it is written as the triad that key actually contains: the Em a player would
    read, not the E5 the spectrum literally showed.
    """
    flats = tonic in (FLAT_MAJOR if mode == 'major' else FLAT_MINOR)
    diatonic = DIATONIC_MAJOR if mode == 'major' else DIATONIC_MINOR
    out = []
    for s in segments:
        s = dict(s)
        if s['root'] is not None:
            if s['quality'] == 'pow':
                entry = diatonic.get((s['root'] - tonic) % 12)
                s['quality'] = entry[1] if entry and entry[1] in ('maj', 'min') else 'maj'
            s['chord'] = chord_name(s['root'], s['quality'], flats)
        out.append(s)
    return out


def chords_and_key(treble, bass, beat_times=None, passes=2):
    """The label stages on their own, so they can be driven from cached chroma."""
    t_seg = None
    if beat_times is not None and len(beat_times) >= 8:
        try:
            t_seg, b_seg, times, durations = beat_segments(treble, bass, beat_times)
        except ValueError:
            t_seg = None
    if t_seg is None:
        t_seg, b_seg, times, durations = segment_chroma(treble, bass)
    chroma_mean = treble.mean(axis=1)
    bass_mean = bass.mean(axis=1)

    prior = None
    for _pass in range(passes):
        labels, scores = chord_scores(t_seg, b_seg, prior)
        path = viterbi(scores, durations)
        segments = drop_blips(merge_segments(path, labels, times, durations, scores))
        tonic, mode, conf = estimate_key(segments, chroma_mean, bass_mean)
        prior = key_chord_prior(tonic, mode, labels)

    segments = name_segments(segments, tonic, mode)
    flats = tonic in (FLAT_MAJOR if mode == 'major' else FLAT_MINOR)
    names = NOTE_FLAT if flats else NOTE_SHARP
    return {'segments': segments, 'tonic': tonic, 'mode': mode, 'confidence': conf,
            'times': times, 'durations': durations, 'treble_seg': t_seg,
            'key_name': f'{names[tonic]} {mode}'}


def analyze(samples, sr=SR):
    """Decoded mono audio -> the analysis payload the music view renders."""
    audio = np.ascontiguousarray(np.asarray(samples, dtype=np.float64))
    result = {'warnings': [], 'duration_analyzed': round(len(audio) / sr, 1)}

    mag = stft_magnitude(audio)
    try:
        tuning = estimate_tuning_cents(mag)
    except Exception as e:  # noqa: BLE001 - every stage degrades on its own
        tuning, result['tuning_cents'] = 0.0, None
        result['warnings'].append(f'Tuning estimation failed: {e}')
    else:
        result['tuning_cents'] = round(tuning, 1)

    beat_times = []
    try:
        env = onset_envelope(audio)
        bpm, lag, confidence = detect_tempo(env)
        result['tempo'] = {'bpm': round(float(bpm), 1), 'confidence': confidence}
    except Exception as e:  # noqa: BLE001
        env, lag, result['tempo'] = None, None, None
        result['warnings'].append(f'Tempo detection failed: {e}')

    if env is not None and lag is not None:
        try:
            beats = beat_track(env, lag)
            beat_times = (beats / ONSET_RATE).tolist()
            value, confidence = estimate_meter(env, beats)
            result['time_signature'] = {'value': value, 'confidence': confidence}
        except Exception as e:  # noqa: BLE001
            result['time_signature'] = None
            result['warnings'].append(f'Time signature estimation failed: {e}')
    else:
        result['time_signature'] = None

    try:
        spec = whiten(log_spectrogram(mag, tuning))
        notes = nnls_notes(spec)
        treble = fold_chroma(notes, *TREBLE_RANGE)
        bass = fold_chroma(notes, *BASS_RANGE)
        found = chords_and_key(treble, bass, beat_times)
    except Exception as e:  # noqa: BLE001
        for field in ('key', 'chords', 'degrees', 'scales', 'improvise', 'capo'):
            result[field] = None
        result['segments'] = []
        result['warnings'].append(f'Chord and key detection failed: {e}')
        return result

    segments = refine_qualities(found['segments'], found['treble_seg'], found['times'])
    tonic, mode = found['tonic'], found['mode']
    flats = tonic in (FLAT_MAJOR if mode == 'major' else FLAT_MINOR)
    names = NOTE_FLAT if flats else NOTE_SHARP

    try:
        progression = extract_progression(segments, tonic, mode)
    except Exception as e:  # noqa: BLE001
        progression = []
        result['warnings'].append(f'Progression extraction failed: {e}')

    degrees = chord_degrees(progression, tonic, mode)
    scales, tips, relative = build_scales_and_tips(tonic, mode, degrees)
    chroma_mean = found['treble_seg'].mean(axis=1)

    result['key'] = {
        'tonic': names[tonic], 'mode': mode, 'name': found['key_name'],
        'confidence': found['confidence'], 'relative': relative,
        'parallel': f"{names[tonic]} {'minor' if mode == 'major' else 'major'}",
    }
    result['chords'] = {
        'progression': progression,
        'timeline': [{'time': round(s['time'], 2), 'chord': s['chord']}
                     for s in segments][:150],
    }
    result['degrees'] = degrees
    result['scales'] = {'primary': scales[0], 'suggestions': scales,
                        'fit_percent': scale_fit(chroma_mean, tonic, mode)}
    result['improvise'] = tips
    result['capo'] = capo_suggestion(tonic, mode)
    result['segments'] = segments
    return result
