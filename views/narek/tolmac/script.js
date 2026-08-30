//? Tolmač: the interpreter log.
//?
//? The deck above (gate, transport key, trace, clock) is shared with the
//? dictation page. This file owns the two-column log and one network call.
//? The direction is never a setting: the model reads it off the audio, and
//? every row shows both halves so a translation is never taken on trust.

import { countWords, formatClock, parseVocabulary, parseTranslation, LANGUAGE_LABEL } from '../logic.js';
import { createDeck } from '../deck.js';

const API = '../../../app/proxys/narek.php';
const VOCAB_KEY = 'narek.vocab'; //? shared with the dictation page on purpose

const el = (id) => document.getElementById(id);

const ui = {
    sheetRows: el('sheetRows'),
    sheetEmpty: el('sheetEmpty'),
    countWords: el('countWords'),
    countSegments: el('countSegments'),
    copyBtn: el('copyBtn'),
    downloadBtn: el('downloadBtn'),
    clearBtn: el('clearBtn'),
    vocabInput: el('vocabInput'),
    vocabCount: el('vocabCount'),
};

const state = {
    lines: [],   //? { id, offsetMs, status, wav, lang, target, source, translation, error }
    nextId: 1,
};

const translations = () => state.lines.filter((l) => l.status === 'done' && l.translation);

// ============================================================
//  The log
// ============================================================

function chip(code, muted) {
    const span = document.createElement('span');
    span.className = muted ? 'tr-chip tr-chip--muted' : 'tr-chip';
    span.textContent = code ? LANGUAGE_LABEL[code] : '??';
    return span;
}

function cell(className, code, muted, text) {
    const div = document.createElement('div');
    div.className = `tr-cell ${className}`;
    div.append(chip(code, muted));
    const p = document.createElement('p');
    p.className = 'tr-text';
    p.textContent = text;
    div.append(p);
    return div;
}

function lineRow(line) {
    const li = document.createElement('li');
    li.className = 'tr-row';
    li.dataset.id = String(line.id);

    const time = document.createElement('span');
    time.className = 'seg-time';
    time.textContent = formatClock(line.offsetMs);

    const pair = document.createElement('div');
    pair.className = 'tr-pair';

    li.append(time, pair);
    paintRow(li, line);
    return li;
}

function paintRow(li, line) {
    const pair = li.querySelector('.tr-pair');
    li.classList.toggle('is-pending', line.status === 'pending');
    li.classList.toggle('is-failed', line.status === 'failed');
    pair.innerHTML = '';

    if (line.status === 'pending') {
        const wrap = document.createElement('div');
        wrap.className = 'tr-cell';
        const one = document.createElement('span');
        one.className = 'pending-bar';
        const two = document.createElement('span');
        two.className = 'pending-bar';
        wrap.append(one, two);
        pair.append(wrap);
        return;
    }

    if (line.status === 'failed') {
        const wrap = document.createElement('div');
        wrap.className = 'tr-cell';
        const note = document.createElement('span');
        note.className = 'font-mono text-[0.72rem] text-clay';
        note.textContent = line.error || 'Prevod ni uspel.';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'seg-retry';
        retry.textContent = 'poskusi znova';
        retry.addEventListener('click', () => sendLine(line));
        wrap.append(note, retry);
        pair.append(wrap);
        return;
    }

    //? A model that ignored the schema still translated something; show it in
    //? the output column alone rather than pretending it heard nothing.
    if (line.source) {
        pair.append(cell('tr-src', line.lang, true, line.source));
    }
    pair.append(cell('tr-out', line.target, false, line.translation));
}

function renderLog() {
    const has = state.lines.length > 0;
    ui.sheetEmpty.classList.toggle('hidden', has);
    ui.sheetRows.classList.toggle('hidden', !has);

    const seen = new Set();
    for (const line of state.lines) {
        seen.add(String(line.id));
        let li = ui.sheetRows.querySelector(`[data-id="${line.id}"]`);
        if (!li) {
            li = lineRow(line);
            li.classList.add('is-new');
            ui.sheetRows.append(li);
        } else if (li.dataset.status !== line.status) {
            paintRow(li, line);
        }
        li.dataset.status = line.status;
    }
    for (const li of Array.from(ui.sheetRows.children)) {
        if (!seen.has(li.dataset.id)) li.remove();
    }

    updateCounters();
}

function updateCounters() {
    const done = translations();
    const words = done.reduce((sum, l) => sum + countWords(l.translation), 0);

    ui.countWords.textContent = String(words);
    ui.countSegments.textContent = String(done.length);

    const any = done.length > 0;
    ui.copyBtn.disabled = !any;
    ui.downloadBtn.disabled = !any;
    ui.clearBtn.disabled = state.lines.length === 0;
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

async function sendLine(line) {
    line.status = 'pending';
    line.error = '';
    renderLog();
    deck.enter();

    const terms = vocabTerms();
    const query = terms.length ? `&vocab=${encodeURIComponent(terms.join(','))}` : '';

    try {
        const response = await fetch(`${API}?action=translate${query}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: line.wav,
        });

        if (!response.ok) {
            line.status = 'failed';
            line.error = await readError(response);
            if (deck.gated(response.status)) return;
            if (response.status === 503 || response.status === 502) {
                deck.banner('Prevod ni na voljo', line.error);
            }
            return;
        }

        const body = await response.json();
        deck.setModel(body.model);

        const parsed = parseTranslation(body.text);
        if (!parsed) {
            state.lines = state.lines.filter((l) => l.id !== line.id);
            deck.flashState('Odsek brez govora');
            return;
        }

        Object.assign(line, parsed, { status: 'done' });
        deck.clearBanner();
    } catch {
        line.status = 'failed';
        line.error = 'Ni povezave s strežnikom.';
    } finally {
        deck.leave();
        renderLog();
    }
}

// ============================================================
//  Actions
// ============================================================

function translationText() {
    return translations().map((l) => l.translation).join('\n');
}

function transcriptText() {
    return translations()
        .map((l) => {
            const from = l.lang ? LANGUAGE_LABEL[l.lang] : '??';
            const to = l.target ? LANGUAGE_LABEL[l.target] : '??';
            const heard = l.source ? `${from}  ${l.source}\n` : '';
            return `[${formatClock(l.offsetMs)}]\n${heard}${to}  ${l.translation}`;
        })
        .join('\n\n');
}

async function copyTranslation() {
    const text = translationText();
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

function downloadLog() {
    const text = transcriptText();
    if (!text) return;
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tolmac_${stamp}.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    deck.toast('Preneseno');
}

function clearAll() {
    if (state.lines.length && !window.confirm('Počistim zapisnik?')) return;
    deck.stop();
    state.lines = [];
    state.nextId = 1;
    ui.sheetRows.innerHTML = '';
    deck.resetClock();
    deck.clearBanner();
    renderLog();
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
    accountPath: '../../account/',
    onSegment: ({ wav, offsetMs }) => {
        const line = {
            id: state.nextId++,
            offsetMs,
            status: 'pending',
            wav,
            lang: null,
            target: null,
            source: '',
            translation: '',
        };
        state.lines.push(line);
        renderLog();
        sendLine(line);
    },
    onReady: () => renderLog(),
    onStateChange: updateCounters,
});

ui.copyBtn.addEventListener('click', copyTranslation);
ui.downloadBtn.addEventListener('click', downloadLog);
ui.clearBtn.addEventListener('click', clearAll);
ui.vocabInput.addEventListener('input', saveVocab);

loadVocab();
renderLog();
deck.start();
