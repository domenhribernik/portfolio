// YouTube downloader page: paste a link, the preview loads by itself, then
// Download MP3 / Download MP4 call app/proxys/download.php. Decision logic
// (URL parsing, history rules, error copy, formatters) lives in logic.js and
// is unit-tested by tests/download-logic.test.mjs.
import {
    extractVideoId,
    addHistoryEntry,
    isProbablyExpired,
    errorMessage,
    formatDuration,
    formatSize,
} from './logic.js';

const API = '../../app/proxys/download.php';
const STORAGE_KEY = 'download.history.v1';
const DEBOUNCE_MS = 400;

const els = {
    url: document.getElementById('url'),
    urlHint: document.getElementById('url-hint'),
    urlLoading: document.getElementById('url-loading'),
    error: document.getElementById('error'),
    preview: document.getElementById('preview'),
    thumb: document.getElementById('preview-thumb'),
    title: document.getElementById('preview-title'),
    channel: document.getElementById('preview-channel'),
    duration: document.getElementById('preview-duration'),
    btnMp3: document.getElementById('btn-mp3'),
    btnMp4: document.getElementById('btn-mp4'),
    status: document.getElementById('status'),
    statusSpinner: document.getElementById('status-spinner'),
    statusText: document.getElementById('status-text'),
    recent: document.getElementById('recent'),
    recentList: document.getElementById('recent-list'),
    recentClear: document.getElementById('recent-clear'),
};

let video = null;       // { videoId, title, channel, durationSeconds, thumbnail }
let busy = false;       // one download at a time
let lookupToken = 0;    // drops stale info responses when the input changes
let debounceTimer = null;
let ticker = null;

// ---- shared helpers ------------------------------------------------

async function api(action, payload) {
    const res = await fetch(API + '?action=' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(errorMessage(data.error));
        err.code = data.error;
        throw err;
    }
    return data;
}

function fileUrl(id) {
    return API + '?action=file&id=' + encodeURIComponent(id);
}

// Same-origin navigation to the attachment; the browser shows its own
// download UI and the page stays put.
function triggerDownload(id) {
    const a = document.createElement('a');
    a.href = fileUrl(id);
    document.body.appendChild(a);
    a.click();
    a.remove();
}

function showError(message) {
    els.error.textContent = message;
    els.error.classList.remove('hidden');
}

function clearError() {
    els.error.classList.add('hidden');
}

function stopTicker() {
    if (ticker) {
        clearInterval(ticker);
        ticker = null;
    }
}

function showStatus(text, { spin = false, ok = false } = {}) {
    els.statusText.textContent = text;
    els.statusSpinner.classList.toggle('hidden', !spin);
    els.status.classList.toggle('text-pine', ok);
    els.status.classList.toggle('border-pine', ok);
    els.status.classList.remove('hidden');
}

function hideStatus() {
    stopTicker();
    els.status.classList.add('hidden');
}

function setBusy(value) {
    busy = value;
    els.btnMp3.disabled = value || !video;
    els.btnMp4.disabled = value || !video;
    els.recentList.classList.toggle('pointer-events-none', value);
    els.recentList.classList.toggle('opacity-60', value);
}

// ---- auto-preview on paste ----------------------------------------

function handleUrlChange() {
    const text = els.url.value.trim();
    const token = ++lookupToken;
    clearError();

    if (text === '') {
        els.urlHint.classList.add('hidden');
        els.urlLoading.classList.add('hidden');
        els.preview.classList.add('hidden');
        video = null;
        setBusy(busy);
        return;
    }

    const videoId = extractVideoId(text);
    els.urlHint.classList.toggle('hidden', videoId !== null);
    if (videoId === null) {
        els.urlLoading.classList.add('hidden');
        els.preview.classList.add('hidden');
        video = null;
        setBusy(busy);
        return;
    }
    if (video && video.videoId === videoId) return;

    els.urlLoading.classList.remove('hidden');
    els.preview.classList.add('hidden');
    video = null;
    setBusy(busy);

    api('info', { url: text }).then((data) => {
        if (token !== lookupToken) return;   // the input moved on
        video = data;
        els.thumb.src = data.thumbnail || '';
        els.thumb.alt = data.title;
        els.title.textContent = data.title;
        els.channel.textContent = data.channel || 'unknown channel';
        els.duration.textContent = formatDuration(data.durationSeconds);
        els.urlLoading.classList.add('hidden');
        els.preview.classList.remove('hidden');
        setBusy(busy);
    }).catch((err) => {
        if (token !== lookupToken) return;
        els.urlLoading.classList.add('hidden');
        showError(err.message);
    });
}

