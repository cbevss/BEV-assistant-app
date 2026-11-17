/**
 * Whisper speech recognition on this PC, as a SpeechRecognizer. Unlike the
 * Windows engine it records from the microphone chosen in BEV, uses BEV's own
 * pause detection, and keeps audio on the PC.
 */
import type { SpeechRecognizer } from "../types";
import type { WhisperIn, WhisperOut } from "./whisper.worker";
import { Mic16k, type CaptureOptions } from "../capture";
import { Endpointer } from "../audio-analysis";
import { cleanTranscript } from "./clean";

export const WHISPER_MODELS = {
  base: { id: "onnx-community/whisper-base.en", label: "Fast (about 80 MB download)" },
  small: { id: "onnx-community/whisper-small.en", label: "More accurate (about 250 MB, slower)" },
} as const;
export type WhisperSize = keyof typeof WHISPER_MODELS;

export type WhisperStatus =
  | { state: "idle" }
  | { state: "downloading"; percent: number }
  | { state: "ready"; device: string }
  | { state: "error"; message: string };

let status: WhisperStatus = { state: "idle" };
const listeners = new Set<(s: WhisperStatus) => void>();
function setStatus(s: WhisperStatus) {
  status = s;
  listeners.forEach((l) => l(s));
}
export function whisperStatus() {
  return status;
}
export function onWhisperStatus(cb: (s: WhisperStatus) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Graphics-card crash guard (same approach as the Kokoro voice).
const GPU_TRYING = "bev.whisper.gpuTrying";
const GPU_BROKEN = "bev.whisper.gpuBroken";
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* unavailable */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* unavailable */ } },
};
if (ls.get(GPU_TRYING)) {
  ls.set(GPU_BROKEN, "crashed while starting speech recognition on the graphics card");
  ls.del(GPU_TRYING);
}

let worker: Worker | null = null;
let loadedKey = "";
let nextId = 1;
const pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();

function ensureWorker(size: WhisperSize, allowGpu: boolean) {
  const gpu = allowGpu && !ls.get(GPU_BROKEN);
  const key = `${size}|${gpu}`;
  if (worker && key === loadedKey) return worker;
  worker?.terminate();
  pending.forEach((p) => p.reject(new Error("speech recognition restarted")));
  pending.clear();
  loadedKey = key;
  worker = new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
  if (gpu) ls.set(GPU_TRYING, "1");
  setStatus({ state: "downloading", percent: 0 });
  worker.onmessage = (e: MessageEvent<WhisperOut>) => {
    const m = e.data;
    if (m.type === "progress") setStatus({ state: "downloading", percent: m.total ? Math.round((m.loaded / m.total) * 100) : 0 });
    else if (m.type === "ready") {
      ls.del(GPU_TRYING);
      setStatus({ state: "ready", device: m.device === "webgpu" ? "graphics card" : "CPU" });
    } else if (m.type === "gpu-failed") {
      ls.del(GPU_TRYING);
      ls.set(GPU_BROKEN, m.message);
    } else if (m.type === "text") {
      ls.del(GPU_TRYING);
      pending.get(m.id)?.resolve(m.text);
      pending.delete(m.id);
    } else if (m.type === "error") {
      if (m.id !== undefined) {
        pending.get(m.id)?.reject(new Error(m.message));
        pending.delete(m.id);
      } else setStatus({ state: "error", message: m.message });
    }
  };
  worker.postMessage({ type: "load", model: WHISPER_MODELS[size].id, allowGpu: gpu } satisfies WhisperIn);
  return worker;
}

/** Start downloading / loading the model (e.g. when the user picks Whisper). */
export function preloadWhisper(size: WhisperSize, allowGpu: boolean) {
  ensureWorker(size, allowGpu);
}

export function transcribe(audio: Float32Array, size: WhisperSize, allowGpu: boolean): Promise<string> {
  const w = ensureWorker(size, allowGpu);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ type: "transcribe", id, audio } satisfies WhisperIn, [audio.buffer]);
  });
}

/** The room's noise level, remembered between utterances so detection is right from the start. */
let lastFloorDb: number | null = null;

export interface WhisperOptions {
  size: WhisperSize;
  allowGpu: boolean;
  capture: () => CaptureOptions;
  endSilenceMs?: number;
}

export class WhisperRecognizer implements SpeechRecognizer {
  readonly id = "whisper";
  constructor(private opts: WhisperOptions) {}

  listenOnce({ signal, onPartial }: { signal?: AbortSignal; onPartial?: (t: string) => void }): Promise<string> {
    const { size, allowGpu } = this.opts;
    ensureWorker(size, allowGpu);
    return new Promise((resolve, reject) => {
      const mic = new Mic16k();
      const ep = new Endpointer({ startAboveFloorDb: 10, startChunks: 2, keepAboveFloorDb: 6, endSilenceMs: this.opts.endSilenceMs ?? 1300, maxMs: 30_000, preRollMs: 400 });
      if (lastFloorDb !== null) ep.setFloor(lastFloorDb);
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        mic.stop();
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => finish(() => reject(new DOMException("aborted", "AbortError")));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      mic.onEnded = () => finish(() => reject(new Error("the microphone was disconnected")));

      mic
        .start(this.opts.capture(), (chunk) => {
          if (done) return;
          const ev = ep.push(chunk);
          if (!ev) return;
          if (ev.type === "start") {
            onPartial?.("…");
            return;
          }
          lastFloorDb = ep.noiseFloorDb;
          const { audio, speechMs } = ev;
          finish(() => {
            if (speechMs < 250) return resolve("");
            onPartial?.("…");
            transcribe(audio, size, allowGpu)
              .then((t) => resolve(cleanTranscript(t, speechMs)))
              .catch(reject);
          });
        })
        .catch((e) => finish(() => reject(e)));
    });
  }
}
