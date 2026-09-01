// Unit tests for views/narek/logic.js: the voice gate, the wire encoding,
// the transcript text rules, and the diff that gates the AI correction.
//
// Run: node --test tests/narek-logic.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    rms,
    concatFrames,
    createSegmenter,
    downsample,
    normalize,
    encodeWav,
    toWireWav,
    cleanTranscript,
    joinTranscript,
    capitalizeFirst,
    countWords,
    formatClock,
    parseVocabulary,
    VOCABULARY_LIMIT,
    tokenizeWords,
    diffWords,
    diffStats,
    isOverreach,
    OVERREACH_RATIO,
    WIRE_SAMPLE_RATE,
    parseTranslation,
    normalizeLanguage,
    otherLanguage,
    LANGUAGE_LABEL,
    LANGUAGE_CODES,
} from '../views/narek/logic.js';

// ------------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------------

const SR = 16000;
const FRAME = 1024;                 // 64 ms at 16 kHz
const FRAME_MS = (FRAME / SR) * 1000;

const silence = () => new Float32Array(FRAME);

function tone(amplitude = 0.3) {
    const frame = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) frame[i] = Math.sin((i / SR) * 2 * Math.PI * 220) * amplitude;
    return frame;
}

const fastGate = (extra = {}) => createSegmenter({
    sampleRate: SR,
    silenceMs: 200,
    minSpeechMs: 100,
    maxSegmentMs: 5000,
    preRollMs: 64,
    ...extra,
});

/** Feed n frames, returning every event. */
function feed(gate, frame, n) {
    const events = [];
    for (let i = 0; i < n; i++) events.push(gate.push(frame));
    return events;
}

/** Let the adaptive floor fall to the real (silent) room. */
function settle(gate) {
    feed(gate, silence(), 20);
}

// ------------------------------------------------------------------
//  1. Gating
// ------------------------------------------------------------------

test('rms is zero for silence and rises with amplitude', () => {
    assert.equal(rms(silence()), 0);
    assert.equal(rms(new Float32Array(0)), 0);
    assert.ok(rms(tone(0.5)) > rms(tone(0.1)));
});

test('concatFrames joins in order', () => {
    const out = concatFrames([Float32Array.from([1, 2]), Float32Array.from([3])]);
    assert.deepEqual(Array.from(out), [1, 2, 3]);
});

test('silence alone never opens the gate', () => {
    const gate = fastGate();
    for (const event of feed(gate, silence(), 40)) {
        assert.equal(event.type, 'idle');
    }
    assert.equal(gate.speaking, false);
});

test('the adaptive floor falls toward the real room', () => {
    const gate = fastGate();
    const before = gate.noiseFloor;
    settle(gate);
    assert.ok(gate.noiseFloor < before, 'floor should drop in a quiet room');
    assert.ok(gate.noiseFloor > 0, 'floor never reaches zero');
});

test('speech opens the gate and a pause closes it into a segment', () => {
    const gate = fastGate();
    settle(gate);

    const opened = gate.push(tone());
    assert.equal(opened.type, 'open');
    assert.equal(gate.speaking, true);

    feed(gate, tone(), 5);                 // ~380 ms of voice, over minSpeechMs

    const quiet = feed(gate, silence(), 5); // 320 ms, over silenceMs
    const segment = quiet.find((e) => e.type === 'segment');

    assert.ok(segment, 'a pause should end the utterance');
    assert.equal(segment.reason, 'pause');
    assert.ok(segment.samples.length > 0);
    assert.equal(gate.speaking, false);
});

test('the segment carries pre-roll from before the gate opened', () => {
    const gate = fastGate({ preRollMs: 200 });
    settle(gate);
    gate.push(tone());
    feed(gate, tone(), 5);
    const segment = feed(gate, silence(), 5).find((e) => e.type === 'segment');

    // 6 voiced frames alone would be 6 * FRAME samples; pre-roll adds more.
    assert.ok(segment.samples.length > FRAME * 6, 'pre-roll frames should be prepended');
});

test('trailing silence is trimmed back to the tail allowance', () => {
    const gate = fastGate({ preRollMs: 0, tailMs: 64 });
    settle(gate);
    gate.push(tone());
    feed(gate, tone(), 5);
    const segment = feed(gate, silence(), 5).find((e) => e.type === 'segment');

    // 6 voiced frames plus roughly one frame of kept tail, never all 5.
    assert.ok(segment.durationMs < FRAME_MS * 9, `kept ${segment.durationMs} ms of tail`);
    assert.ok(segment.durationMs >= FRAME_MS * 6);
});

