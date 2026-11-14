/// <reference lib="webworker" />
/**
 * Runs Kokoro text-to-speech off the main thread, so generating audio never
 * freezes BEV's window or the overlay. The WebAssembly runtime is loaded from
 * BEV's own files; the voice model (~90 MB) is downloaded from Hugging Face
 * once and cached by the webview.
 */
import { KokoroTTS, env as kokoroEnv } from "kokoro-js";
import { env } from "@huggingface/transformers";
import wasmUrl from "../../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url";
import mjsUrl from "../../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url";

const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

// Never look for models on BEV's own origin, and never fetch the runtime from a CDN.
env.allowLocalModels = false;
const abs = (u: string) => new URL(u, self.location.href).href;
kokoroEnv.wasmPaths = { wasm: abs(wasmUrl), mjs: abs(mjsUrl) } as unknown as string;
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads = 1; // threads need cross-origin isolation
  env.backends.onnx.wasm.proxy = false;
}

export type WorkerIn =
  | { type: "load"; allowGpu: boolean }
  | { type: "generate"; id: number; text: string; voice: string; speed: number };

export type WorkerOut =
  | { type: "progress"; loaded: number; total: number; file: string }
  | { type: "ready"; device: string; ms: number }
  /** The graphics card failed at runtime; now running on the CPU. */
  | { type: "gpu-failed"; message: string }
  | { type: "audio"; id: number; samples: Float32Array; rate: number; ms: number }
  | { type: "error"; id?: number; message: string };

let tts: Promise<{ model: KokoroTTS; device: string }> | null = null;
const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

/** WebGPU if this PC has a usable graphics adapter. */
async function hasGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!(gpu && (await gpu.requestAdapter()));
  } catch {
    return false;
  }
}

let allowGpu = true;

function load() {
  tts ??= (async () => {
    const t0 = performance.now();
    // Per-file byte progress, so the UI can show one overall percentage.
    const files = new Map<string, { loaded: number; total: number }>();
    const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === "progress" && p.file && p.total) {
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        post({ type: "progress", loaded, total, file: p.file });
      }
    };
    // Graphics card: the full model (310 MB, many times faster than real time).
    // CPU: the quantised model (88 MB); slower, but works on any PC.
    if (allowGpu && (await hasGpu())) {
      try {
        const model = await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: "fp32", device: "webgpu", progress_callback });
        post({ type: "ready", device: "webgpu", ms: Math.round(performance.now() - t0) });
        return { model, device: "webgpu" };
      } catch (e) {
        console.warn("Kokoro on WebGPU failed, using the CPU instead:", e);
        post({ type: "gpu-failed", message: e instanceof Error ? e.message : String(e) });
        allowGpu = false;
        files.clear();
      }
    }
    const model = await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: "q8", device: "wasm", progress_callback });
    post({ type: "ready", device: "wasm", ms: Math.round(performance.now() - t0) });
    return { model, device: "wasm" };
  })().catch((e) => {
    tts = null; // allow a retry, e.g. after the network comes back
    throw e;
  });
  return tts;
}

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      allowGpu = msg.allowGpu;
      await load();
    } else if (msg.type === "generate") {
      const t0 = performance.now();
      let { model, device } = await load();
      let audio;
      try {
        audio = await model.generate(msg.text, { voice: msg.voice as never, speed: msg.speed });
      } catch (e) {
        if (device !== "webgpu") throw e;
        // The graphics card path broke mid-use: drop to the CPU and retry once.
        post({ type: "gpu-failed", message: e instanceof Error ? e.message : String(e) });
        allowGpu = false;
        tts = null;
        ({ model, device } = await load());
        audio = await model.generate(msg.text, { voice: msg.voice as never, speed: msg.speed });
      }
      const samples = audio.audio as Float32Array;
      post({ type: "audio", id: msg.id, samples, rate: audio.sampling_rate, ms: Math.round(performance.now() - t0) }, [samples.buffer]);
    }
  } catch (err) {
    post({ type: "error", id: "id" in msg ? msg.id : undefined, message: err instanceof Error ? err.message : String(err) });
  }
};
