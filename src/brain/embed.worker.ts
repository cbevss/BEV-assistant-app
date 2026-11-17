/// <reference lib="webworker" />
/**
 * Sentence embeddings for semantic memory search, on this PC (CPU, small
 * model: all-MiniLM-L6-v2, ~23 MB, downloaded once and cached).
 */
import { pipeline, env } from "@huggingface/transformers";
import wasmUrl from "../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url";
import mjsUrl from "../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url";

env.allowLocalModels = false;
const abs = (u: string) => new URL(u, self.location.href).href;
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = { wasm: abs(wasmUrl), mjs: abs(mjsUrl) } as never;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
}

export const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";

export type EmbedIn = { type: "load" } | { type: "embed"; id: number; texts: string[] };
export type EmbedOut =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready" }
  | { type: "vectors"; id: number; vectors: Float32Array[] }
  | { type: "error"; id?: number; message: string };

type Extractor = (texts: string[], opts: Record<string, unknown>) => Promise<{ data: Float32Array; dims: number[] }>;
let extractor: Promise<Extractor> | null = null;
const post = (m: EmbedOut, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

function load() {
  if (extractor) return extractor;
  const files = new Map<string, { loaded: number; total: number }>();
  extractor = (async () => {
    const fe = (await pipeline("feature-extraction", EMBED_MODEL, {
      device: "wasm",
      dtype: "q8",
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status === "progress" && p.file && p.total) {
          files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
          let loaded = 0, total = 0;
          for (const f of files.values()) { loaded += f.loaded; total += f.total; }
          post({ type: "progress", loaded, total });
        }
      },
    } as never)) as unknown as Extractor;
    post({ type: "ready" });
    return fe;
  })().catch((e) => {
    extractor = null;
    throw e;
  });
  return extractor;
}

self.onmessage = async (e: MessageEvent<EmbedIn>) => {
  const m = e.data;
  try {
    if (m.type === "load") {
      await load();
      return;
    }
    const fe = await load();
    const out = await fe(m.texts.map((t) => t.slice(0, 2000)), { pooling: "mean", normalize: true });
    const dim = out.dims[out.dims.length - 1];
    const vectors = m.texts.map((_, i) => out.data.slice(i * dim, (i + 1) * dim));
    post({ type: "vectors", id: m.id, vectors }, vectors.map((v) => v.buffer));
  } catch (err) {
    post({ type: "error", id: m.type === "embed" ? m.id : undefined, message: err instanceof Error ? err.message : String(err) });
  }
};
