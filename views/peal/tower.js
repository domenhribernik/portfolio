// The sounding half of the tower: a bell foundry in the Web Audio API.
//
// Nothing here is a sample. A bell's note is built out of the partials a tuner
// actually cuts on a lathe (views/peal/logic.js owns those figures), which is
// why the ring sounds minor even though it is tuned to a major scale: the
// tierce, the third partial, is a minor third above the prime and it is loud.
//
// This module owns the audio graph and the clock. It knows nothing about the
// page, and the page never touches an AudioContext directly.

import { bellHz, bellPartials, schedule, blowsForBell, matchStrike } from './logic.js';

export class Tower {
    constructor() {
        this.ctx = null;
        this.master = null;
        this.voices = new Set();
        this.stage = 6;
        this.tenorHz = 261.63;
        this.volume = 0.6;
    }

    // Browsers will not let a page make a noise until somebody has clicked, so
    // the context is built on the first pull of a rope rather than on load.
    async wake() {
        if (!this.ctx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return false;
            this.ctx = new Ctx();
            this.master = this.ctx.createGain();
            this.master.gain.value = this.volume;

            // A tower is a stone room, not a studio. A short convolution puts
            // the ring inside it instead of in front of the listener.
            const wet = this.ctx.createGain();
            wet.gain.value = 0.34;
            const reverb = this.ctx.createConvolver();
            reverb.buffer = belfryImpulse(this.ctx, 2.6);
            this.master.connect(this.ctx.destination);
            this.master.connect(wet);
            wet.connect(reverb);
            reverb.connect(this.ctx.destination);
        }
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        return true;
    }

    get now() {
        return this.ctx ? this.ctx.currentTime : 0;
    }

    setVolume(v) {
        this.volume = v;
        if (this.master) this.master.gain.setTargetAtTime(v, this.now, 0.02);
    }

    // Strike one bell. `when` is a context time; omit it for right now.
    strike(bell, stage = this.stage, when = null) {
        if (!this.ctx) return;
        const t = when === null ? this.now + 0.001 : when;
        const hz = bellHz(bell, stage, this.tenorHz);
        const partials = bellPartials(hz);

        // The clang. A real bell's attack is a burst of inharmonic partials that
        // dies in a few hundredths of a second, and without it a bell is an organ.
        const clang = this.ctx.createBufferSource();
        clang.buffer = noiseBuffer(this.ctx);
        const clangFilter = this.ctx.createBiquadFilter();
        clangFilter.type = 'bandpass';
        clangFilter.frequency.value = hz * 5.2;
        clangFilter.Q.value = 1.4;
        const clangGain = this.ctx.createGain();
        clangGain.gain.setValueAtTime(0.16, t);
        clangGain.gain.exponentialRampToValueAtTime(0.0005, t + 0.09);
        clang.connect(clangFilter).connect(clangGain).connect(this.master);
        clang.start(t);
        clang.stop(t + 0.12);
        this.track(clang, t + 0.2);

        for (const p of partials) {
            const osc = this.ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = p.hz;

            // A cast bell is never quite symmetrical, so each partial is really
            // two frequencies a fraction apart, and the beat between them is
            // what stops a synthesised bell sounding like a sine tone.
            const beat = this.ctx.createOscillator();
            beat.type = 'sine';
            beat.frequency.value = p.hz * 1.0016;

            const gain = this.ctx.createGain();
            const peak = p.gain * 0.14;
            gain.gain.setValueAtTime(0.0001, t);
            gain.gain.exponentialRampToValueAtTime(peak, t + 0.006);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + p.seconds);

            const beatGain = this.ctx.createGain();
            beatGain.gain.value = 0.45;

            osc.connect(gain);
            beat.connect(beatGain).connect(gain);
            gain.connect(this.master);
            osc.start(t); beat.start(t);
            osc.stop(t + p.seconds + 0.05); beat.stop(t + p.seconds + 0.05);
            this.track(osc, t + p.seconds + 0.1);
            this.track(beat, t + p.seconds + 0.1);
        }
    }

    // Cut everything off. Used when the ringing stops part way through, where
    // letting six tenors hang for eleven seconds is not what anyone wants.
    silence() {
        if (!this.ctx) return;
        const t = this.now;
        for (const node of this.voices) {
            try { node.stop(t + 0.06); } catch { /* already stopped */ }
        }
        this.voices.clear();
    }

    track(node, until) {
        this.voices.add(node);
        node.addEventListener?.('ended', () => this.voices.delete(node));
        setTimeout(() => this.voices.delete(node), Math.max(0, (until - this.now) * 1000) + 200);
    }
}

//? ---------------------------------------------------------------------------
//? The clock
//?
//? A ring is a list of blows with times on them. Ringing it means walking that
//? list, scheduling each blow slightly ahead of when it is due so the audio
//? clock is never late, and telling the page which row is up.
//? ---------------------------------------------------------------------------

const LOOKAHEAD_MS = 120;   // how often the scheduler wakes
const HORIZON_S = 0.35;     // how far ahead of the audio clock it books blows

export class Ringing {
    // `handlers` may carry onRow(rowIndex), onBlow(blow), onEnd(reason) and
    // onMiss(blowIndex), all optional.
    constructor(tower, handlers = {}) {
        this.tower = tower;
        this.on = handlers;
        this.timer = null;
        this.reset();
    }

