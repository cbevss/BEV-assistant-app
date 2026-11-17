/**
 * Local sentence embeddings (see embed.worker.ts). Everything degrades to
 * keyword search when the model isn't downloaded yet or can't load.
 */
import type { EmbedIn, EmbedOut } from "./embed.worker";

export type EmbedStatus = { state: "idle" } | { state: "downloading"; percent: number } | { state: "ready" } | { state: "error"; message: string };

let status: EmbedStatus = { state: "idle" };
const listeners = new Set<(s: EmbedStatus) => void>();
function setStatus(s: EmbedStatus) {
  status = s;
  listeners.forEach((l) => l(s));
}
export const embedStatus = () => status;
export function onEmbedStatus(cb: (s: EmbedStatus) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();

function ensure(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./embed.worker.ts", import.meta.url), { type: "module" });
  setStatus({ state: "downloading", percent: 0 });
  worker.onmessage = (e: MessageEvent<EmbedOut>) => {
    const m = e.data;
    if (m.type === "progress") setStatus({ state: "downloading", percent: m.total ? Math.round((m.loaded / m.total) * 100) : 0 });
    else if (m.type === "ready") setStatus({ state: "ready" });
    else if (m.type === "vectors") {
      if (status.state !== "ready") setStatus({ state: "ready" });
      pending.get(m.id)?.resolve(m.vectors);
      pending.delete(m.id);
    } else if (m.type === "error") {
      if (m.id !== undefined) {
        pending.get(m.id)?.reject(new Error(m.message));
        pending.delete(m.id);
      }
      if (status.state !== "ready") setStatus({ state: "error", message: m.message });
    }
  };
  worker.onerror = (e) => {
    setStatus({ state: "error", message: e.message || "the embedding model crashed" });
    pending.forEach((p) => p.reject(new Error("embedding model crashed")));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  worker.postMessage({ type: "load" } satisfies EmbedIn);
  return worker;
}

export function preloadEmbedder() {
  if (typeof Worker === "undefined") return;
  ensure();
}

/** Embed texts. Rejects if the model isn't ready within `timeoutMs` (it keeps loading). */
export function embed(texts: string[], timeoutMs = 60_000): Promise<Float32Array[]> {
  if (typeof Worker === "undefined") return Promise.reject(new Error("no workers here"));
  if (texts.length === 0) return Promise.resolve([]);
  const w = ensure();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("embedding model not ready"));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    w.postMessage({ type: "embed", id, texts } satisfies EmbedIn);
  });
}

/** A query vector only if the model is already ready (never waits for a download). */
export async function quickEmbed(text: string): Promise<Float32Array | null> {
  if (status.state !== "ready") return null;
  try {
    return (await embed([text], 2500))[0] ?? null;
  } catch {
    return null;
  }
}
