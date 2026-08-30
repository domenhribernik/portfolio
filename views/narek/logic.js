//? Narek: every DOM-free decision the dictation sheet makes.
//?
//? Four groups, in the order the audio travels:
//?   1. Gating    - is this frame speech, and where does an utterance end
//?   2. Encoding  - 48 kHz float frames down to a 16 kHz mono WAV
//?   3. Text      - cleaning what the model returns, joining it to the record
//?   4. Proofing  - the word diff that gates the AI correction pass
//?
//? Tested by tests/narek-logic.test.mjs. Nothing here touches window.

// ============================================================
//  1. Gating
// ============================================================

//? Defaults tuned on laptop mics in a quiet room. The gate is adaptive, so
//? these are ratios against a measured noise floor rather than fixed levels;
//? a fixed level either clips soft speakers or never closes in a cafe.
export const SEGMENTER_DEFAULTS = {
    sampleRate: 48000,
    openRatio: 3.0,        //? gate opens at 3x the measured floor
    closeRatio: 1.7,       //? and stays open down to 1.7x, so plosives don't chop
    absoluteFloor: 0.0045, //? below this it is never speech, however quiet the room
    silenceMs: 850,        //? a pause this long ends the utterance
    minSpeechMs: 350,      //? anything shorter is a cough, not a sentence
    maxSegmentMs: 18000,   //? hard cut, keeps one request under ~576 KB of WAV
    preRollMs: 320,        //? replayed before the gate opened, saves the first consonant
    tailMs: 220,           //? trailing silence kept so the last word isn't clipped
};