test('a burst shorter than minSpeechMs is discarded, not transcribed', () => {
    const gate = fastGate({ minSpeechMs: 500 });
    settle(gate);
    gate.push(tone());                       // one 64 ms frame only
    const events = feed(gate, silence(), 6);

    assert.ok(events.some((e) => e.type === 'discard'));
    assert.ok(!events.some((e) => e.type === 'segment'));
});

test('a long monologue is cut at maxSegmentMs so one request stays bounded', () => {
    const gate = fastGate({ maxSegmentMs: 320 });
    settle(gate);
    gate.push(tone());
    const events = feed(gate, tone(), 10);
    const segment = events.find((e) => e.type === 'segment');

    assert.ok(segment, 'the gate must cut a speaker who never pauses');
    assert.equal(segment.reason, 'length');
});

test('flush ships whatever was mid-sentence when recording stops', () => {
    const gate = fastGate();
    settle(gate);
    gate.push(tone());
    feed(gate, tone(), 5);

    const tail = gate.flush();
    assert.equal(tail.type, 'segment');
    assert.equal(tail.reason, 'stop');
    assert.equal(gate.flush().type, 'idle', 'a second flush has nothing left');
});

test('hysteresis keeps the gate open through a dip between words', () => {
    const gate = fastGate({ silenceMs: 400 });
    settle(gate);
    gate.push(tone());
    feed(gate, tone(), 3);
    const dip = feed(gate, silence(), 3);      // 192 ms, under silenceMs

    assert.ok(!dip.some((e) => e.type === 'segment'), 'a short dip is not a sentence end');
    assert.equal(gate.speaking, true);
});

test('reset returns the gate to its starting state', () => {
    const gate = fastGate();
    settle(gate);
    gate.push(tone());
    gate.reset();
    assert.equal(gate.speaking, false);
    assert.equal(gate.heldMs, 0);
});

// ------------------------------------------------------------------
//  2. Encoding
// ------------------------------------------------------------------

test('downsample averages rather than decimating', () => {
    const input = Float32Array.from([1, -1, 1, -1, 1, -1, 1, -1]);
    const out = downsample(input, 8, 4);
    assert.equal(out.length, 4);
    // A picking decimator would return [1,1,1,1]; averaging pairs cancels.
    for (const v of out) assert.ok(Math.abs(v) < 1e-6, `expected ~0, got ${v}`);
});

test('downsample is a no-op when the rate already matches', () => {
    const input = Float32Array.from([0.1, 0.2, 0.3]);
    assert.deepEqual(Array.from(downsample(input, 16000, 16000)), [0.1, 0.2, 0.3].map((n) => Math.fround(n)));
    assert.equal(downsample(new Float32Array(0), 48000).length, 0);
});

test('normalize lifts a quiet capture and leaves loud and silent alone', () => {
    const quiet = Float32Array.from([0.2, -0.2, 0.1]);
    const lifted = normalize(quiet);
    assert.ok(Math.abs(Math.max(...lifted.map(Math.abs)) - 0.708) < 1e-3,
        'a quiet segment should reach the target');
    assert.ok(Math.abs(lifted[2] / lifted[0] - 0.5) < 1e-6, 'the shape is preserved');

    const loud = Float32Array.from([0.9, -0.8]);
    assert.equal(normalize(loud), loud, 'already loud audio is returned untouched');

    const nearSilence = Float32Array.from([0.0004, -0.0002]);
    assert.equal(normalize(nearSilence), nearSilence, 'silence must not be amplified into noise');
});

test('normalize caps its gain so faint room tone is never blown up', () => {
    // Peak 0.05 would need 14x to reach the target; the cap holds it at 8x.
    const veryQuiet = Float32Array.from([0.05, -0.05]);
    const lifted = normalize(veryQuiet);
    assert.ok(Math.abs(lifted[0] - 0.4) < 1e-6, `expected 8x, got ${lifted[0] / 0.05}x`);
});

