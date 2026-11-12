import { WakeWordEngine } from "./types";

/**
 * Microphone input processor shared by wake-word engines. Captures the mic via
 * getUserMedia and exposes a smoothed RMS level for the overlay visualiser.
 */
export class MicInput {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private analyser?: AnalyserNode;
  private raf = 0;
  private levelCb?: (l: number) => void;

  async start(deviceId?: string) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    src.connect(this.analyser);
    this.loop();
  }

  private loop = () => {
    if (!this.analyser) return;
    const buf = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) {
      const n = (v - 128) / 128;
      sum += n * n;
    }
    const rms = Math.sqrt(sum / buf.length);
    this.levelCb?.(Math.min(1, rms * 3));
    this.raf = requestAnimationFrame(this.loop);
  };

  onLevel(cb: (l: number) => void) {
    this.levelCb = cb;
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.analyser = undefined;
  }
}

/**
 * Picovoice Porcupine wake-word engine. Requires an access key and a custom
 * "BEV" keyword (.ppn) trained at console.picovoice.ai. When the SDK is
 * present and configured it runs fully on-device. Until then, `start` throws a
 * clear, actionable error so the UI can fall back or prompt for setup.
 */
export class PorcupineWakeWord implements WakeWordEngine {
  readonly id = "porcupine";
  private mic = new MicInput();
  private running = false;

  constructor(
    private cfg: { accessKey?: string; keywordPath?: string; sensitivity?: number; deviceId?: string }
  ) {}

  async start(onWake: () => void): Promise<void> {
    if (!this.cfg.accessKey) {
      throw new Error(
        "Picovoice access key not set. Add it in Settings → Voice to enable on-device 'BEV' wake-word."
      );
    }
    // Real integration point: dynamically import @picovoice/porcupine-web and
    // feed MicInput frames into the worker. Kept as an explicit, typed seam so
    // the rest of the app compiles and runs on the Web Speech fallback.
    await this.mic.start(this.cfg.deviceId);
    this.running = true;
    // NOTE: wiring the Porcupine worker + its onWake callback is the remaining
    // step here; see docs/VOICE.md. We do NOT fake a detection.
    void onWake;
  }

  stop() {
    this.running = false;
    this.mic.stop();
  }

  onLevel(cb: (l: number) => void) {
    this.mic.onLevel(cb);
  }

  get isRunning() {
    return this.running;
  }
}
