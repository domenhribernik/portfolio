//? Narek, dictation page: the record sheet and its AI proofread.
//?
//? Everything above the sheet (gate, transport key, trace, clock, banner,
//? toast) belongs to deck.js and is shared with the interpreter page. This
//? file owns the sheet, the network calls and the proof marks.

import {
    joinTranscript,
    cleanTranscript,
    countWords,
    formatClock,
    parseVocabulary,
    diffWords,
    diffStats,
    isOverreach,
} from './logic.js';
import { createDeck } from './deck.js';

const API = '../../app/proxys/narek.php';
const VOCAB_KEY = 'narek.vocab';

const el = (id) => document.getElementById(id);

const ui = {
    sheetRows: el('sheetRows'),
    sheetEmpty: el('sheetEmpty'),
    sheetMode: el('sheetMode'),
    countWords: el('countWords'),
    countSegments: el('countSegments'),
    proof: el('proof'),
    proofBody: el('proofBody'),
    proofStats: el('proofStats'),
    proofOverreach: el('proofOverreach'),
    proofAccept: el('proofAccept'),
    proofReject: el('proofReject'),
    correctBtn: el('correctBtn'),
    revertBtn: el('revertBtn'),
    copyBtn: el('copyBtn'),
    downloadBtn: el('downloadBtn'),
    clearBtn: el('clearBtn'),
    vocabInput: el('vocabInput'),
    vocabCount: el('vocabCount'),
};

const state = {
    segments: [],      //? { id, offsetMs, durationMs, text, status, wav }
    rawBackup: null,   //? the segments as dictated, kept so a proofread is undoable
    proof: null,       //? { ops, stats, text }
    nextId: 1,
    busy: false,
};

//? A proofread collapses the record into one corrected segment rather than
//? living in a field of its own, so dictating afterwards keeps working and
//? every reader below has exactly one place to look.
function transcript() {
    return state.segments
        .filter((s) => s.status === 'done' && s.text)
        .reduce((acc, s) => joinTranscript(acc, s.text), '');
}

// ============================================================
//  The sheet
// ============================================================

function segmentRow(segment) {
    const li = document.createElement('li');
    li.className = 'seg-row';
    li.dataset.id = String(segment.id);

    const time = document.createElement('span');
    time.className = 'seg-time';
    time.textContent = formatClock(segment.offsetMs);

    const body = document.createElement('div');
    body.className = 'seg-text';

    li.append(time, body);
    paintRow(li, segment);
    return li;
}

function paintRow(li, segment) {
    const body = li.querySelector('.seg-text');
    li.classList.toggle('is-pending', segment.status === 'pending');
    li.classList.toggle('is-failed', segment.status === 'failed');
    body.innerHTML = '';

    if (segment.status === 'pending') {
        body.contentEditable = 'false';
        body.removeAttribute('role');
        const one = document.createElement('span');
        one.className = 'pending-bar';
        const two = document.createElement('span');
        two.className = 'pending-bar';
        body.append(one, two);
        return;
    }

    if (segment.status === 'failed') {
        body.contentEditable = 'false';
        const note = document.createElement('span');
        note.className = 'font-mono text-[0.72rem] text-clay';
        note.textContent = segment.error || 'Prepis ni uspel.';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'seg-retry';
        retry.textContent = 'poskusi znova';
        retry.addEventListener('click', () => sendSegment(segment));
        body.append(note, retry);
        return;
    }

    body.contentEditable = 'true';
    body.spellcheck = false;
    body.setAttribute('role', 'textbox');
    body.setAttribute('aria-label', `Odsek ob ${formatClock(segment.offsetMs)}`);
    body.textContent = segment.text;
}

function renderSheet() {
    const hasRows = state.segments.length > 0;
    ui.sheetEmpty.classList.toggle('hidden', hasRows);
    ui.sheetRows.classList.toggle('hidden', !hasRows);
    ui.sheetMode.textContent = state.rawBackup ? 'lektorirano' : 'surov prepis';

    //? Reconcile rather than rebuild: rebuilding would steal the caret from a
    //? row the visitor is editing while another segment is still in flight.
    const seen = new Set();
    for (const segment of state.segments) {
        seen.add(String(segment.id));
        let li = ui.sheetRows.querySelector(`[data-id="${segment.id}"]`);
        if (!li) {
            li = segmentRow(segment);
            li.classList.add('is-new');
            ui.sheetRows.append(li);
            bindRowEditing(li, segment);
        } else if (li.dataset.status !== segment.status) {
            paintRow(li, segment);
            bindRowEditing(li, segment);
        }
        li.dataset.status = segment.status;
    }
    for (const li of Array.from(ui.sheetRows.children)) {
        if (!seen.has(li.dataset.id)) li.remove();
    }

    updateCounters();
}

