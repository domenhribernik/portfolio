<?php
declare(strict_types=1);

// Still-image variant of ../index.html, built for the car. The Tesla browser
// only paints <video> (and anything decoded from it) while parked, so this
// page never touches the HLS feed: it renders the newest server-side capture
// as an ordinary <img>, which loads while driving.
//
// The filename is printed into the markup here rather than assigned by JS, so
// the picture does not depend on scripting at all. Each capture carries a
// fresh random name, which doubles as cache busting and keeps the still off a
// guessable URL.

$shotsDir = __DIR__ . '/shots';
$shots = glob($shotsDir . '/shot-*.jpg') ?: [];
usort($shots, fn($a, $b) => filemtime($b) <=> filemtime($a));

$latest = $shots === [] ? null : 'shots/' . basename($shots[0]);
$latestAge = $latest === null ? null : time() - filemtime($shots[0]);

// The HTML must never be cached: it carries the current filename.
header('Cache-Control: no-store');
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <meta name="robots" content="noindex, nofollow">
    <meta name="referrer" content="no-referrer">
    <meta name="theme-color" content="#0a0a0a">
    <title>Vrata (frame)</title>
    <link rel="icon" type="image/x-icon" href="../../../assets/favicon.ico" />
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="Vrata">
    <link rel="apple-touch-icon" href="../icon-192.png">
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-[100dvh] bg-neutral-950 text-neutral-100 font-sans antialiased flex flex-col items-center justify-center p-4 sm:p-6"
      style="padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom);">

    <main class="w-full flex flex-col items-center gap-4">

        <!-- Key entry view -->
        <section id="keyView" class="hidden w-full max-w-sm sm:max-w-md bg-neutral-900 border border-neutral-800 rounded-2xl p-5 sm:p-6 shadow-xl">
            <h1 class="text-lg font-medium mb-1">Enter key</h1>
            <p class="text-sm text-neutral-400 mb-4">Stored locally on this device only.</p>
            <form id="keyForm" autocomplete="off" novalidate>
                <input
                    id="keyInput"
                    type="password"
                    inputmode="text"
                    autocomplete="off"
                    autocapitalize="off"
                    autocorrect="off"
                    spellcheck="false"
                    name="k"
                    class="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-3 text-base font-mono tracking-tight outline-none focus:border-neutral-600 focus:ring-1 focus:ring-neutral-600"
                    aria-label="Access key"
                    required>
                <button
                    type="submit"
                    class="mt-3 w-full bg-neutral-100 text-neutral-900 font-medium rounded-lg py-3 text-base hover:bg-white active:bg-neutral-200 transition">
                    Save
                </button>
            </form>
        </section>

        <!-- Action view -->
        <section id="actionView" class="hidden w-full max-w-sm sm:max-w-md md:max-w-4xl lg:max-w-5xl xl:max-w-6xl flex flex-col gap-6">

            <!-- Top bar -->
            <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                    <button
                        id="refreshBtn"
                        type="button"
                        aria-label="Osveži sliko"
                        class="inline-flex items-center gap-2 text-sm text-neutral-200 hover:text-white active:text-white disabled:opacity-50 disabled:cursor-not-allowed transition px-4 py-3 rounded-xl bg-neutral-900 border border-neutral-800 hover:border-neutral-700">
                        <svg id="refreshIcon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2" class="w-5 h-5">
                            <path stroke-linecap="round" stroke-linejoin="round"
                                  d="M16.023 9.348h4.992V4.356m-4.992 4.992-1.65-1.65a7.5 7.5 0 1 0 1.35 8.577"/>
                        </svg>
                        <span id="refreshLabel">Osveži</span>
                    </button>

                    <!-- Escape hatch: a reload re-renders with the newest file. -->
                    <button
                        id="reloadBtn"
                        type="button"
                        aria-label="Ponovno naloži stran"
                        class="inline-flex items-center text-xs text-neutral-400 hover:text-neutral-100 transition px-3 py-3 rounded-xl border border-transparent hover:border-neutral-800 hover:bg-neutral-900">
                        Naloži stran
                    </button>
                </div>

                <button
                    id="forgetBtn"
                    type="button"
                    aria-label="Odjavi se"
                    class="inline-flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-100 active:text-white transition px-3 py-2 rounded-lg hover:bg-neutral-900 border border-transparent hover:border-neutral-800">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" stroke-width="2" class="w-4 h-4">
                        <path stroke-linecap="round" stroke-linejoin="round"
                              d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15M12 9l-3 3m0 0 3 3m-3-3h12.75"/>
                    </svg>
                    <span>Odjavi se</span>
                </button>
            </div>

            <!-- Camera still -->
            <div class="bg-neutral-900 border border-neutral-800 rounded-2xl overflow-hidden shadow-xl">
                <div class="relative w-full aspect-video bg-neutral-950">
<?php if ($latest !== null): ?>
                    <img id="doorImg" src="<?= htmlspecialchars($latest, ENT_QUOTES) ?>" alt="Kamera pri vratih"
                         class="absolute inset-0 w-full h-full object-cover">
