//? Narek: microphone plumbing.
//?
//? Owns getUserMedia, the AudioContext and the worklet, and nothing else.
//? Every decision about what counts as speech lives in logic.js; this file
//? just hands it frames and forwards what it says back out.

import { createSegmenter, toWireWav } from './logic.js';

export class UnsupportedError extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'UnsupportedError';
    }
}

export function micSupport() {
    if (typeof window === 'undefined') return 'no-window';
    if (!window.isSecureContext) return 'insecure';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'no-getusermedia';
    if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return 'no-audiocontext';
    if (!('audioWorklet' in (window.AudioContext || window.webkitAudioContext).prototype)) return 'no-worklet';
    return 'ok';
}

//? One live microphone session. start() resolves once audio is actually
//? flowing, so the console can go red at the moment it is true and not before.
export function createMicSession({ onFrame, onSegment, onError }) {
    let ctx = null;
    let stream = null;
    let node = null;
    let source = null;
    let segmenter = null;
    let running = false;

    async function start() {
        const support = micSupport();
        if (support !== 'ok') throw new UnsupportedError(support);

        stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
        });

        const Ctor = window.AudioContext || window.webkitAudioContext;
        ctx = new Ctor();
        if (ctx.state === 'suspended') await ctx.resume();

        //? Resolved against this module, not the page: a page one directory
        //? deeper (views/narek/tolmac/) would otherwise ask for a worklet that
        //? is not there, and the only symptom is a mic that never starts.
        await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));

        segmenter = createSegmenter({ sampleRate: ctx.sampleRate });
        source = ctx.createMediaStreamSource(stream);
        node = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfOutputs: 0 });

        node.port.onmessage = (event) => {
            if (!running) return;
            let result;
            try {
                result = segmenter.push(event.data);
            } catch (err) {
                if (onError) onError(err);
                return;
            }
            if (onFrame) onFrame(result);
            if (result.type === 'segment' && onSegment) {
                onSegment({
                    wav: toWireWav(result.samples, ctx.sampleRate),
                    durationMs: result.durationMs,
                    reason: result.reason,
                });
            }
        };

        source.connect(node);
        running = true;
        return { sampleRate: ctx.sampleRate };
    }

    //? Stop, but ship whatever was mid-sentence first: cutting a visitor off
    //? at the last word is the fastest way to make a dictation tool feel broken.
    function stop() {
        if (!running) return;
        running = false;

        if (segmenter) {
            const tail = segmenter.flush();
            if (tail.type === 'segment' && onSegment) {
                onSegment({
                    wav: toWireWav(tail.samples, ctx.sampleRate),
                    durationMs: tail.durationMs,
                    reason: 'stop',
                });
            }
        }

        if (node) { node.port.onmessage = null; node.disconnect(); node = null; }
        if (source) { source.disconnect(); source = null; }
        if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
        if (ctx) { ctx.close().catch(() => {}); ctx = null; }
        segmenter = null;
    }

    return {
        start,
        stop,
        get running() { return running; },
        get noiseFloor() { return segmenter ? segmenter.noiseFloor : 0; },
        get gates() { return segmenter ? segmenter.gates : { open: 0, close: 0 }; },
    };
}
