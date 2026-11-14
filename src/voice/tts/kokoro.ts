import type { SpeechSynthesizer } from "../types";
import type { WorkerIn, WorkerOut } from "./kokoro.worker";
import { speakChunked } from "./player";

/** Kokoro voices offered in Voice & Audio (British first: BEV speaks en-GB). */
export const KOKORO_VOICES = [
  { id: "bm_george", name: "George · British male" },
  { id: "bm_lewis", name: "Lewis · British male" },
  { id: "bm_daniel", name: "Daniel · British male" },
  { id: "bm_fable", name: "Fable · British male" },
  { id: "bf_emma", name: "Emma · British female" },
  { id: "bf_isabella", name: "Isabella · British female" },
  { id: "bf_alice", name: "Alice · British female" },
  { id: "bf_lily", name: "Lily · British female" },
  { id: "am_michael", name: "Michael · American male" },
  { id: "af_heart", name: "Heart · American female" },
];

export type KokoroStatus =
  | { state: "idle" }
  | { state: "downloading"; percent: number }
  | { state: "ready"; device: string }
  | { state: "error"; message: string };

/*
 * Graphics-card crash guard. WebGPU is fast but driver problems can crash the
 * page outright, which no try/catch survives. So: note "trying" before using
 * the GPU, clear it once audio comes out. If BEV starts and finds the note,
 * the last attempt crashed: use the CPU from then on (until the user resets).
 */
const GPU_TRYING = "bev.kokoro.gpuTrying";
const GPU_BROKEN = "bev.kokoro.gpuBroken";
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};
if (store.get(GPU_TRYING)) {
  store.set(GPU_BROKEN, "crashed while starting the voice on the graphics card");
  store.del(GPU_TRYING);
}

/** Why the graphics card is disabled for Kokoro, or null if it isn't. */
export function kokoroGpuProblem(): string | null {
  return store.get(GPU_BROKEN);
}

/** Forget a past GPU failure and try the graphics card again next time. */
export function resetKokoroGpu() {
  store.del(GPU_BROKEN);
  restartKokoro();
}

let gpuWanted = true;
/** Turn graphics-card use on/off (Voice & Audio). Takes effect on next use. */
export function setKokoroGpu(on: boolean) {
  if (on !== gpuWanted) {
    gpuWanted = on;
    restartKokoro();
  }
}

/** Drop the loaded model; the next speak/preload starts fresh with current settings. */
function restartKokoro() {
  worker?.terminate();
  worker = null;
  pending.forEach((p) => p.reject(new Error("voice engine restarted")));
  pending.clear();
  readyWaiters.forEach((w) => w.reject(new Error("voice engine restarted")));
  readyWaiters = [];
  store.del(GPU_TRYING);
  setStatus({ state: "idle" });
}

/**
 * One shared worker for the whole app. The model loads on first use (or when
 * `preloadKokoro` is called, e.g. when the user picks this voice) and stays
 * loaded, so later replies start quickly.
 */
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (a: { samples: Float32Array; rate: number }) => void; reject: (e: Error) => void }>();
let status: KokoroStatus = { state: "idle" };
const listeners = new Set<(s: KokoroStatus) => void>();
let readyWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];

function setStatus(s: KokoroStatus) {
  status = s;
  listeners.forEach((l) => l(s));
}

export function kokoroStatus(): KokoroStatus {
  return status;
}

export function onKokoroStatus(cb: (s: KokoroStatus) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./kokoro.worker.ts", import.meta.url), { type: "module" });
  const allowGpu = gpuWanted && !kokoroGpuProblem();
  if (allowGpu) store.set(GPU_TRYING, "1");
  worker.postMessage({ type: "load", allowGpu } satisfies WorkerIn);
  worker.onmessage = (e: MessageEvent<WorkerOut>) => {
    const m = e.data;
    if (m.type === "progress") {
      setStatus({ state: "downloading", percent: m.total ? Math.round((m.loaded / m.total) * 100) : 0 });
    } else if (m.type === "gpu-failed") {
      store.set(GPU_BROKEN, m.message);
      store.del(GPU_TRYING);
    } else if (m.type === "ready") {
      // On the CPU there's nothing to guard; on the GPU, wait for real audio.
      if (m.device !== "webgpu") store.del(GPU_TRYING);
      setStatus({ state: "ready", device: m.device });
      readyWaiters.forEach((w) => w.resolve());
      readyWaiters = [];
    } else if (m.type === "audio") {
      store.del(GPU_TRYING); // the graphics card produced speech: it works
      pending.get(m.id)?.resolve({ samples: m.samples, rate: m.rate });
      pending.delete(m.id);
    } else if (m.type === "error") {
      const err = new Error(m.message);
      if (m.id !== undefined) {
        pending.get(m.id)?.reject(err);
        pending.delete(m.id);
      }
      if (status.state !== "ready") {
        setStatus({ state: "error", message: m.message });
        readyWaiters.forEach((w) => w.reject(err));
        readyWaiters = [];
      }
    }
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || "voice engine crashed");
    setStatus({ state: "error", message: err.message });
    pending.forEach((p) => p.reject(err));
    pending.clear();
    readyWaiters.forEach((w) => w.reject(err));
    readyWaiters = [];
    worker?.terminate();
    worker = null; // a fresh worker on next use
  };
  return worker;
}

/** Download/load the model now. Resolves when it's ready to speak. */
export function preloadKokoro(): Promise<void> {
  if (status.state === "ready") return Promise.resolve();
  return new Promise((resolve, reject) => {
    readyWaiters.push({ resolve, reject });
    if (status.state !== "downloading") setStatus({ state: "downloading", percent: 0 });
    getWorker(); // loading starts as soon as the worker exists
  });
}

/** Synthesise one chunk of text (exported for previews and tests). */
export function kokoroGenerate(text: string, voice: string, speed = 1, signal = new AbortController().signal) {
  return generate(text, voice, speed, signal);
}

function generate(text: string, voice: string, speed: number, signal: AbortSignal) {
  return new Promise<{ samples: Float32Array; rate: number }>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    // The worker can't stop mid-sentence, but the caller stops waiting.
    signal.addEventListener("abort", () => {
      if (pending.delete(id)) reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
    getWorker().postMessage({ type: "generate", id, text, voice, speed } satisfies WorkerIn);
  });
}

export class KokoroSynthesizer implements SpeechSynthesizer {
  readonly id = "kokoro";
  private ctl: AbortController | null = null;

  constructor(private opts: { voice?: string; rate?: number; volume?: number } = {}) {}

  async listVoices() {
    return KOKORO_VOICES;
  }

  async speak(text: string, opts?: { signal?: AbortSignal; onLevel?: (l: number) => void }) {
    this.ctl?.abort();
    const ctl = (this.ctl = new AbortController());
    opts?.signal?.addEventListener("abort", () => ctl.abort(), { once: true });
    const voice = this.opts.voice || KOKORO_VOICES[0].id;
    const speed = Math.min(1.5, Math.max(0.6, this.opts.rate ?? 1));
    await speakChunked(text, (chunk, signal) => generate(chunk, voice, speed, signal), {
      signal: ctl.signal,
      onLevel: opts?.onLevel,
      volume: this.opts.volume,
    });
  }

  cancel() {
    this.ctl?.abort();
  }
}