export function rms(frame) {
    if (!frame || frame.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    return Math.sqrt(sum / frame.length);
}

export function concatFrames(frames) {
    let total = 0;
    for (const f of frames) total += f.length;
    const out = new Float32Array(total);
    let at = 0;
    for (const f of frames) {
        out.set(f, at);
        at += f.length;
    }
    return out;
}

//? A voice-activity gate with hysteresis and an adaptive floor.
//?
//? push(frame) is called for every block of samples off the mic and returns
//? one event describing what just happened. The caller only has to act on
//? 'segment'; the rest drive the meter and the state line.
export function createSegmenter(options = {}) {
    const cfg = { ...SEGMENTER_DEFAULTS, ...options };
    const msPerSample = 1000 / cfg.sampleRate;

    let noiseFloor = 0.02; //? starts pessimistic and falls to the real room within a second
    let speaking = false;
    let preRoll = [];
    let preRollMs = 0;
    let held = [];
    let heldMs = 0;
    let silentMs = 0;
    let quietTailMs = 0;

    function gates() {
        return {
            open: Math.max(cfg.absoluteFloor, noiseFloor * cfg.openRatio),
            close: Math.max(cfg.absoluteFloor * 0.6, noiseFloor * cfg.closeRatio),
        };
    }

    //? Trailing silence is trimmed back to tailMs before the segment ships:
    //? the model gets the words and nothing else, and the upload shrinks.
    function cut(reason) {
        const trimTo = Math.max(0, heldMs - Math.max(0, quietTailMs - cfg.tailMs));
        let keep = Math.round(trimTo / msPerSample);
        const samples = concatFrames(held);
        if (keep > samples.length || keep <= 0) keep = samples.length;
        const voicedMs = heldMs - quietTailMs;

        speaking = false;
        held = [];
        heldMs = 0;
        silentMs = 0;
        quietTailMs = 0;

        if (voicedMs < cfg.minSpeechMs) return { type: 'discard', reason: 'too-short' };
        return {
            type: 'segment',
            reason,
            samples: samples.subarray(0, keep),
            durationMs: Math.round(keep * msPerSample),
        };
    }

    return {
        get noiseFloor() { return noiseFloor; },
        get speaking() { return speaking; },
        get gates() { return gates(); },
        get heldMs() { return heldMs; },

        push(frame) {
            const level = rms(frame);
            const frameMs = frame.length * msPerSample;
            const g = gates();

            if (!speaking) {
                //? Adapt only while idle. Learning the floor mid-sentence would
                //? teach the gate that speech is silence and it would never close.
                const rate = level < noiseFloor ? 0.35 : 0.004;
                noiseFloor = Math.max(0.0006, noiseFloor + (level - noiseFloor) * rate);

                preRoll.push(frame);
                preRollMs += frameMs;
                while (preRollMs > cfg.preRollMs && preRoll.length > 1) {
                    preRollMs -= preRoll[0].length * msPerSample;
                    preRoll.shift();
                }

                if (level >= g.open) {
                    speaking = true;
                    held = preRoll.slice();
                    heldMs = preRollMs;
                    preRoll = [];
                    preRollMs = 0;
                    held.push(frame);
                    heldMs += frameMs;
                    silentMs = 0;
                    quietTailMs = 0;
                    return { type: 'open', level, noiseFloor };
                }
                return { type: 'idle', level, noiseFloor };
            }

            held.push(frame);
            heldMs += frameMs;

            if (level >= g.close) {
                silentMs = 0;
                quietTailMs = 0;
            } else {
                silentMs += frameMs;
                quietTailMs += frameMs;
            }

            if (silentMs >= cfg.silenceMs) return { ...cut('pause'), level, noiseFloor };
            if (heldMs >= cfg.maxSegmentMs) return { ...cut('length'), level, noiseFloor };
            return { type: 'speech', level, noiseFloor };
        },

        //? Called when the visitor stops recording mid-sentence.
        flush() {
            if (!speaking) return { type: 'idle' };
            return cut('stop');
        },

        reset() {
            speaking = false;
            preRoll = [];
            preRollMs = 0;
            held = [];
            heldMs = 0;
            silentMs = 0;
            quietTailMs = 0;
            noiseFloor = 0.02;
        },
    };
}

// ============================================================
//  2. Encoding
// ============================================================

export const WIRE_SAMPLE_RATE = 16000;

//? Box-average decimation. Picking every Nth sample is one line shorter and
//? aliases high frequencies down onto the speech band, which the model hears
//? as a lisp.
export function downsample(samples, inRate, outRate = WIRE_SAMPLE_RATE) {
    if (!samples || samples.length === 0) return new Float32Array(0);
    if (outRate >= inRate) return Float32Array.from(samples);

    const ratio = inRate / outRate;
    const outLength = Math.floor(samples.length / ratio);
    const out = new Float32Array(outLength);

    for (let i = 0; i < outLength; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
        let sum = 0;
        let n = 0;
        for (let j = start; j < end; j++) { sum += samples[j]; n++; }
        out[i] = n > 0 ? sum / n : 0;
    }
    return out;
}

//? Peak-normalise to -3 dBFS. Phone and laptop mics record quietly, and a
//? quiet WAV measurably raises word error rate. Silence is left alone so a
//? near-empty segment isn't amplified into noise.
export function normalize(samples, target = 0.708) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
        const v = Math.abs(samples[i]);
        if (v > peak) peak = v;
    }
    if (peak < 0.0025 || peak >= target) return samples;
    const gain = Math.min(8, target / peak);
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
    return out;
}

//? 16-bit mono PCM in a 44-byte RIFF wrapper. Gemini accepts audio/wav
//? everywhere; it does not document audio/webm, which is what MediaRecorder
//? hands you on Chrome, so we never go near MediaRecorder.
export function encodeWav(samples, sampleRate = WIRE_SAMPLE_RATE) {
    const bytesPerSample = 2;
    const dataBytes = samples.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);

    const ascii = (offset, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };

    ascii(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);          //? PCM chunk size
    view.setUint16(20, 1, true);           //? format: PCM
    view.setUint16(22, 1, true);           //? channels: mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true); //? byte rate
    view.setUint16(32, bytesPerSample, true);              //? block align
    view.setUint16(34, 16, true);          //? bits per sample
    ascii(36, 'data');
    view.setUint32(40, dataBytes, true);

    let at = 44;
    for (let i = 0; i < samples.length; i++) {
        const clamped = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(at, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
        at += 2;
    }
    return new Uint8Array(buffer);
}