function bindRowEditing(li, segment) {
    const body = li.querySelector('.seg-text');
    if (body.contentEditable !== 'true') return;
    body.addEventListener('input', () => {
        segment.text = body.innerText.trim();
        updateCounters();
    });
    body.addEventListener('paste', (event) => {
        event.preventDefault();
        const text = (event.clipboardData || window.clipboardData).getData('text/plain');
        document.execCommand('insertText', false, text.replace(/\s+/g, ' '));
    });
}

function updateCounters() {
    const text = transcript();
    const done = state.segments.filter((s) => s.status === 'done').length;

    ui.countWords.textContent = String(countWords(text));
    ui.countSegments.textContent = String(done);

    //? Never proofread a record that is still filling in: the diff would be
    //? computed against half a transcript and the rest would arrive orphaned.
    const usable = countWords(text) >= 3;
    ui.correctBtn.disabled = !usable || deck.recording || state.busy || deck.inFlight > 0;
    ui.copyBtn.disabled = !text;
    ui.downloadBtn.disabled = !text;
    ui.clearBtn.disabled = !text && state.segments.length === 0;
    ui.revertBtn.classList.toggle('hidden', state.rawBackup == null);
}

// ============================================================
//  Network
// ============================================================

function vocabTerms() {
    return parseVocabulary(ui.vocabInput.value);
}

async function readError(response) {
    try {
        const body = await response.json();
        if (body && body.message) return body.message;
    } catch { /* fall through to the generic line */ }
    return `Strežnik je vrnil napako (${response.status}).`;
}

