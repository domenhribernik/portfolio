//? Narek: the instrument deck, shared by both pages.
//?
//? Everything above the sheet is the same whichever way you use the tool: the
//? access gate, the transport key, the chart trace, the clock, the banner and
//? the toast. That is this module. A page supplies what to DO with a finished
//? segment and owns its own sheet below.
//?
//? Both pages ship the same deck markup (the ids below), so the module queries
//? for them itself rather than making every page hand them over.

import { createMicSession, micSupport } from './audio.js';
import { formatClock } from './logic.js';
import { gatedFetch, loginUrl } from '../../components/auth-gate.js';

const el = (id) => document.getElementById(id);

const GATE_COPY = {
    signin: {
        title: 'Prijavi se.',
        text: 'To je osebno orodje. Vsaka zahteva porabi Gemini kvoto lastnika, zato je za prijavljenega lastnika.',
        link: true,
    },
    forbidden: {
        title: 'Nimaš dostopa.',
        text: 'Prijavljen si, a ta račun nima dostopa. Orodje je omejeno na lastnika strani.',
        link: false,
    },
    error: {
        title: 'Strežnik ne odgovarja.',
        text: 'Dostopa ni bilo mogoče preveriti. Osveži stran in poskusi znova.',
        link: false,
    },
};

const SUPPORT_COPY = {
    insecure: ['Brez varne povezave', 'Brskalnik dovoli mikrofon samo prek https ali na localhost. Odpri stran na https naslovu.'],
    'no-getusermedia': ['Ni dostopa do mikrofona', 'Ta brskalnik ne podpira zajema zvoka. Poskusi s Chromom, Firefoxom ali Safarijem.'],
    'no-audiocontext': ['Ni zvočnega konteksta', 'Ta brskalnik ne podpira Web Audio. Poskusi z novejšo različico.'],
    'no-worklet': ['Prestar brskalnik', 'Zajem potrebuje AudioWorklet. Posodobi brskalnik in poskusi znova.'],
};

const TRACE_SLOTS = 220;

/**
 * @param {object} options
 * @param {string} options.api           path to app/proxys/narek.php from this page
 * @param {string} options.accountPath   path to views/account/ from this page
 * @param {(cut: {wav: Uint8Array, durationMs: number, offsetMs: number}) => void} options.onSegment
 * @param {(status: object) => void} options.onReady    access granted, mic usable
 * @param {() => void} options.onGated                  the wall went up
 * @param {() => void} options.onStateChange            recording or in-flight changed
 */
