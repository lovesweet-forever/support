// AudioWorkletProcessor: float32 -> 16-bit PCM, posted in ~100ms chunks.
//
// No resampling happens here. The offscreen document creates this worklet's
// AudioContext with `{ sampleRate: 16000 }`, so Chrome resamples the incoming
// MediaStream for us with a much better filter than we would write by hand.

const CHUNK_SAMPLES = 1600; // 100ms at 16kHz

class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(CHUNK_SAMPLES);
    this._offset = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // No input yet (or the track ended) — keep the processor alive.
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      // Clamp before scaling; values outside [-1, 1] wrap and sound like clicks.
      const sample = Math.max(-1, Math.min(1, channel[i]));
      this._buffer[this._offset++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;

      if (this._offset === CHUNK_SAMPLES) {
        // Copy: the underlying buffer is reused immediately after transfer.
        this.port.postMessage(this._buffer.slice());
        this._offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-downsampler', PcmDownsampler);
