import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import melUrl from "./models/melspectrogram.onnx?url";
import embUrl from "./models/embedding_model.onnx?url";
// Kept as a real file by vite.config (a data: URL would be blocked by the CSP).
import workletUrl from "./capture-worklet.js?url";
import type { WakeWordEngine } from "../types";
import { OwwPipeline, WakeDetector, SAMPLE_RATE } from "./pipeline";
import { createOrtRunner } from "./runner";

// Load the runtime from BEV's own files: never from a CDN, and single-threaded
// so it doesn't need cross-origin isolation in the webview.
ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

/** Load and check a wake-word model; throws a readable error if it's unusable. */
export async function openRunner(model: Uint8Array) {
  return createOrtRunner(ort, { melspectrogram: melUrl, embedding: embUrl, wakeword: model });
}

/**
 * On-device wake word (openWakeWord). Audio never leaves the PC: the mic is
 * read by an AudioWorklet, features and the user's trained "hey BEV" model
 * run in WebAssembly, and only a detection is reported.
 */
export class OnDeviceWakeWord implements WakeWordEngine {
  readonly id = "openwakeword";
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private runner?: Awaited<ReturnType<typeof openRunner>>;
  private pipeline?: OwwPipeline;
  private detector: WakeDetector;
  private running = false;
  private paused = false;
  private busy = false;
  private queue: Float32Array[] = [];
  private levelCb?: (l: number) => void;
  private scoreCb?: (s: number) => void;
  onFatal?: (error: string) => void;

  constructor(
    private cfg: { model: Uint8Array; deviceId?: string; threshold: number }
  ) {
    this.detector = new WakeDetector(cfg.threshold);
  }

  async start(onWake: () => void): Promise<void> {
    this.runner = await openRunner(this.cfg.model);
    this.pipeline = new OwwPipeline(this.runner);

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(this.cfg.deviceId ? { deviceId: { exact: this.cfg.deviceId } } : {}),
        // Raw-ish audio: the models expect natural levels, and Windows' voice
        // processing can swallow a quiet wake word.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    this.stream.getAudioTracks()[0]?.addEventListener("ended", () => {
      if (this.running) {
        this.stop();
        this.onFatal?.("audio-capture");
      }
    });

    // Prefer letting Chromium resample to 16 kHz; fall back to the device
    // rate (the worklet then resamples) if that combination is refused.
    try {
      await this.connect(new AudioContext({ sampleRate: SAMPLE_RATE }));
    } catch {
      await this.ctx?.close().catch(() => {});
      await this.connect(new AudioContext());
    }

    this.running = true;
    this.paused = false;
    this.node!.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (!this.running) return;
      this.levelCb?.(level(e.data));
      if (this.paused) return;
      this.queue.push(e.data);
      // Inference is a few ms per chunk; if the PC stalls, drop old audio
      // rather than falling ever further behind real time.
      if (this.queue.length > 25) this.queue.splice(0, this.queue.length - 25);
      this.drain(onWake);
    };
  }

  private async connect(ctx: AudioContext) {
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(workletUrl);
    const src = ctx.createMediaStreamSource(this.stream!);
    this.node = new AudioWorkletNode(ctx, "oww-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
    src.connect(this.node);
    if (ctx.state === "suspended") await ctx.resume();
  }

  private async drain(onWake: () => void) {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length && this.running && !this.paused) {
        const chunk = this.queue.shift()!;
        const scores = await this.pipeline!.push(chunk);
        for (const s of scores) {
          if (s !== null) this.scoreCb?.(s);
          if (this.detector.hit(s, performance.now())) {
            this.pauseListening();
            onWake();
            return;
          }
        }
      }
    } catch (e) {
      this.stop();
      this.onFatal?.(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy = false;
    }
  }

  /** Ignore audio while a conversation is running; the mic stays open. */
  pauseListening() {
    this.paused = true;
    this.queue = [];
  }

  resumeListening() {
    if (!this.running) return;
    // Fresh buffers so the end of the conversation can't re-trigger the wake.
    this.pipeline?.reset();
    this.paused = false;
  }

  setThreshold(t: number) {
    this.detector.threshold = t;
  }

  stop() {
    this.running = false;
    this.paused = false;
    this.queue = [];
    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.runner?.release().catch(() => {});
    this.node = undefined;
    this.stream = undefined;
    this.ctx = undefined;
    this.runner = undefined;
  }

  onLevel(cb: (l: number) => void) {
    this.levelCb = cb;
  }

  /** Live model score 0..1 for the test meter in Voice & Audio. */
  onScore(cb: (s: number) => void) {
    this.scoreCb = cb;
  }
}

/** RMS of an int16-scale chunk as 0..1, matching MicInput's meter feel. */
function level(chunk: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) {
    const n = chunk[i] / 32768;
    sum += n * n;
  }
  return Math.min(1, Math.sqrt(sum / chunk.length) * 3);
}
