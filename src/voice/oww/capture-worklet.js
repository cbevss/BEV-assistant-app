/**
 * AudioWorklet that turns the microphone into 16 kHz mono int16-scale chunks
 * for openWakeWord. Runs on the audio thread, so it keeps going even while
 * the BEV window is hidden in the tray.
 *
 * If the AudioContext already runs at 16 kHz (the normal case: Chromium
 * resamples the mic for us) samples pass straight through; otherwise it
 * low-passes and linearly resamples from the context rate.
 */
const TARGET = 16000;
const CHUNK = 1280;

class OwwCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET;
    this.pos = 0; // fractional read position into the input stream
    this.prev = 0; // last input sample, for interpolation across blocks
    this.lp = 0; // one-pole low-pass state (anti-aliasing when downsampling)
    this.alpha = this.ratio > 1 ? Math.min(1, (2 * Math.PI * 7000) / sampleRate) : 1;
    this.out = new Float32Array(CHUNK);
    this.n = 0;
  }

  emit(v) {
    // Float −1..1 → int16 scale, which is what the models were trained on.
    this.out[this.n++] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    if (this.n === CHUNK) {
      this.port.postMessage(this.out, [this.out.buffer]);
      this.out = new Float32Array(CHUNK);
      this.n = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (this.ratio === 1) {
      for (let i = 0; i < ch.length; i++) this.emit(ch[i]);
      return true;
    }
    for (let i = 0; i < ch.length; i++) {
      const filtered = this.lp + this.alpha * (ch[i] - this.lp);
      this.lp = filtered;
      // Emit every output sample whose position falls between prev and this one.
      while (this.pos <= 1) {
        this.emit(this.prev + (filtered - this.prev) * this.pos);
        this.pos += this.ratio;
      }
      this.pos -= 1;
      this.prev = filtered;
    }
    return true;
  }
}

registerProcessor("oww-capture", OwwCapture);