els.url.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(handleUrlChange, DEBOUNCE_MS);
});
els.url.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        clearTimeout(debounceTimer);
        handleUrlChange();
    }
});

// ---- downloading ---------------------------------------------------

function runPrepare(url, format, label) {
    if (busy) return Promise.resolve(null);
    setBusy(true);
    clearError();

    const startedAt = Date.now();
    showStatus(label + ' · 0:00', { spin: true });
    ticker = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        showStatus(label + ' · ' + formatDuration(elapsed), { spin: true });
    }, 1000);

    return api('prepare', { url, format }).then((job) => {
        stopTicker();
        showStatus('Saved ' + job.filename + (job.size ? ' (' + formatSize(job.size) + ')' : ''), { ok: true });
        triggerDownload(job.id);
        return job;
    }).catch((err) => {
        hideStatus();
        showError(err.message);
        return null;
    }).finally(() => {
        setBusy(false);
    });
}

function download(format) {
    if (!video) return;
    const title = video.title;
    const videoId = video.videoId;
    runPrepare('https://www.youtube.com/watch?v=' + videoId, format, 'Preparing ' + format.toUpperCase()).then((job) => {
        if (!job) return;
        saveHistory(addHistoryEntry(loadHistory(), {
            id: job.id,
            videoId,
            format,
            filename: job.filename,
            size: job.size,
            title,
            createdAt: Date.now(),
        }));
        renderRecent();
    });
}

els.btnMp3.addEventListener('click', () => download('mp3'));
els.btnMp4.addEventListener('click', () => download('mp4'));

// ---- recent downloads ----------------------------------------------

function loadHistory() {
    try {
        const list = JSON.parse(localStorage.getItem(STORAGE_KEY));
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

function saveHistory(list) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
        // private mode etc.: history just does not persist
    }
}

function redownload(entry) {
    if (busy) return;

    const finish = (job) => {
        if (!job) return;
        saveHistory(addHistoryEntry(loadHistory(), { ...entry, id: job.id, size: job.size, createdAt: Date.now() }));
        renderRecent();
    };
    const reRip = () => runPrepare(
        'https://www.youtube.com/watch?v=' + entry.videoId,
        entry.format,
        'Preparing ' + entry.format.toUpperCase()
    ).then(finish);

    if (isProbablyExpired(entry.createdAt, Date.now())) {
        reRip();
        return;
    }
    // Should still be cached: probe the headers (aborting before the body
    // streams) so an already-pruned file re-rips instead of showing a 404.
    const ctrl = new AbortController();
    fetch(fileUrl(entry.id), { signal: ctrl.signal }).then((res) => {
        const ok = res.ok;
        ctrl.abort();
        if (ok) {
            triggerDownload(entry.id);
        } else {
            reRip();
        }
    }).catch(() => reRip());
}

function renderRecent() {
    const list = loadHistory();
    els.recent.classList.toggle('hidden', list.length === 0);
    els.recentList.textContent = '';

    list.forEach((entry) => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'w-full flex items-center gap-3 text-left px-4 py-3 hover:bg-paper2 transition-colors';

        const main = document.createElement('span');
        main.className = 'min-w-0 flex-1';
        const title = document.createElement('span');
        title.className = 'block truncate text-sm';
        title.textContent = entry.title || entry.filename;
        const meta = document.createElement('span');
        meta.className = 'block font-mono text-[0.68rem] tracking-[0.15em] uppercase text-stone';
        meta.textContent = entry.format + (entry.size ? ' · ' + formatSize(entry.size) : '');
        main.append(title, meta);

        const action = document.createElement('span');
        const expired = isProbablyExpired(entry.createdAt, Date.now());
        action.className = 'shrink-0 font-mono text-[0.68rem] tracking-[0.15em] uppercase '
            + (expired ? 'text-stone' : 'text-pine');
        action.textContent = expired ? 'redo' : 'save';

        button.append(main, action);
        button.addEventListener('click', () => redownload(entry));
        li.appendChild(button);
        els.recentList.appendChild(li);
    });
}

els.recentClear.addEventListener('click', () => {
    saveHistory([]);
    renderRecent();
});

renderRecent();
setBusy(false);