<?php else: ?>
                    <img id="doorImg" alt="Kamera pri vratih"
                         class="absolute inset-0 w-full h-full object-cover hidden">
<?php endif; ?>

                    <div id="frameOverlay"
                         class="<?= $latest === null ? '' : 'hidden ' ?>absolute inset-0 flex items-center justify-center bg-neutral-950/70 text-sm text-neutral-300 text-center px-4">
                        <div id="frameSpinner"
                             class="hidden w-16 h-16 rounded-full border-4 border-neutral-500/50 border-t-neutral-100 animate-spin"
                             role="status" aria-label="Zajemam sliko"></div>
                        <span id="frameMsg"><?= $latest === null ? 'Slike še ni. Pritisni Osveži.' : '' ?></span>
                    </div>

                    <div id="frameStamp"
                         class="<?= $latestAge === null ? 'hidden ' : '' ?>absolute bottom-2 left-2 sm:bottom-3 sm:left-3 bg-black/60 backdrop-blur-sm px-2 py-1 rounded-md pointer-events-none text-xs font-mono text-neutral-200"><?= $latestAge === null ? '' : 'Posneto pred ' . max(0, (int) round($latestAge / 60)) . ' min' ?></div>
                </div>
            </div>

            <!-- Unlock -->
            <div class="w-full max-w-sm sm:max-w-md mx-auto flex flex-col items-center px-8 mt-2">
                <button
                    id="openBtn"
                    type="button"
                    class="w-full bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 disabled:bg-neutral-700 disabled:cursor-not-allowed disabled:shadow-none text-neutral-950 font-semibold rounded-2xl py-5 sm:py-6 text-lg sm:text-xl tracking-wide transition-all shadow-lg shadow-emerald-500/30 hover:shadow-xl hover:shadow-emerald-500/40 ring-1 ring-emerald-400/30 flex items-center justify-center gap-2.5">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" stroke-width="2" class="w-6 h-6">
                        <path stroke-linecap="round" stroke-linejoin="round"
                              d="M13.5 10.5V6.75a4.5 4.5 0 1 1 9 0v3.75M3.75 21.75h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H3.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"/>
                    </svg>
                    <span id="openLabel">Odpri</span>
                </button>
                <p id="statusMsg" class="mt-3 text-sm text-center text-neutral-400 min-h-[1.25rem]" aria-live="polite"></p>
            </div>

        </section>

    </main>

