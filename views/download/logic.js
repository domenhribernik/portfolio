// DOM-free decision logic for the YouTube downloader, unit-tested by
// tests/download-logic.test.mjs (node --test tests/). The page's script.js
// imports this as an ES module.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'];

// Pull the 11-char video id out of a pasted YouTube URL, mirroring the
// accepted shapes in app/proxys/download.php (which stays authoritative).
// Returns null when the text is not a YouTube video link.
export function extractVideoId(url) {
    if (typeof url !== 'string') return null;
    let text = url.trim();
    if (text === '') return null;
    if (!/^https?:\/\//i.test(text)) text = 'https://' + text;

    let parsed;
    try {
        parsed = new URL(text);
    } catch {
        return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (!HOSTS.includes(host)) return null;

    let candidate = null;
    if (host === 'youtu.be' || host === 'www.youtu.be') {
        candidate = parsed.pathname.split('/')[1] || '';
    } else if (parsed.pathname === '/watch') {
        candidate = parsed.searchParams.get('v');
    } else {
        const m = parsed.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/);
        candidate = m ? m[1] : null;
    }
    return candidate !== null && VIDEO_ID.test(candidate) ? candidate : null;
}

export const HISTORY_CAP = 8;

// Prepend a finished rip to the recent list: newest first, a repeat of the
// same job replaces its older entry, capped at HISTORY_CAP. Pure, the input
// list is never mutated (it round-trips through localStorage).
export function addHistoryEntry(list, entry) {
    return [entry, ...list.filter((e) => e.id !== entry.id)].slice(0, HISTORY_CAP);
}

const SERVER_TTL_MS = 3 * 60 * 60 * 1000;   // MAX_AGE_SECONDS in the proxy

// Whether the server's cached copy of a rip has likely been pruned already,
// so a history click should re-rip instead of fetching. A missing timestamp
// counts as expired: re-ripping is always safe, fetching a 404 is not.
export function isProbablyExpired(createdAtMs, nowMs) {
    return typeof createdAtMs !== 'number' || nowMs - createdAtMs > SERVER_TTL_MS;
}

// Human messages for the proxy's snake_case error codes.
const ERRORS = {
    invalid_url: 'That link does not point at a YouTube video.',
    invalid_format: 'Unknown format.',
    ytdlp_missing: 'The download tool is not installed on this server.',
    live_stream: 'Live streams cannot be downloaded.',
    video_rejected: 'Video refused: longer than 2 hours, larger than 500 MB, or live.',
    info_timeout: 'YouTube took too long to answer, try again.',
    download_timeout: 'The download took too long, try a shorter video.',
    info_failed: 'Could not read that video, is the link right?',
    download_failed: 'The download failed on the server, try again in a bit.',
    busy: 'The server is busy with other downloads, try again in a minute.',
    not_found: 'That file has expired on the server, download it again.',
};
const GENERIC_ERROR = 'Something went wrong, try again.';

export function errorMessage(code) {
    return ERRORS[code] || GENERIC_ERROR;
}

export function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return (h > 0 ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

export function formatSize(bytes) {
    if (!bytes) return '';
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? mb.toFixed(1) + ' MB' : Math.ceil(bytes / 1024) + ' KB';
}
