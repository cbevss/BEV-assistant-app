/**
 * 16 kHz mono microphone capture in 80 ms chunks, shared by the Whisper
 * recogniser, barge-in and calibration (the wake word has its own instance of
 * the same worklet). Float samples −1..1.
 */
import workletUrl from "./oww/capture-worklet.js?url";
import { micErrorProblem } from "./mic";

export interface CaptureOptions {
  deviceId?: string;
  /** Windows/Chromium voice processing. Echo cancellation helps barge-in; AGC stays off (it moves the system mic level). */
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
}

export class MicProblemError extends Error {}

export class Mic16k {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  /** What the browser actually gave us (sample rate, processing…). */
  settings: MediaTrackSettings | null = null;
  onEnded?: () => void;

  async start(opts: CaptureOptions, onChunk: (c: Float32Array) => void): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
          echoCancellation: opts.echoCancellation ?? true,
          noiseSuppression: opts.noiseSuppression ?? false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (e) {
      throw new MicProblemError(micErrorProblem(e).message);
    }
    const track = this.stream.getAudioTracks()[0];
    this.settings = track?.getSettings() ?? null;
    track?.addEventListener("ended", () => this.onEnded?.());
    try {
      this.ctx = new AudioContext({ sampleRate: 16000 });
    } catch {
      this.ctx = new AudioContext();
    }
    await this.ctx.audioWorklet.addModule(workletUrl);
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "oww-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      // The worklet emits int16-scale samples (for the wake word); normalise.
      const c = e.data;
      for (let i = 0; i < c.length; i++) c[i] /= 32768;
      onChunk(c);
    };
    src.connect(this.node);
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  stop() {
    if (this.node) this.node.port.onmessage = null;
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.node = null;
    this.stream = null;
    this.ctx = null;
  }
}

/** Record for a fixed time (calibration). */
export async function record(ms: number, opts: CaptureOptions, onLevel?: (c: Float32Array) => void, signal?: AbortSignal): Promise<{ audio: Float32Array; settings: MediaTrackSettings | null }> {
  const mic = new Mic16k();
  const parts: Float32Array[] = [];
  await mic.start(opts, (c) => {
    parts.push(c);
    onLevel?.(c);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    });
  } finally {
    mic.stop();
  }
  const audio = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    audio.set(p, o);
    o += p.length;
  }
  return { audio, settings: mic.settings };
}