<script>
(() => {
    'use strict';

    // Nothing here decodes video. Refresh POSTs 'snapshot', the proxy runs
    // ffmpeg server-side and writes a new randomly named still, and we point
    // the <img> at the filename it returns. Key handling and the unlock call
    // are unchanged from ../index.html.

    const STORAGE_KEY = '_dk';
    const ENDPOINT = '../../../app/proxys/vrata.php';
    const REQUEST_TIMEOUT_MS = 10000;
    const SNAPSHOT_TIMEOUT_MS = 75000;  // server retries the camera warm-up

    // There is no console in the car, so the overlay has to carry the reason.
    // Anything unmapped still shows its raw code rather than a shrug.
    const CAPTURE_ERRORS = {
        stream_unreachable:    'Strežnik ne doseže kamere. Vrata 8080 so blokirana.',
        stream_failed:         'Kamera ni vrnila povezave.',
        capture_failed:        'Zajem slike ni uspel.',
        exec_disabled:         'Strežnik ne sme zaganjati programov.',
        ffmpeg_missing:        'Na strežniku ni ffmpeg.',
        ffmpeg_not_executable: 'ffmpeg na strežniku ni izvršljiv.',
        write_failed:          'Slike ni bilo mogoče shraniti.',
        camera_not_configured: 'Kamera ni nastavljena.',
    };

    const keyView      = document.getElementById('keyView');
    const actionView   = document.getElementById('actionView');
    const keyForm      = document.getElementById('keyForm');
    const keyInput     = document.getElementById('keyInput');
    const openBtn      = document.getElementById('openBtn');
    const openLabel    = document.getElementById('openLabel');
    const forgetBtn    = document.getElementById('forgetBtn');
    const refreshBtn   = document.getElementById('refreshBtn');
    const refreshIcon  = document.getElementById('refreshIcon');
    const refreshLabel = document.getElementById('refreshLabel');
    const reloadBtn    = document.getElementById('reloadBtn');
    const statusMsg    = document.getElementById('statusMsg');
    const doorImg      = document.getElementById('doorImg');
    const frameOverlay = document.getElementById('frameOverlay');
    const frameSpinner = document.getElementById('frameSpinner');
    const frameMsg     = document.getElementById('frameMsg');
    const frameStamp   = document.getElementById('frameStamp');

    let inFlight = false;
    let capturing = false;

    const safeGetKey = () => {
        try { return localStorage.getItem(STORAGE_KEY); }
        catch { return null; }
    };
    const safeSetKey = (v) => {
        try { localStorage.setItem(STORAGE_KEY, v); return true; }
        catch { return false; }
    };
    const safeClearKey = () => {
        try { localStorage.removeItem(STORAGE_KEY); } catch {}
    };

    // The overlay carries either the spinner or a message, never both.
    const setOverlay = (text) => {
        frameMsg.textContent = text || '';
        frameSpinner.classList.add('hidden');
        frameOverlay.classList.toggle('hidden', !text);
    };

    const setBusy = () => {
        frameMsg.textContent = '';
        frameSpinner.classList.remove('hidden');
        frameOverlay.classList.remove('hidden');
    };

    // Only ever accept a filename the server just handed us.
    const showShot = (file) => {
        if (!/^shots\/shot-[0-9a-f]{32}\.jpg$/.test(file || '')) return;
        doorImg.src = file;
        doorImg.classList.remove('hidden');
    };

    doorImg.addEventListener('error', () => setOverlay('Slike ni bilo mogoče naložiti.'));

    const showView = (which) => {
        keyView.classList.toggle('hidden', which !== 'key');
        actionView.classList.toggle('hidden', which !== 'action');
        if (which === 'key') {
            keyInput.value = '';
            setTimeout(() => keyInput.focus(), 0);
        }
    };

    // The key is sent in the JSON body of a POST, never in the URL: query
    // strings leak into logs/history/Referer and a GET would let link-preview
    // and prefetch bots trip the door (SEC-03). credentials:'same-origin' so
    // the session cookie flows, letting a signed-in user with the vrata role
    // work even without a key.
    const callEndpoint = (payload, signal) => fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal,
    });

    const setStatus = (text, tone) => {
        statusMsg.textContent = text || '';
        statusMsg.className = 'mt-3 text-sm text-center min-h-[1.25rem] ' + (
            tone === 'ok'   ? 'text-emerald-400' :
            tone === 'err'  ? 'text-red-400'     :
                              'text-neutral-400'
        );
    };

    const capture = async () => {
        if (capturing) return;
        capturing = true;
        refreshBtn.disabled = true;
        refreshIcon.classList.add('animate-spin');
        refreshLabel.textContent = 'Zajemam…';
        setBusy();

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS);

        try {
            const key = safeGetKey();
            const res = await callEndpoint({ action: 'snapshot', key: key || '' }, controller.signal);

            if (res.status === 401 || res.status === 403) {
                safeClearKey();
                showView('key');
                return;
            }
            if (res.status === 429) {
                setOverlay('Preveč poskusov. Počakaj nekaj minut.');
                return;
            }
            if (!res.ok) {
                const why = await res.json().then((d) => d.error).catch(() => null);
                setOverlay(CAPTURE_ERRORS[why]
                    || ('Zajem ni uspel (' + (why || res.status) + ').'));
                return;
            }

            const data = await res.json().catch(() => ({}));
            showShot(data.file);
            frameStamp.textContent = 'Posneto zdaj';
            frameStamp.classList.remove('hidden');
            setOverlay(data.blank ? 'Kamera se še prebuja. Poskusi znova.' : '');
        } catch (err) {
            setOverlay(err.name === 'AbortError'
                ? 'Zajem je potekel. Poskusi znova.'
                : 'Napaka omrežja.');
        } finally {
            clearTimeout(timer);
            capturing = false;
            refreshBtn.disabled = false;
            refreshIcon.classList.remove('animate-spin');
            refreshLabel.textContent = 'Osveži';
        }
    };

    const init = () => {
        const stored = safeGetKey();
        if (stored && stored.length > 0) {
            // The server already rendered the newest still, so there is
            // something on screen while this fresh grab runs.
            showView('action');
            capture();
        } else {
            showView('key');
        }
    };

    keyForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = keyInput.value.trim();
        if (!v) return;
        if (!safeSetKey(v)) {
            setStatus('Could not save key on this device.', 'err');
            return;
        }
        keyInput.value = '';
        showView('action');
        setStatus('', null);
        capture();
    });

    forgetBtn.addEventListener('click', () => {
        safeClearKey();
        setStatus('', null);
        showView('key');
    });

    refreshBtn.addEventListener('click', () => capture());
    reloadBtn.addEventListener('click', () => window.location.reload());

    openBtn.addEventListener('click', async () => {
        if (inFlight) return;
        const key = safeGetKey();

        inFlight = true;
        openBtn.disabled = true;
        openLabel.textContent = 'Odpiranje...';
        setStatus('', null);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const res = await callEndpoint({ key: key || '' }, controller.signal);

            if (res.status === 401 || res.status === 403) {
                setStatus('Key rejected.', 'err');
                safeClearKey();
                showView('key');
                return;
            }
            if (res.status === 429) {
                setStatus('Too many attempts. Wait a few minutes.', 'err');
                return;
            }
            if (!res.ok) {
                setStatus('Request failed (' + res.status + ').', 'err');
                return;
            }

            setStatus('Unlocked.', 'ok');
        } catch (err) {
            if (err.name === 'AbortError') {
                setStatus('Timed out.', 'err');
            } else {
                setStatus('Network error.', 'err');
            }
        } finally {
            clearTimeout(timer);
            inFlight = false;
            openBtn.disabled = false;
            openLabel.textContent = 'Odpri';
        }
    });

    init();
})();
</script>
</body>
</html>