test('encodeWav writes a valid 16-bit mono RIFF header', () => {
    const samples = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const wav = encodeWav(samples, WIRE_SAMPLE_RATE);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const tag = (at) => String.fromCharCode(...wav.slice(at, at + 4));

    assert.equal(wav.length, 44 + samples.length * 2);
    assert.equal(tag(0), 'RIFF');
    assert.equal(tag(8), 'WAVE');
    assert.equal(tag(12), 'fmt ');
    assert.equal(tag(36), 'data');
    assert.equal(view.getUint32(4, true), 36 + samples.length * 2);
    assert.equal(view.getUint16(20, true), 1, 'format must be PCM');
    assert.equal(view.getUint16(22, true), 1, 'one channel');
    assert.equal(view.getUint32(24, true), WIRE_SAMPLE_RATE);
    assert.equal(view.getUint32(28, true), WIRE_SAMPLE_RATE * 2, 'byte rate');
    assert.equal(view.getUint16(32, true), 2, 'block align');
    assert.equal(view.getUint16(34, true), 16, 'bits per sample');
    assert.equal(view.getUint32(40, true), samples.length * 2);
});

test('encodeWav clamps and converts samples to signed 16-bit', () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 4, -4]), WIRE_SAMPLE_RATE);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    assert.equal(view.getInt16(44, true), 0);
    assert.equal(view.getInt16(46, true), 32767);
    assert.equal(view.getInt16(48, true), -32768);
    assert.equal(view.getInt16(50, true), 32767, 'over-range clamps rather than wrapping');
    assert.equal(view.getInt16(52, true), -32768);
});