    reset() {
        this.blows = [];
        this.owed = [];       // the blows the human is responsible for
        this.strikes = [];    // one entry per owed blow: ms of error, or null
        this.silentBell = 0;  // 0 when the tower rings everything itself
        this.cursor = 0;
        this.owedCursor = 0;
        this.startedAt = 0;
        this.lastRow = -1;
        this.running = false;
    }

    // Lay a course out on the clock. `silentBell` is the bell the machine will
    // not ring, because a person has hold of that rope.
    load(rows, stage, gapMs, silentBell = 0) {
        this.reset();
        this.stage = stage;
        this.gapMs = gapMs;
        this.rows = rows;
        this.blows = schedule(rows, stage, gapMs);
        this.silentBell = silentBell;
        this.owed = silentBell ? blowsForBell(this.blows, silentBell) : [];
        this.strikes = this.owed.map(() => null);
    }

    // Milliseconds since the first blow was due, on the audio clock.
    get elapsedMs() {
        return this.tower.ctx ? (this.tower.now - this.startedAt) * 1000 : 0;
    }

    // `auto` installs the wake-up timer that keeps the scheduler ahead of the
    // audio clock. Tests turn it off and drive tick() against a fake clock.
    start(leadInMs = 900, { auto = true } = {}) {
        if (!this.tower.ctx) return;
        this.startedAt = this.tower.now + leadInMs / 1000;
        this.cursor = 0;
        this.owedCursor = 0;
        this.lastRow = -1;
        this.running = true;
        this.tick();
        if (auto) this.timer = setInterval(() => this.tick(), LOOKAHEAD_MS);
    }

    stop(reason = 'stood') {
        if (!this.running) return;
        this.running = false;
        clearInterval(this.timer);
        this.timer = null;
        this.tower.silence();
        this.on.onEnd?.(reason);
    }

    // Overridable so a test can run the scheduler without real timers.
    defer(fn, ms) {
        setTimeout(fn, ms);
    }

    tick() {
        if (!this.running) return;
        const horizon = this.tower.now + HORIZON_S;

        while (this.cursor < this.blows.length) {
            const blow = this.blows[this.cursor];
            const at = this.startedAt + blow.at / 1000;
            if (at > horizon) break;
            if (blow.bell !== this.silentBell) this.tower.strike(blow.bell, this.stage, at);
            if (blow.row !== this.lastRow) {
                this.lastRow = blow.row;
                const rowAt = at;
                const delay = Math.max(0, (rowAt - this.tower.now) * 1000);
                this.defer(() => { if (this.running) this.on.onRow?.(blow.row); }, delay);
            }
            this.on.onBlow?.(blow);
            this.cursor += 1;
        }

        // A blow the ringer has already sailed past without pulling is a miss,
        // and it is worth saying so while it is still audible rather than in a
        // scorecard four minutes later.
        const now = this.elapsedMs;
        while (this.owedCursor < this.owed.length && this.owed[this.owedCursor].at < now - this.gapMs) {
            if (this.strikes[this.owedCursor] === null) this.on.onMiss?.(this.owedCursor);
            this.owedCursor += 1;
        }

        if (this.cursor >= this.blows.length) {
            const lastAt = this.startedAt + this.blows[this.blows.length - 1].at / 1000;
            if (this.tower.now > lastAt + 0.4) this.stop('come round');
        }
    }

    // The human pulled. Returns what happened, so the page can say it.
    pull() {
        if (!this.running || !this.silentBell) return null;
        const at = this.elapsedMs;
        const i = matchStrike(this.owed, at, this.gapMs);
        this.tower.strike(this.silentBell, this.stage);
        if (i < 0) return { matched: false, error: null, index: -1 };
        if (this.strikes[i] !== null) return { matched: false, error: null, index: i, doubled: true };
        const error = at - this.owed[i].at;
        this.strikes[i] = error;
        return { matched: true, error, index: i, blow: this.owed[i] };
    }

    // Which row is sounding right now, for a page that wants to scroll to it.
    get currentRow() {
        const t = this.elapsedMs;
        let row = 0;
        for (const blow of this.blows) {
            if (blow.at > t) break;
            row = blow.row;
        }
        return row;
    }
}

//? ---------------------------------------------------------------------------
//? Room and noise
//? ---------------------------------------------------------------------------

// A stone chamber, made rather than recorded: exponentially decaying noise,
// darkened as it decays because stone absorbs the top before the bottom.
function belfryImpulse(ctx, seconds) {
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const buffer = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
        const data = buffer.getChannelData(ch);
        let low = 0;
        for (let i = 0; i < length; i++) {
            const t = i / length;
            const decay = Math.pow(1 - t, 2.4);
            const white = Math.random() * 2 - 1;
            low = low * 0.72 + white * 0.28;      // a one pole low pass
            data[i] = (white * 0.35 + low * 0.65) * decay * (ch === 0 ? 1 : 0.94);
        }
    }
    return buffer;
}

let noise = null;
function noiseBuffer(ctx) {
    if (noise) return noise;
    const length = Math.floor(ctx.sampleRate * 0.2);
    noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return noise;
}
