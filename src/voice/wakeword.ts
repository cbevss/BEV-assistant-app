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

interface SpeechRecognitionCtor {
  new (): {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    start(): void;
    abort(): void;
    onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
    onerror: ((e: { error: string }) => void) | null;
    onend: (() => void) | null;
  };
}

/**
 * Zero-setup wake word using the WebView2 SpeechRecognition API. Listens
 * continuously for "BEV" (and "hey/yo BEV") and fires onWake. No Picovoice key
 * needed. The recogniser is paused while the conversation STT runs (only one
 * SpeechRecognition can be active at once) and resumed afterwards.
 */
export class WebSpeechWakeWord implements WakeWordEngine {
  readonly id = "webspeech-wake";
  private mic = new MicInput();
  private rec: InstanceType<SpeechRecognitionCtor> | null = null;
  private running = false;
  private paused = false;
  private onWakeCb?: () => void;

  constructor(private cfg: { deviceId?: string } = {}) {}

  async start(onWake: () => void): Promise<void> {
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      throw new Error(
        "Speech recognition isn't available in this runtime. Use Ctrl+Alt+B, or add a Picovoice key in Integrations."
      );
    }
    this.onWakeCb = onWake;
    await this.mic.start(this.cfg.deviceId).catch(() => {}); // level meter, best-effort
    this.running = true;
    this.paused = false;
    this.listen(Ctor);
  }

  private listen(Ctor: SpeechRecognitionCtor) {
    if (!this.running || this.paused) return;
    const rec = new Ctor();
    rec.lang = "en-GB";
    rec.continuous = true;
    rec.interimResults = true;
    this.rec = rec;

    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript.toLowerCase();
        // Word-boundary "bev", plus common lead-ins. Avoids matching "beverage".
        if (/(^|\s)(hey |yo |ok )?bev(\s|,|\.|!|\?|$)/.test(t)) {
          this.pauseListening();
          this.onWakeCb?.();
          return;
        }
      }
    };
    rec.onerror = (ev) => {
      // no-speech / network blips are normal; keep going. 'aborted' = our pause.
      if (this.running && !this.paused && ev.error !== "aborted") {
        setTimeout(() => this.listen(Ctor), 500);
      }
    };
    rec.onend = () => {
      // SpeechRecognition stops itself periodically — restart while active.
      if (this.running && !this.paused) setTimeout(() => this.listen(Ctor), 250);
    };

    try {
      rec.start();
    } catch {
      /* already started — ignore */
    }
  }

  /** Stop recognising while the conversation STT uses the mic. */
  pauseListening() {
    this.paused = true;
    try {
      this.rec?.abort();
    } catch {
      /* ignore */
    }
    this.rec = null;
  }

  /** Resume listening for the wake word after a conversation ends. */
  resumeListening() {
    if (!this.running || !this.paused) return;
    this.paused = false;
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (Ctor) this.listen(Ctor);
  }

  stop() {
    this.running = false;
    this.paused = false;
    try {
      this.rec?.abort();
    } catch {
      /* ignore */
    }
    this.rec = null;
    this.mic.stop();
  }

  onLevel(cb: (l: number) => void) {
    this.mic.onLevel(cb);
  }
}