test('toWireWav lands 48 kHz capture on a 16 kHz wire file', () => {
    const input = new Float32Array(48000);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((i / 48000) * 2 * Math.PI * 200) * 0.4;

    const wav = toWireWav(input, 48000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    assert.equal(view.getUint32(24, true), WIRE_SAMPLE_RATE);
    assert.equal(view.getUint32(40, true), WIRE_SAMPLE_RATE * 2, 'one second of 16 kHz mono');
});

// ------------------------------------------------------------------
//  3. Text
// ------------------------------------------------------------------

test('cleanTranscript strips fences, labels, quotes and sound tags', () => {
    assert.equal(cleanTranscript('```\nDanes je lep dan.\n```'), 'Danes je lep dan.');
    assert.equal(cleanTranscript('Prepis: Danes je lep dan.'), 'Danes je lep dan.');
    assert.equal(cleanTranscript('Transcript - Danes je lep dan.'), 'Danes je lep dan.');
    assert.equal(cleanTranscript('"Danes je lep dan."'), 'Danes je lep dan.');
    assert.equal(cleanTranscript('„Danes je lep dan.“'), 'Danes je lep dan.');
    assert.equal(cleanTranscript('[glasba] Danes  je   lep dan. (smeh)'), 'Danes je lep dan.');
});

test('cleanTranscript turns a no-speech answer into an empty string', () => {
    for (const answer of ['', '   ', '...', '…', '[tišina]', '(nerazumljivo)', 'Silence', '-', 'N/A']) {
        assert.equal(cleanTranscript(answer), '', `expected nothing from ${JSON.stringify(answer)}`);
    }
    assert.equal(cleanTranscript(null), '');
    assert.equal(cleanTranscript(undefined), '');
});

test('cleanTranscript keeps real speech that merely mentions silence', () => {
    assert.equal(cleanTranscript('V sobi je bila tišina in nihče ni rekel nič.'),
        'V sobi je bila tišina in nihče ni rekel nič.');
});

test('joinTranscript opens a new sentence only after terminal punctuation', () => {
    assert.equal(joinTranscript('', 'danes je lep dan'), 'Danes je lep dan');
    assert.equal(joinTranscript('Danes je lep dan.', 'jutri bo dež'), 'Danes je lep dan. Jutri bo dež');
    assert.equal(joinTranscript('Danes je lep dan?', 'jutri bo dež'), 'Danes je lep dan? Jutri bo dež');
    assert.equal(joinTranscript('šla sva v Kranj', 'in nazaj'), 'šla sva v Kranj in nazaj');
});

test('joinTranscript ignores an empty or unusable addition', () => {
    assert.equal(joinTranscript('Danes je lep dan.', ''), 'Danes je lep dan.');
    assert.equal(joinTranscript('Danes je lep dan.', '[tišina]'), 'Danes je lep dan.');
    assert.equal(joinTranscript(null, null), '');
});

test('capitalizeFirst handles empty input and leaves the rest alone', () => {
    assert.equal(capitalizeFirst(''), '');
    assert.equal(capitalizeFirst('šla'), 'Šla');
    assert.equal(capitalizeFirst('Kranj je mesto'), 'Kranj je mesto');
});

test('countWords and formatClock', () => {
    assert.equal(countWords(''), 0);
    assert.equal(countWords('  ena   dve tri '), 3);
    assert.equal(formatClock(0), '00:00');
    assert.equal(formatClock(65000), '01:05');
    assert.equal(formatClock(-500), '00:00');
    assert.equal(formatClock(3_600_000), '60:00');
});

test('parseVocabulary trims, dedupes, drops noise and caps the list', () => {
    assert.deepEqual(parseVocabulary(' Ljubljana , Kranj \n Ljubljana ; a '), ['Ljubljana', 'Kranj']);
    assert.deepEqual(parseVocabulary(''), []);
    assert.deepEqual(parseVocabulary(null), []);
    assert.equal(parseVocabulary('x'.repeat(41)).length, 0, 'a 41-character term is not a word');

    const many = Array.from({ length: VOCABULARY_LIMIT + 12 }, (_, i) => `izraz${i}`).join(',');
    assert.equal(parseVocabulary(many).length, VOCABULARY_LIMIT);
});

// ------------------------------------------------------------------
//  4. Proofing
// ------------------------------------------------------------------

test('tokenizeWords splits on any whitespace', () => {
    assert.deepEqual(tokenizeWords(' ena\n dve\tri '), ['ena', 'dve', 'ri']);
    assert.deepEqual(tokenizeWords('   '), []);
});

test('an untouched transcript diffs to a single same run', () => {
    const ops = diffWords('Danes je lep dan.', 'Danes je lep dan.');
    assert.equal(ops.length, 1);
    assert.equal(ops[0].type, 'same');
    const stats = diffStats(ops);
    assert.equal(stats.inserted, 0);
    assert.equal(stats.deleted, 0);
    assert.equal(stats.ratio, 0);
});

test('a punctuation-only correction shows as one word replaced', () => {
    const ops = diffWords('danes je lep dan jutri bo dez', 'danes je lep dan. jutri bo dez');
    const stats = diffStats(ops);
    assert.equal(stats.deleted, 1);
    assert.equal(stats.inserted, 1);
    assert.ok(!isOverreach(stats), 'one word in seven is a proofread, not a rewrite');
});

test('consecutive changes merge into runs so the marks read as phrases', () => {
    const ops = diffWords('ena dve tri stiri', 'ena sest sedem stiri');
    const kinds = ops.map((o) => o.type);
    assert.deepEqual(kinds, ['same', 'del', 'ins', 'same']);
    assert.deepEqual(ops[1].words, ['dve', 'tri']);
    assert.deepEqual(ops[2].words, ['sest', 'sedem']);
});

test('pure insertion and pure deletion are reported as such', () => {
    const inserted = diffStats(diffWords('ena tri', 'ena dve tri'));
    assert.equal(inserted.inserted, 1);
    assert.equal(inserted.deleted, 0);

    const deleted = diffStats(diffWords('ena dve tri', 'ena tri'));
    assert.equal(deleted.deleted, 1);
    assert.equal(deleted.inserted, 0);
});

test('a wholesale rewrite trips the overreach gate', () => {
    const before = 'Midva sva sla v trgovino in kupila kruh za zajtrk.';
    const after = 'Odsla sta v prodajalno ter nabavila pekovsko pecivo za jutranji obrok.';
    const stats = diffStats(diffWords(before, after));

    assert.ok(stats.ratio > OVERREACH_RATIO, `ratio was ${stats.ratio}`);
    assert.ok(isOverreach(stats), 'a rewrite must never apply itself silently');
});

test('diffStats handles both sides empty and text appearing from nothing', () => {
    assert.deepEqual(diffWords('', ''), []);
    assert.equal(diffStats([]).ratio, 0);
    assert.equal(diffStats(diffWords('', 'nekaj besed')).ratio, 1);
});

test('an oversized diff degrades to a whole replacement instead of hanging', () => {
    const before = Array.from({ length: 4200 }, (_, i) => `w${i}`).join(' ');
    const after = `${before} konec`;
    const ops = diffWords(before, after);
    assert.deepEqual(ops.map((o) => o.type), ['del', 'ins']);
});

test('isOverreach respects a caller-supplied limit', () => {
    const stats = diffStats(diffWords('ena dve tri stiri', 'ena dve tri pet'));
    assert.equal(isOverreach(stats, 0.9), false);
    assert.equal(isOverreach(stats, 0.01), true);
});

// ------------------------------------------------------------------
//  5. Translation (the interpreter page)
// ------------------------------------------------------------------

test('normalizeLanguage accepts the spellings a model actually returns', () => {
    for (const value of ['sl', 'SL', ' Slovenian ', 'slovene', 'slv', 'slovenščina']) {
        assert.equal(normalizeLanguage(value), 'sl', `expected sl from ${JSON.stringify(value)}`);
    }
    for (const value of ['en', 'EN', 'English', 'eng', 'angleščina']) {
        assert.equal(normalizeLanguage(value), 'en', `expected en from ${JSON.stringify(value)}`);
    }
    for (const value of ['', 'de', 'gibberish', null, undefined, 42]) {
        assert.equal(normalizeLanguage(value), null);
    }
});

test('otherLanguage flips the pair and refuses to guess', () => {
    assert.equal(otherLanguage('sl'), 'en');
    assert.equal(otherLanguage('en'), 'sl');
    assert.equal(otherLanguage(null), null);
    assert.equal(otherLanguage('de'), null);
});

test('LANGUAGE_LABEL covers exactly the supported codes', () => {
    assert.deepEqual(Object.keys(LANGUAGE_LABEL).sort(), [...LANGUAGE_CODES].sort());
});

test('parseTranslation reads the schema answer and derives the direction', () => {
    const out = parseTranslation('{"lang":"en","source":"Where is the station?","translation":"Kje je postaja?"}');
    assert.deepEqual(out, {
        lang: 'en',
        target: 'sl',
        source: 'Where is the station?',
        translation: 'Kje je postaja?',
    });
});

test('parseTranslation survives a fenced answer', () => {
    const out = parseTranslation('```json\n{"lang":"sl","source":"Kje je postaja?","translation":"Where is the station?"}\n```');
    assert.equal(out.lang, 'sl');
    assert.equal(out.target, 'en');
    assert.equal(out.translation, 'Where is the station?');
});

test('parseTranslation accepts the alternate field names a model may use', () => {
    const out = parseTranslation('{"language":"en","transcript":"Good morning.","translated":"Dobro jutro."}');
    assert.equal(out.lang, 'en');
    assert.equal(out.source, 'Good morning.');
    assert.equal(out.translation, 'Dobro jutro.');
});

test('parseTranslation keeps a prose answer rather than losing the translation', () => {
    const out = parseTranslation('Kje je postaja?');
    assert.equal(out.translation, 'Kje je postaja?');
    assert.equal(out.source, '');
    assert.equal(out.lang, null, 'an unschema-d answer must not claim a direction');
    assert.equal(out.target, null);
});

test('parseTranslation reports nothing when nothing was said', () => {
    assert.equal(parseTranslation('{"lang":"sl","source":"","translation":""}'), null);
    assert.equal(parseTranslation('{"lang":"sl","source":"[tišina]","translation":"..."}'), null);
    assert.equal(parseTranslation(''), null);
    assert.equal(parseTranslation('   '), null);
    assert.equal(parseTranslation(null), null);
    assert.equal(parseTranslation(undefined), null);
});

test('parseTranslation does not mistake an array or a bare value for an answer', () => {
    //? JSON.parse succeeds on these, so the object check is what stops them
    //? being read as a translation with undefined fields.
    assert.equal(parseTranslation('[1,2,3]'), null);
    assert.equal(parseTranslation('null'), null);
    assert.equal(parseTranslation('42').translation, '42', 'a bare number is prose, not a schema answer');
});

test('parseTranslation drops an unusable direction but keeps the text', () => {
    const out = parseTranslation('{"lang":"klingon","source":"nuqneH","translation":"Zdravo"}');
    assert.equal(out.lang, null);
    assert.equal(out.target, null);
    assert.equal(out.translation, 'Zdravo');
});

test('parseTranslation cleans both halves the same way a transcript is cleaned', () => {
    const out = parseTranslation('{"lang":"en","source":"[music] Good  morning.","translation":"Prepis: Dobro jutro."}');
    assert.equal(out.source, 'Good morning.');
    assert.equal(out.translation, 'Dobro jutro.');
});

test('parseTranslation keeps one side when only the other is empty', () => {
    const out = parseTranslation('{"lang":"en","source":"Hello","translation":""}');
    assert.equal(out.source, 'Hello');
    assert.equal(out.translation, '');
});