//? The whole capture-to-wire path in one call, so script.js never juggles rates.
export function toWireWav(samples, inRate) {
    return encodeWav(normalize(downsample(samples, inRate)), WIRE_SAMPLE_RATE);
}

// ============================================================
//  3. Text
// ============================================================

//? Things a model says when it heard nothing worth writing down. Any answer
//? that reduces to one of these becomes an empty string rather than landing
//? in the record as literal "[nerazumljivo]".
const EMPTY_ANSWERS = new Set([
    '', '-', '--', '...', '…', '.', 'n/a', 'na',
    'tisina', 'tišina', 'silence', 'no speech', 'ni govora',
    'nerazumljivo', 'nerazumljivo', 'prazno', 'empty', 'null',
]);

const LABEL_PREFIX = /^(prepis|transkripcija|besedilo|transcript|transcription|text|output)\s*[:\-–]\s*/i;

export function cleanTranscript(raw) {
    let text = String(raw == null ? '' : raw);

    text = text.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
    text = text.replace(/\[[^\]]{0,40}\]/g, ' ');   //? [glasba], [smeh], [nerazumljivo]
    text = text.replace(/\((?:glasba|smeh|kašelj|premor|tišina|music|laughter|pause|inaudible)\)/gi, ' ');
    text = text.trim();
    text = text.replace(LABEL_PREFIX, '');
    text = text.replace(/^["'«»„“”]+|["'«»„“”]+$/g, '');
    text = text.replace(/\s+/g, ' ').trim();

    const probe = text.toLowerCase().replace(/[.!?…"'()\[\]-]/g, '').trim();
    if (EMPTY_ANSWERS.has(probe)) return '';
    return text;
}

export function capitalizeFirst(text) {
    if (!text) return text;
    return text.charAt(0).toUpperCase() + text.slice(1);
}

//? Each segment is its own utterance, so it opens a sentence whenever the
//? record already closed one. Mid-sentence continuations are left exactly as
//? the model wrote them, because guessing case on a Slovenian proper noun is
//? how you turn "Kranj" into "kranj".
export function joinTranscript(existing, addition) {
    const add = cleanTranscript(addition);
    if (!add) return existing || '';
    const base = (existing || '').trim();
    if (!base) return capitalizeFirst(add);
    if (/[.!?…:]["'»”]?$/.test(base)) return `${base} ${capitalizeFirst(add)}`;
    return `${base} ${add}`;
}

export function countWords(text) {
    return tokenizeWords(text).length;
}

export function formatClock(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

//? Custom vocabulary, biasing the model toward names and jargon it would
//? otherwise spell phonetically. Capped because a 1000-term prompt costs more
//? than it helps and starts pushing the audio out of the context.
export const VOCABULARY_LIMIT = 48;

export function parseVocabulary(raw) {
    return String(raw || '')
        .split(/[,\n;]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 1 && t.length <= 40)
        .filter((t, i, all) => all.indexOf(t) === i)
        .slice(0, VOCABULARY_LIMIT);
}

// ============================================================
//  3b. Translation
// ============================================================

//? The interpreter page works in exactly two languages, and which one you are
//? speaking is the model's job to notice, not yours to declare.
export const LANGUAGE_CODES = ['sl', 'en'];

export const LANGUAGE_LABEL = { sl: 'SL', en: 'EN' };

const LANGUAGE_ALIASES = {
    sl: 'sl', slv: 'sl', slo: 'sl', slovenian: 'sl', slovene: 'sl',
    'slovenščina': 'sl', 'slovenscina': 'sl',
    en: 'en', eng: 'en', english: 'en', 'angleščina': 'en', 'anglescina': 'en',
};

export function normalizeLanguage(value) {
    const key = String(value == null ? '' : value).trim().toLowerCase();
    return LANGUAGE_ALIASES[key] || null;
}

export function otherLanguage(code) {
    if (code === 'sl') return 'en';
    if (code === 'en') return 'sl';
    return null;
}

//? The model is asked for JSON, so the happy path is a parse. The fallback
//? matters anyway: a model that ignores the schema and answers in prose has
//? still done the translation, and throwing that away would be worse than
//? showing it without knowing which direction it went.
export function parseTranslation(raw) {
    let text = String(raw == null ? '' : raw).trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

    let data = null;
    try {
        data = JSON.parse(text);
    } catch { /* not JSON: fall through to the prose path */ }

    if (data && typeof data === 'object' && !Array.isArray(data)) {
        const lang = normalizeLanguage(data.lang ?? data.language);
        const source = cleanTranscript(data.source ?? data.transcript ?? '');
        const translation = cleanTranscript(data.translation ?? data.translated ?? '');
        if (!source && !translation) return null;
        return { lang, target: otherLanguage(lang), source, translation };
    }

    const plain = cleanTranscript(text);
    if (!plain) return null;
    return { lang: null, target: null, source: '', translation: plain };
}

// ============================================================
//  4. Proofing
// ============================================================

export function tokenizeWords(text) {
    const trimmed = String(text == null ? '' : text).trim();
    if (!trimmed) return [];
    return trimmed.split(/\s+/);
}

const DIFF_TOKEN_CEILING = 4000; //? above this the LCS table costs more than it is worth

//? Word-level diff, longest common subsequence, merged into runs so the
//? proof marks read as phrases rather than a stutter of single words.
export function diffWords(before, after) {
    const a = tokenizeWords(before);
    const b = tokenizeWords(after);

    if (a.length === 0 && b.length === 0) return [];
    if (a.length > DIFF_TOKEN_CEILING || b.length > DIFF_TOKEN_CEILING) {
        const ops = [];
        if (a.length) ops.push({ type: 'del', words: a });
        if (b.length) ops.push({ type: 'ins', words: b });
        return ops;
    }

    const w = b.length + 1;
    const table = new Uint32Array((a.length + 1) * w);
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            table[i * w + j] = a[i] === b[j]
                ? table[(i + 1) * w + (j + 1)] + 1
                : Math.max(table[(i + 1) * w + j], table[i * w + (j + 1)]);
        }
    }

    const raw = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            raw.push({ type: 'same', word: a[i] });
            i++; j++;
        } else if (table[(i + 1) * w + j] >= table[i * w + (j + 1)]) {
            raw.push({ type: 'del', word: a[i] });
            i++;
        } else {
            raw.push({ type: 'ins', word: b[j] });
            j++;
        }
    }
    while (i < a.length) raw.push({ type: 'del', word: a[i++] });
    while (j < b.length) raw.push({ type: 'ins', word: b[j++] });

    const ops = [];
    for (const item of raw) {
        const last = ops[ops.length - 1];
        if (last && last.type === item.type) last.words.push(item.word);
        else ops.push({ type: item.type, words: [item.word] });
    }
    return ops;
}

//? Share of the original transcript the correction touched. This is the
//? number that decides whether a correction is a proofread or a rewrite.
export function diffStats(ops) {
    let same = 0;
    let inserted = 0;
    let deleted = 0;
    for (const op of ops) {
        if (op.type === 'same') same += op.words.length;
        else if (op.type === 'ins') inserted += op.words.length;
        else deleted += op.words.length;
    }
    const original = same + deleted;
    const ratio = original === 0
        ? (inserted > 0 ? 1 : 0)
        : Math.min(1, (inserted + deleted) / (original * 2));
    return { same, inserted, deleted, original, ratio };
}

//? The research this tool exists to test says the correction pass is the risk,
//? not the transcription: LLMs "improve" fluency by quietly changing meaning,
//? and Slovenian's cases and dual make that invisible unless you look. Past a
//? quarter of the record touched, the result is shown but never auto-applied.
export const OVERREACH_RATIO = 0.25;

export function isOverreach(stats, limit = OVERREACH_RATIO) {
    return stats.ratio > limit;
}
