// Page wiring for the classical massage reference + guided session.
// All decision/timing logic lives in ./logic.js (tested by tests/masaza-logic.test.mjs);
// this file only renders and owns the clock, audio, and wake lock.
import {
    ROUTINE, TEHNIKE, VRSTNI_RED, NE_MASIRAMO, PRIPRAVA,
    buildSchedule, flipIndex, segmentAt,
    startSession, pauseSession, resumeSession, elapsedSeconds, skipToNext,
    formatTime,
} from './logic.js';

const schedule = buildSchedule();
const FLIP = flipIndex(schedule);
const TOTAL = schedule[schedule.length - 1].end;
const $ = id => document.getElementById(id);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const ROTATE_ICON = `
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" class="inline-block -mt-px mr-1.5">
        <path d="M8 2.2a5.8 5.8 0 1 1-4.6 2.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        <path d="M3.4 1.2v3.4h3.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

// ---------- Reference rendering ----------

function chipHtml(techId) {
    const teh = TEHNIKE.find(t => t.id === techId);
    return `<a href="#teh-${techId}" class="font-mono text-[0.6rem] tracking-[0.12em] uppercase text-stone border border-hairline rounded-[2px] px-1.5 py-0.5 no-underline hover:text-pine hover:border-pine/60 transition-colors">${teh.name}</a>`;
}

function captionHtml(text) {
    return `<li class="caption bg-paper2/70 border-b border-hairline px-4 sm:px-6 py-2 font-mono text-[0.62rem] tracking-[0.22em] uppercase text-stone">${text}</li>`;
}

function rowHtml(segment, index) {
    const minutes = segment.minutes;
    return `
    <li class="row" data-index="${index}">
        <div class="row-inner flex items-start gap-3 sm:gap-4 px-4 sm:px-6 py-3.5 border-b border-hairline">
            <span class="badge shrink-0 font-mono font-bold text-[0.78rem] tabular-nums border border-ink/40 rounded-[2px] px-1.5 py-0.5 mt-0.5 transition-colors">${minutes}&prime;</span>
            <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
                    <h3 class="font-display font-semibold text-lg sm:text-xl leading-tight">${segment.title}</h3>
                    <span class="flex flex-wrap gap-1.5">${segment.techniques.map(chipHtml).join('')}</span>
                </div>
                <p class="mt-1 text-[0.86rem] leading-snug text-ink/75">${segment.cues.join('<span class="text-stone/70"> &middot; </span>')}</p>
                <div class="segprog mt-2 h-[3px] bg-paper2 rounded-full overflow-hidden"><div class="segprog-fill h-full bg-pine" style="width:0%"></div></div>
            </div>
            <span class="row-state shrink-0 font-mono text-[0.62rem] tracking-[0.18em] uppercase text-stone mt-1"></span>
        </div>
    </li>`;
}

function renderTimeline() {
    const parts = [captionHtml('Prvi del &middot; stranka na hrbtu &middot; 30 min')];
    schedule.forEach((segment, index) => {
        if (index === FLIP) {
            parts.push(`
            <li id="flipRow">
                <div class="flip-band flex items-center justify-center gap-1 px-4 py-2.5 text-center font-mono font-bold text-[0.68rem] tracking-[0.25em] uppercase text-terra bg-terra/5 border-b border-dashed border-terra/50">
                    ${ROTATE_ICON}<span class="flip-text">Stranka se obrne na trebuh</span>
                </div>
            </li>`);
            parts.push(captionHtml('Drugi del &middot; na trebuhu &middot; 30 min'));
        }
        parts.push(rowHtml(segment, index));
    });
    $('timeline').innerHTML = parts.join('');
}

function renderTehnike() {
    $('tehnikeGrid').innerHTML = TEHNIKE.map((teh, i) => {
        const lead = i === 0;
        return `
        <article id="teh-${teh.id}" class="bg-card border border-hairline rounded-[3px] shadow-[0_10px_30px_rgba(28,26,23,0.06)] p-5 scroll-mt-24${lead ? ' sm:col-span-2' : ''}">
            <div class="flex items-baseline gap-2 border-b border-hairline pb-2.5 mb-3">
                <h3 class="font-display font-semibold text-xl leading-tight">${teh.name}</h3>
                <span class="font-display italic text-stone">&middot; ${teh.alias}</span>
                ${lead ? '<span class="ml-auto font-mono text-[0.6rem] tracking-[0.18em] uppercase text-pine whitespace-nowrap">začetek in konec</span>' : ''}
            </div>
            <p class="text-[0.92rem] text-ink/85">${teh.summary}</p>
            <ul class="mt-3 space-y-1.5${lead ? ' sm:columns-2 sm:gap-8' : ''}">
                ${teh.cues.map(cue => `
                <li class="flex items-start gap-2.5 break-inside-avoid">
                    <span class="mt-[0.5em] w-[6px] h-[6px] bg-pine/70 shrink-0"></span>
                    <span class="text-[0.86rem] leading-snug text-ink/80">${cue}</span>
                </li>`).join('')}
            </ul>
        </article>`;
    }).join('');
}

function renderVrstniRed() {
    $('vrstniRed').innerHTML = VRSTNI_RED.map((step, i) => `
    <li class="flex gap-4 py-3.5 border-b border-dotted border-ink/20 last:border-0">
        <span class="font-mono font-bold text-pine tabular-nums text-sm mt-0.5 w-4 shrink-0 text-right">${i + 1}</span>
        <div class="min-w-0">
            <h3 class="font-medium text-[0.98rem] leading-snug">${step.title}</h3>
            <p class="text-[0.86rem] leading-snug text-ink/70 mt-0.5">${step.note}</p>
        </div>
    </li>`).join('');
}

function renderLists() {
    $('neMasiramoList').innerHTML = NE_MASIRAMO.zones.map(zone => `
    <li class="flex items-start gap-2.5">
        <span class="font-mono font-bold text-terra text-[0.8rem] leading-[1.4] shrink-0">&times;</span>
        <span class="text-[0.9rem] leading-snug text-ink/85">${zone}</span>
    </li>`).join('');

    $('pripravaList').innerHTML = PRIPRAVA.map(item => `
    <li class="flex items-start gap-2.5">
        <span class="mt-[0.45em] w-[6px] h-[6px] border border-stone/70 shrink-0"></span>
        <span class="text-[0.9rem] leading-snug text-ink/85">${item}</span>
    </li>`).join('');
}

renderTimeline();
renderTehnike();
renderVrstniRed();
renderLists();

const rowEls = [...document.querySelectorAll('#timeline .row')];
const flipRow = $('flipRow');

// ---------- Audio (created on the Start gesture, soft sine chimes) ----------

let audioCtx = null;

function ensureAudio() {
    if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) audioCtx = new Ctx();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

function tone(freq, delay, duration = 0.4, peak = 0.07) {
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime + delay;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
}

const chimeSegment = () => { tone(660, 0); tone(880, 0.2); };
const chimeFlip = () => { tone(523.25, 0); tone(659.25, 0.22); tone(783.99, 0.44, 0.6); };
const chimeEnd = () => { tone(880, 0); tone(660, 0.25); tone(440, 0.5, 0.9); };

// ---------- Wake lock (screens must survive oily hands) ----------

let wakeLock = null;

async function requestWakeLock() {
    try {
        wakeLock = await navigator.wakeLock?.request('screen');
    } catch (err) { /* unsupported or denied: the timer still works */ }
}

function releaseWakeLock() {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && session && !finished) requestWakeLock();
});

// ---------- Guided session ----------

let session = null;
let tickId = null;
let lastIndex = -1;
let finished = false;
let stopArmedUntil = 0;

const startBtn = $('startBtn');
const pauseBtn = $('pauseBtn');
const skipBtn = $('skipBtn');
const stopBtn = $('stopBtn');
const baseTitle = document.title;

function setRowStates(activeIndex) {
    rowEls.forEach((el, i) => {
        el.classList.toggle('done', i < activeIndex);
        el.classList.toggle('active', i === activeIndex);
        el.classList.toggle('next', i === activeIndex + 1);
        const state = el.querySelector('.row-state');
        state.innerHTML = i < activeIndex ? '&#10003;' : (i === activeIndex + 1 ? 'sledi' : '');
    });
}

function clearRowStates() {
    rowEls.forEach(el => {
        el.classList.remove('done', 'active', 'next');
        el.querySelector('.row-state').textContent = '';
    });
    flipRow.classList.remove('flip-now');
}

function tick() {
    const now = Date.now();
    const elapsed = elapsedSeconds(session, now);
    const at = segmentAt(schedule, elapsed);

    $('tbTotal').textContent = `${formatTime(elapsed)} / ${formatTime(TOTAL)}`;
    $('tbProgress').style.width = `${Math.min(100, (elapsed / TOTAL) * 100)}%`;

    if (at.done) { finish(); return; }

    if (at.index !== lastIndex) {
        if (lastIndex !== -1) (at.index === FLIP ? chimeFlip : chimeSegment)();
        setRowStates(at.index);
        rowEls[at.index].scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
        lastIndex = at.index;
    }

    const flipNow = at.index === FLIP && at.segmentElapsed < 15;
    flipRow.classList.toggle('flip-now', flipNow);
    $('tbPhase').textContent = flipNow ? 'Obrni stranko na trebuh' : 'Vodena seja';
    $('tbPhase').classList.toggle('text-terra', flipNow);
    $('tbPhase').classList.toggle('text-stone', !flipNow);

    $('tbSegment').textContent = at.segment.title;
    $('tbCountdown').textContent = formatTime(at.segmentRemaining);
    const next = schedule[at.index + 1];
    $('tbNext').textContent = next ? `Sledi: ${next.title.toLowerCase()} (${next.minutes} min)` : 'Zadnja postaja';

    const fill = rowEls[at.index].querySelector('.segprog-fill');
    fill.style.width = `${(at.segmentElapsed / at.segment.duration) * 100}%`;

    document.title = `${formatTime(at.segmentRemaining)} · ${at.segment.title}`;
}

function start() {
    ensureAudio();
    requestWakeLock();
    session = startSession(Date.now());
    finished = false;
    lastIndex = -1;
    document.body.classList.add('guided');
    document.body.classList.remove('paused', 'finished');
    pauseBtn.textContent = 'Pavza';
    stopBtn.textContent = 'Končaj';
    tick();
    tickId = setInterval(tick, 250);
}

function togglePause() {
    if (!session || finished) return;
    const now = Date.now();
    if (session.paused) {
        session = resumeSession(session, now);
        pauseBtn.textContent = 'Pavza';
        document.body.classList.remove('paused');
    } else {
        session = pauseSession(session, now);
        pauseBtn.textContent = 'Nadaljuj';
        document.body.classList.add('paused');
    }
}

function skip() {
    if (!session || finished) return;
    ensureAudio();
    session = skipToNext(session, schedule, Date.now());
    tick();
}

function finish() {
    if (finished) return;
    finished = true;
    clearInterval(tickId);
    chimeEnd();
    releaseWakeLock();
    setRowStates(rowEls.length);
    flipRow.classList.remove('flip-now');
    document.body.classList.add('finished');
    document.body.classList.remove('paused');
    $('tbPhase').textContent = 'Seja končana';
    $('tbPhase').classList.remove('text-terra');
    $('tbSegment').textContent = 'Konec masaže';
    $('tbCountdown').textContent = '0:00';
    $('tbNext').textContent = 'Stranka naj še trenutek počiva';
    $('tbTotal').textContent = `${formatTime(TOTAL)} / ${formatTime(TOTAL)}`;
    $('tbProgress').style.width = '100%';
    stopBtn.textContent = 'Ponastavi';
    document.title = baseTitle;
}

function reset() {
    clearInterval(tickId);
    session = null;
    finished = false;
    lastIndex = -1;
    releaseWakeLock();
    clearRowStates();
    document.body.classList.remove('guided', 'paused', 'finished');
    stopBtn.textContent = 'Končaj';
    pauseBtn.textContent = 'Pavza';
    document.title = baseTitle;
}

function stopPressed() {
    if (finished) { reset(); return; }
    const now = Date.now();
    // First tap arms the button for 4 s so a stray touch cannot end the hour.
    if (now < stopArmedUntil) { reset(); return; }
    stopArmedUntil = now + 4000;
    stopBtn.textContent = 'Res končam?';
    setTimeout(() => {
        if (Date.now() >= stopArmedUntil && !finished && session) stopBtn.textContent = 'Končaj';
    }, 4100);
}

startBtn.addEventListener('click', start);
pauseBtn.addEventListener('click', togglePause);
skipBtn.addEventListener('click', skip);
stopBtn.addEventListener('click', stopPressed);