export function createDeck({ api, accountPath, onSegment, onReady, onGated, onStateChange }) {
    const ui = {
        key: el('recordKey'),
        keyLabel: el('recordKeyLabel'),
        trace: el('trace'),
        traceHint: el('traceHint'),
        stateLine: el('stateLine'),
        stateClock: el('stateClock'),
        deck: document.querySelector('.console'),
        banner: el('banner'),
        bannerTitle: el('bannerTitle'),
        bannerText: el('bannerText'),
        bannerAction: el('bannerAction'),
        gate: el('gate'),
        gateTitle: el('gateTitle'),
        gateText: el('gateText'),
        gateLink: el('gateLink'),
        tool: el('tool'),
        counters: el('counters'),
        countClock: el('countClock'),
        modelLine: el('modelLine'),
        toast: el('toast'),
    };

    let mic = null;
    let recording = false;
    let speaking = false;
    let inFlight = 0;
    let elapsedMs = 0;
    let sessionStart = 0;
    let clockTimer = 0;
    let stateTimer = 0;
    let toastTimer = 0;

    // ------------------------------------------------------------------
    //  Chart trace
    // ------------------------------------------------------------------

    const trace = {
        levels: new Float32Array(TRACE_SLOTS),
        marks: new Uint8Array(TRACE_SLOTS),
        hot: new Uint8Array(TRACE_SLOTS),
        gate: 0,
        dirty: false,
    };
    const ctx2d = ui.trace.getContext('2d');

    function sizeTrace() {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const rect = ui.trace.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        ui.trace.width = Math.round(rect.width * dpr);
        ui.trace.height = Math.round(rect.height * dpr);
        ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawTrace();
    }

    function pushLevel(level, hot, gate) {
        trace.levels.copyWithin(0, 1);
        trace.marks.copyWithin(0, 1);
        trace.hot.copyWithin(0, 1);
        trace.levels[TRACE_SLOTS - 1] = level;
        trace.marks[TRACE_SLOTS - 1] = 0;
        trace.hot[TRACE_SLOTS - 1] = hot ? 1 : 0;
        trace.gate = gate;
        trace.dirty = true;
    }

    function markCut() {
        trace.marks[TRACE_SLOTS - 1] = 1;
        trace.dirty = true;
    }

    //? Perceptual, not linear: speech RMS lives in the bottom fifth of the
    //? range, and a linear meter shows a flat line for a normal speaking voice.
    const scale = (level) => Math.min(1, Math.sqrt(Math.max(0, level) / 0.32));

    function drawTrace() {
        const w = ui.trace.clientWidth;
        const h = ui.trace.clientHeight;
        if (!w || !h) return;

        ctx2d.clearRect(0, 0, w, h);
        const slotW = w / TRACE_SLOTS;
        const barW = Math.max(1, slotW - 0.6);

        //? The gate: where the trace has to reach before it counts as speech.
        if (trace.gate > 0) {
            const y = h - scale(trace.gate) * (h - 6) - 3;
            ctx2d.strokeStyle = 'rgba(212, 69, 31, 0.35)';
            ctx2d.lineWidth = 1;
            ctx2d.setLineDash([3, 4]);
            ctx2d.beginPath();
            ctx2d.moveTo(0, Math.round(y) + 0.5);
            ctx2d.lineTo(w, Math.round(y) + 0.5);
            ctx2d.stroke();
            ctx2d.setLineDash([]);
        }

        for (let i = 0; i < TRACE_SLOTS; i++) {
            const x = i * slotW;
            if (trace.marks[i]) {
                ctx2d.fillStyle = 'rgba(212, 69, 31, 0.75)';
                ctx2d.fillRect(Math.round(x), 0, 1, h);
                continue;
            }
            const level = trace.levels[i];
            if (level <= 0) continue;
            const barH = Math.max(1, scale(level) * (h - 6));
            ctx2d.fillStyle = trace.hot[i] ? 'rgba(212, 69, 31, 0.85)' : 'rgba(28, 26, 23, 0.34)';
            ctx2d.fillRect(x, h - barH - 3, barW, barH);
        }
    }

    function traceLoop() {
        if (trace.dirty) {
            trace.dirty = false;
            drawTrace();
        }
        if (recording) requestAnimationFrame(traceLoop);
    }

    function resetTrace() {
        trace.levels.fill(0);
        trace.marks.fill(0);
        trace.hot.fill(0);
        trace.gate = 0;
        drawTrace();
    }

    // ------------------------------------------------------------------
    //  Banner, toast, state line
    // ------------------------------------------------------------------

    function setState(text) {
        clearTimeout(stateTimer);
        ui.stateLine.textContent = text;
    }

    function stateLabel() {
        if (!recording) return inFlight > 0 ? `Obdelujem (${inFlight})` : 'Pripravljen';
        if (inFlight > 0) return `Poslušam · obdelujem (${inFlight})`;
        return speaking ? 'Govor' : 'Poslušam';
    }

    function flashState(text) {
        clearTimeout(stateTimer);
        ui.stateLine.textContent = text;
        stateTimer = setTimeout(() => { ui.stateLine.textContent = stateLabel(); }, 1800);
    }

    function banner(title, text, action) {
        ui.bannerTitle.textContent = title;
        ui.bannerText.textContent = text;
        ui.banner.classList.remove('hidden');
        if (action) {
            ui.bannerAction.textContent = action.label;
            ui.bannerAction.classList.remove('hidden');
            ui.bannerAction.onclick = action.run;
        } else {
            ui.bannerAction.classList.add('hidden');
            ui.bannerAction.onclick = null;
        }
    }

    function clearBanner() {
        ui.banner.classList.add('hidden');
        ui.bannerAction.onclick = null;
    }

    function toast(message) {
        ui.toast.textContent = message;
        ui.toast.classList.add('is-shown');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => ui.toast.classList.remove('is-shown'), 2400);
    }

    // ------------------------------------------------------------------
    //  Clock
    // ------------------------------------------------------------------

    function paintClock(ms) {
        ui.stateClock.textContent = formatClock(ms);
        if (ui.countClock) ui.countClock.textContent = formatClock(ms);
    }

    function startClock() {
        sessionStart = Date.now();
        clockTimer = setInterval(() => paintClock(elapsedMs + (Date.now() - sessionStart)), 250);
    }

    function stopClock() {
        clearInterval(clockTimer);
        elapsedMs += Date.now() - sessionStart;
        paintClock(elapsedMs);
    }

    function offsetNow() {
        return recording ? elapsedMs + (Date.now() - sessionStart) : elapsedMs;
    }

    function announce() {
        setState(stateLabel());
        if (onStateChange) onStateChange();
    }

    // ------------------------------------------------------------------
    //  Recording
    // ------------------------------------------------------------------

    async function startRecording() {
        clearBanner();

        const support = micSupport();
        if (support !== 'ok') {
            const [title, text] = SUPPORT_COPY[support] || ['Zajem ni mogoč', 'Brskalnik ne dovoli zajema zvoka.'];
            banner(title, text);
            return;
        }

        mic = createMicSession({
            onFrame: (event) => {
                speaking = event.type === 'speech' || event.type === 'open';
                pushLevel(event.level || 0, speaking, mic ? mic.gates.open : 0);
                if (event.type === 'open') setState(stateLabel());
            },
            onSegment: ({ wav, durationMs }) => {
                markCut();
                onSegment({ wav, durationMs, offsetMs: Math.max(0, offsetNow() - durationMs) });
            },
            onError: () => {
                banner('Zajem se je ustavil', 'Med zajemom je prišlo do napake. Poskusi znova.');
                stopRecording();
            },
        });

        ui.key.disabled = true;
        try {
            await mic.start();
        } catch (error) {
            ui.key.disabled = false;
            mic = null;
            if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
                banner('Mikrofon je zavrnjen', 'Dovoli dostop do mikrofona v naslovni vrstici brskalnika in poskusi znova.');
            } else if (error && error.name === 'NotFoundError') {
                banner('Ni mikrofona', 'Brskalnik ni našel nobene vhodne zvočne naprave.');
            } else {
                banner('Zajem ni uspel', 'Mikrofona ni bilo mogoče odpreti. Poskusi znova.');
            }
            return;
        }

        ui.key.disabled = false;
        recording = true;
        ui.key.classList.add('is-live');
        ui.key.setAttribute('aria-pressed', 'true');
        ui.keyLabel.textContent = 'Ustavi snemanje';
        ui.traceHint.classList.add('hidden');
        startClock();
        announce();
        requestAnimationFrame(traceLoop);
    }

    function stopRecording() {
        if (!recording) return;
        recording = false;
        //? Settle the clock first: mic.stop() flushes the final segment
        //? synchronously, and offsetNow() reads elapsedMs to stamp it.
        stopClock();
        if (mic) mic.stop();
        mic = null;
        speaking = false;

        ui.key.classList.remove('is-live');
        ui.key.setAttribute('aria-pressed', 'false');
        ui.keyLabel.textContent = 'Začni snemati';
        ui.traceHint.classList.remove('hidden');
        ui.traceHint.textContent = 'mirovanje';
        resetTrace();
        announce();
    }

    // ------------------------------------------------------------------
    //  The access gate
    // ------------------------------------------------------------------

    function showGate(kind, detail) {
        const copy = GATE_COPY[kind] || GATE_COPY.error;
        ui.gateTitle.textContent = copy.title;
        ui.gateText.textContent = detail ? `${copy.text} (${detail})` : copy.text;
        ui.gateLink.href = loginUrl(location.pathname, accountPath);
        ui.gateLink.classList.toggle('hidden', !copy.link);

        ui.gate.classList.remove('hidden');
        ui.tool.classList.add('hidden');
        ui.counters.classList.add('hidden');
        stopRecording();
        if (onGated) onGated();
    }

    function showTool(data) {
        ui.gate.classList.add('hidden');
        ui.tool.classList.remove('hidden');
        ui.counters.classList.remove('hidden');

        //? The browser check only matters once we know the tool is on offer.
        const support = micSupport();
        if (support !== 'ok') {
            const [title, text] = SUPPORT_COPY[support] || ['Zajem ni mogoč', 'Brskalnik ne dovoli zajema zvoka.'];
            banner(title, text);
            ui.key.disabled = true;
            ui.traceHint.textContent = 'ni zajema';
        } else if (data && data.ready === false) {
            //? Signed in as the owner, but the server has no key to spend.
            banner('Ni ključa za Gemini',
                'Strežnik nima nastavljenega GEMINI_API_KEY, zato prepis ne bo delal. Dodaj ga v app/.env.');
            ui.key.disabled = true;
            ui.traceHint.textContent = 'ni ključa';
        }

        sizeTrace();
        setState('Pripravljen');
        if (onReady) onReady(data || {});
    }

    // ------------------------------------------------------------------
    //  Wiring
    // ------------------------------------------------------------------

    ui.key.addEventListener('click', () => {
        if (recording) stopRecording();
        else startRecording();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && recording) stopRecording();
    });

    //? A live microphone survives a reload otherwise, and the tab keeps its red dot.
    window.addEventListener('pagehide', stopRecording);

    let stuckFrame = 0;
    window.addEventListener('scroll', () => {
        if (stuckFrame) return;
        stuckFrame = requestAnimationFrame(() => {
            stuckFrame = 0;
            ui.deck.classList.toggle('is-stuck', ui.deck.getBoundingClientRect().top <= 0.5);
        });
    }, { passive: true });

    if (window.ResizeObserver) new ResizeObserver(sizeTrace).observe(ui.trace);
    else window.addEventListener('resize', sizeTrace);

    return {
        //? Asks the server who it is talking to before offering a microphone.
        //? Doing this on load rather than on the first press means nobody
        //? speaks a paragraph into a 403.
        async start() {
            await gatedFetch(`${api}?action=status`, { method: 'GET' }, {
                onSignedOut: () => showGate('signin'),
                onForbidden: () => showGate('forbidden'),
                onOk: (data) => showTool(data),
                onError: (message) => showGate('error', message),
            });
        },

        //? A session can expire mid-dictation; every gated call routes its
        //? 401/403 back through the same wall rather than surfacing as a
        //? request error. Returns true when it handled the status.
        gated(status) {
            if (status === 401) { showGate('signin'); return true; }
            if (status === 403) { showGate('forbidden'); return true; }
            return false;
        },

        enter() { inFlight++; announce(); },
        leave() { inFlight--; announce(); },

        stop: stopRecording,
        banner,
        clearBanner,
        toast,
        setState,
        flashState,
        offsetNow,
        sizeTrace,

        get recording() { return recording; },
        get inFlight() { return inFlight; },
        get elapsedMs() { return elapsedMs; },

        resetClock() {
            elapsedMs = 0;
            paintClock(0);
        },

        setModel(name) {
            if (name && ui.modelLine) ui.modelLine.textContent = name;
        },

        disableKey(hint) {
            ui.key.disabled = true;
            if (hint) ui.traceHint.textContent = hint;
        },
    };
}
