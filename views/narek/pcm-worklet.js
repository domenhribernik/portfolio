//? Narek: the microphone tap.
//?
//? Runs on the audio thread. It does no analysis at all: it batches the
//? 128-sample render quanta into blocks of 1024 and posts them to the main
//? thread, where logic.js does the gating. Keeping the decision out here means
//? the whole voice-activity gate is testable in node.
//?
//? Not an ES module import: registered with audioWorklet.addModule().

const BLOCK = 1024;

class PcmTap extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = new Float32Array(BLOCK);
        this.at = 0;
    }

    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (!channel) return true;

        for (let i = 0; i < channel.length; i++) {
            this.buffer[this.at++] = channel[i];
            if (this.at === BLOCK) {
                //? Copy: the port transfers, and the next quantum overwrites this.
                this.port.postMessage(this.buffer.slice(0));
                this.at = 0;
            }
        }
        return true;
    }
}

registerProcessor('pcm-tap', PcmTap);
