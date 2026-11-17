/// <reference lib="webworker" />
/**
 * Whisper speech recognition off the main thread. Runs on this PC: audio
 * never leaves it. The model is downloaded once from Hugging Face and cached.
 */
import { pipeline, env } from "@huggingface/transformers";
import wasmUrl from "../../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url";
import mjsUrl from "../../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url";

env.allowLocalModels = false;
const abs = (u: string) => new URL(u, self.location.href).href;
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = { wasm: abs(wasmUrl), mjs: abs(mjsUrl) } as never;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
}

export type WhisperIn =
  | { type: "load"; model: string; allowGpu: boolean }
  | { type: "transcribe"; id: number; audio: Float32Array };

export type WhisperOut =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready"; device: string; ms: number }
  | { type: "gpu-failed"; message: string }
  | { type: "text"; id: number; text: string; ms: number }
  | { type: "error"; id?: number; message: string };

type Asr = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
let asr: Promise<{ run: Asr; device: string }> | null = null;
let current = "";
const post = (m: WhisperOut) => (self as DedicatedWorkerGlobalScope).postMessage(m);

async function hasGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!(gpu && (await gpu.requestAdapter()));
  } catch {
    return false;
  }
}

function load(model: string, allowGpu: boolean) {
  if (asr && current === model) return asr;
  current = model;
  asr = (async () => {
    const t0 = performance.now();
    const files = new Map<string, { loaded: number; total: number }>();
    const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === "progress" && p.file && p.total) {
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        post({ type: "progress", loaded, total });
      }
    };
    if (allowGpu && (await hasGpu())) {
      try {
        const run = (await pipeline("automatic-speech-recognition", model, {
          device: "webgpu",
          dtype: { encoder_model: "fp32", decoder_model_merged: "q4" },
          progress_callback,
        } as never)) as unknown as Asr;
        post({ type: "ready", device: "webgpu", ms: Math.round(performance.now() - t0) });
        return { run, device: "webgpu" };
      } catch (e) {
        post({ type: "gpu-failed", message: e instanceof Error ? e.message : String(e) });
        files.clear();
      }
    }
    const run = (await pipeline("automatic-speech-recognition", model, { device: "wasm", dtype: "q8", progress_callback } as never)) as unknown as Asr;
    post({ type: "ready", device: "wasm", ms: Math.round(performance.now() - t0) });
    return { run, device: "wasm" };
  })().catch((e) => {
    asr = null;
    throw e;
  });
  return asr;
}

let model = "onnx-community/whisper-base.en";
let gpu = true;

self.onmessage = async (e: MessageEvent<WhisperIn>) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      model = msg.model;
      gpu = msg.allowGpu;
      await load(model, gpu);
    } else {
      const t0 = performance.now();
      const { run } = await load(model, gpu);
      const out = await run(msg.audio, { chunk_length_s: 30, return_timestamps: false });
      const text = (Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text).trim();
      post({ type: "text", id: msg.id, text, ms: Math.round(performance.now() - t0) });
    }
  } catch (err) {
    post({ type: "error", id: "id" in msg ? msg.id : undefined, message: err instanceof Error ? err.message : String(err) });
  }
};