async function sendSegment(segment) {
    segment.status = 'pending';
    segment.error = '';
    renderSheet();
    deck.enter();

    const terms = vocabTerms();
    const query = terms.length ? `&vocab=${encodeURIComponent(terms.join(','))}` : '';

    try {
        const response = await fetch(`${API}?action=transcribe${query}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: segment.wav,
        });

        if (!response.ok) {
            segment.status = 'failed';
            segment.error = await readError(response);
            if (deck.gated(response.status)) return;
            if (response.status === 503 || response.status === 502) {
                deck.banner('Prepis ni na voljo', segment.error);
            }
            return;
        }

        const body = await response.json();
        deck.setModel(body.model);

        const text = cleanTranscript(body.text);
        if (!text) {
            //? The model heard the segment and found no words in it. Dropping
            //? the row keeps the record honest; the state line says why.
            state.segments = state.segments.filter((s) => s.id !== segment.id);
            deck.flashState('Odsek brez govora');
            return;
        }

        segment.text = text;
        segment.status = 'done';
        deck.clearBanner();
    } catch {
        segment.status = 'failed';
        segment.error = 'Ni povezave s strežnikom.';
    } finally {
        deck.leave();
        renderSheet();
    }
}

async function runCorrection() {
    const source = transcript();
    if (!source) return;

    state.busy = true;
    ui.correctBtn.disabled = true;
    const original = ui.correctBtn.textContent;
    ui.correctBtn.textContent = 'Lektoriram…';

    try {
        const response = await fetch(`${API}?action=correct`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: source, vocab: vocabTerms() }),
        });

        if (!response.ok) {
            const message = await readError(response);
            if (deck.gated(response.status)) return;
            deck.banner('Lektoriranje ni uspelo', message);
            return;
        }

        const body = await response.json();
        deck.setModel(body.model);

        const corrected = cleanTranscript(body.text);
        if (!corrected) {
            deck.banner('Lektoriranje ni uspelo', 'Lektor je vrnil prazno besedilo. Besedilo ostaja nespremenjeno.');
            return;
        }

        const ops = diffWords(source, corrected);
        const stats = diffStats(ops);

        if (stats.inserted === 0 && stats.deleted === 0) {
            deck.toast('Ni česa popraviti');
            deck.clearBanner();
            return;
        }

        state.proof = { ops, stats, text: corrected, source };
        deck.clearBanner();
        renderProof();
    } catch {
        deck.banner('Lektoriranje ni uspelo', 'Ni povezave s strežnikom.');
    } finally {
        state.busy = false;
        ui.correctBtn.textContent = original;
        updateCounters();
    }
}

// ============================================================
//  The proof sheet
// ============================================================

function renderProof() {
    const proof = state.proof;
    if (!proof) {
        ui.proof.classList.add('hidden');
        return;
    }

    ui.proofBody.innerHTML = '';
    for (const op of proof.ops) {
        const span = document.createElement('span');
        span.textContent = `${op.words.join(' ')} `;
        if (op.type === 'del') {
            span.className = 'mark-del';
            span.title = 'odstranjeno';
        } else if (op.type === 'ins') {
            span.className = 'mark-ins';
            span.title = 'dodano';
        }
        ui.proofBody.append(span);
    }

    const percent = Math.round(proof.stats.ratio * 100);
    ui.proofStats.textContent =
        `${proof.stats.deleted} odstranjenih · ${proof.stats.inserted} dodanih · ${percent} % besedila`;
    ui.proofOverreach.classList.toggle('hidden', !isOverreach(proof.stats));

    ui.proof.classList.remove('hidden');
    ui.proof.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function acceptProof() {
    if (!state.proof) return;
    state.rawBackup = state.segments;
    state.segments = [{
        id: state.nextId++,
        offsetMs: 0,
        durationMs: deck.elapsedMs,
        text: state.proof.text,
        status: 'done',
        wav: null,
    }];
    state.proof = null;
    ui.proof.classList.add('hidden');
    ui.sheetRows.innerHTML = '';
    renderSheet();
    deck.toast('Popravki sprejeti');
}

function rejectProof() {
    state.proof = null;
    ui.proof.classList.add('hidden');
    deck.toast('Popravki zavrnjeni');
}

//? Restores the dictated segments, and keeps anything dictated after the
//? proofread was accepted: ids are monotonic, so "newer than the backup" is
//? exactly the set the correction never saw.
function revertCorrection() {
    if (!state.rawBackup) return;
    const newest = state.rawBackup.reduce((max, s) => Math.max(max, s.id), 0);
    state.segments = [...state.rawBackup, ...state.segments.filter((s) => s.id > newest + 1)];
    state.rawBackup = null;
    state.proof = null;
    ui.proof.classList.add('hidden');
    ui.sheetRows.innerHTML = '';
    renderSheet();
    deck.toast('Nazaj na surov prepis');
}

// ============================================================
//  Actions
// ============================================================

async function copyTranscript() {
    const text = transcript();
    if (!text) return;
    try {
        await navigator.clipboard.writeText(text);
        deck.toast('Kopirano');
    } catch {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.append(area);
        area.select();
        document.execCommand('copy');
        area.remove();
        deck.toast('Kopirano');
    }
}

function downloadTranscript() {
    const text = transcript();
    if (!text) return;
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `narek_${stamp}.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    deck.toast('Preneseno');
}

function clearAll() {
    if (state.segments.length && !window.confirm('Počistim zapisnik?')) return;
    deck.stop();
    state.segments = [];
    state.rawBackup = null;
    state.proof = null;
    state.nextId = 1;
    ui.sheetRows.innerHTML = '';
    ui.proof.classList.add('hidden');
    deck.resetClock();
    deck.clearBanner();
    renderSheet();
    deck.setState('Pripravljen');
}

// ============================================================
//  Vocabulary
// ============================================================

function syncVocabCount() {
    const terms = parseVocabulary(ui.vocabInput.value);
    ui.vocabCount.textContent = terms.length ? `${terms.length} izrazov` : '';
}

function loadVocab() {
    try {
        const saved = localStorage.getItem(VOCAB_KEY);
        if (saved) ui.vocabInput.value = saved;
    } catch { /* private mode: the slovar just does not persist */ }
    syncVocabCount();
}

function saveVocab() {
    try {
        localStorage.setItem(VOCAB_KEY, ui.vocabInput.value);
    } catch { /* nothing to do, the terms still apply this session */ }
    syncVocabCount();
}

// ============================================================
//  Boot
// ============================================================

const deck = createDeck({
    api: API,
    accountPath: '../account/',
    onSegment: ({ wav, durationMs, offsetMs }) => {
        const segment = { id: state.nextId++, offsetMs, durationMs, text: '', status: 'pending', wav };
        state.segments.push(segment);
        renderSheet();
        sendSegment(segment);
    },
    onReady: () => renderSheet(),
    onStateChange: updateCounters,
});

ui.correctBtn.addEventListener('click', runCorrection);
ui.proofAccept.addEventListener('click', acceptProof);
ui.proofReject.addEventListener('click', rejectProof);
ui.revertBtn.addEventListener('click', revertCorrection);
ui.copyBtn.addEventListener('click', copyTranscript);
ui.downloadBtn.addEventListener('click', downloadTranscript);
ui.clearBtn.addEventListener('click', clearAll);
ui.vocabInput.addEventListener('input', saveVocab);

loadVocab();
renderSheet();
deck.start();
