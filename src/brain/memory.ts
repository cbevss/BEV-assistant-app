/**
 * BEV's second brain on top of the local database: memories that can be found
 * by meaning, duplicate/contradiction checks, a notes vault with sources, and
 * conversation history. Semantic search runs on this PC; without the model it
 * falls back to keyword search.
 */
import { native, type MemoryRow, type Note } from "@/lib/native";
import { useSettings } from "@/state/settings";
import { looksLikeSecretValue } from "@/lib/sensitive";
import { embed, quickEmbed, preloadEmbedder } from "./embed";
import { decodeVec, encodeVec, jaccard, rank, cosine, tokens } from "./vectors";

const semanticOn = () => useSettings.getState().settings.semanticSearch !== false;

// ---------------------------------------------------------------------------
// Embedding cache

const vecs: Record<"memory" | "note", Map<number, Float32Array> | null> = { memory: null, note: null };

async function vectors(kind: "memory" | "note"): Promise<Map<number, Float32Array>> {
  if (vecs[kind]) return vecs[kind]!;
  const rows = await native.embeddingsList(kind).catch(() => []);
  const m = new Map(rows.map((r) => [r.id, decodeVec(r.vec)] as const));
  vecs[kind] = m;
  return m;
}
export function invalidate(kind: "memory" | "note") {
  vecs[kind] = null;
}

export const memoryText = (m: Pick<MemoryRow, "key" | "value">) => `${m.key}: ${m.value}`;
export const noteText = (n: Pick<Note, "title" | "body" | "tags">) => `${n.title}\n${n.tags}\n${n.body}`.slice(0, 2000);

let backfilling = false;
/** Embed anything stored without a vector yet (runs in the background). */
export async function backfillEmbeddings(): Promise<void> {
  if (backfilling || !semanticOn()) return;
  backfilling = true;
  try {
    for (const kind of ["memory", "note"] as const) {
      const have = await vectors(kind);
      const items: Array<{ id: number; text: string }> =
        kind === "memory"
          ? (await native.memoryList()).filter((m) => !have.has(m.id)).map((m) => ({ id: m.id, text: memoryText(m) }))
          : (await native.notesList()).filter((n) => !n.has_embedding).map((n) => ({ id: n.id, text: noteText(n) }));
      for (let i = 0; i < items.length; i += 16) {
        const batch = items.slice(i, i + 16);
        const out = await embed(batch.map((b) => b.text), 180_000);
        for (let k = 0; k < batch.length; k++) {
          await native.setEmbedding(kind, batch[k].id, encodeVec(out[k]));
          have.set(batch[k].id, out[k]);
        }
      }
    }
  } catch {
    // Model unavailable (offline?): keyword search still works. Try again later.
  } finally {
    backfilling = false;
  }
}

/** Start the model and fill in missing vectors, a little after startup. */
export function startBrain() {
  if (!semanticOn()) return;
  setTimeout(() => {
    preloadEmbedder();
    backfillEmbeddings();
  }, 8000);
}

async function embedOne(kind: "memory" | "note", id: number, text: string) {
  if (!semanticOn()) return;
  try {
    const [v] = await embed([text], 120_000);
    await native.setEmbedding(kind, id, encodeVec(v));
    (await vectors(kind)).set(id, v);
  } catch {
    /* backfilled later */
  }
}

// ---------------------------------------------------------------------------
// Memories

export async function searchMemories(query: string, limit = 8, rows?: MemoryRow[]) {
  const all = rows ?? (await native.memoryList());
  const qv = semanticOn() ? await quickEmbed(query) : null;
  const vs = qv ? await vectors("memory") : null;
  return rank(all, query, memoryText, { queryVec: qv, vec: (m) => vs?.get(m.id), limit });
}

/** Memories for the system prompt: all of them when few, else the most relevant. */
export async function memoriesForPrompt(query: string, max = 40): Promise<MemoryRow[]> {
  const all = await native.memoryList().catch(() => [] as MemoryRow[]);
  if (all.length <= max) return all;
  const relevant = (await searchMemories(query, 25, all)).map((r) => r.item);
  const ids = new Set(relevant.map((m) => m.id));
  // Fill with the most recently updated so standing preferences stay visible.
  return [...relevant, ...all.filter((m) => !ids.has(m.id)).slice(0, max - relevant.length)];
}

export type RememberResult =
  | { kind: "saved"; id?: number; previous?: string }
  | { kind: "conflict"; existing: MemoryRow; similarity: number }
  | { kind: "duplicate"; existing: MemoryRow };

const sameKey = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const sameValue = (a: string, b: string) => tokens(a).join(" ") === tokens(b).join(" ");

/** The closest existing memory about the same thing, if any. Pure; tested. */
export function closestMemory(key: string, rows: MemoryRow[], vec?: Float32Array | null, vecOf?: (id: number) => Float32Array | undefined) {
  let best: { row: MemoryRow; sim: number } | null = null;
  for (const r of rows) {
    if (sameKey(r.key, key)) return { row: r, sim: 1 };
    const keySim = jaccard(r.key, key);
    const v = vec && vecOf ? vecOf(r.id) : undefined;
    const sem = v && vec ? cosine(vec, v) : 0;
    const sim = Math.max(keySim, sem >= 0.8 ? sem : 0);
    if (sim >= 0.5 && (!best || sim > best.sim)) best = { row: r, sim };
  }
  return best;
}

/**
 * Save a memory, catching duplicates and contradictions first. `replaces`
 * overwrites a specific memory; `distinct` saves even if one looks similar.
 */
export async function remember(key: string, value: string, opts: { category?: string; replaces?: number; distinct?: boolean } = {}): Promise<RememberResult> {
  const rows = await native.memoryList();
  if (opts.replaces !== undefined) {
    const old = rows.find((r) => r.id === opts.replaces);
    if (!old) throw new Error(`there's no memory #${opts.replaces}`);
    if (!sameKey(old.key, key)) await native.memoryDelete(old.id);
    await native.memoryUpsert(key, value, opts.category ?? old.category);
    await afterSave(key, value);
    return { kind: "saved", previous: `${old.key}: ${old.value}` };
  }
  const exact = rows.find((r) => sameKey(r.key, key));
  if (exact) {
    if (sameValue(exact.value, value)) return { kind: "duplicate", existing: exact };
    await native.memoryUpsert(exact.key, value, opts.category ?? exact.category);
    await afterSave(exact.key, value);
    return { kind: "saved", id: exact.id, previous: exact.value };
  }
  if (!opts.distinct) {
    const qv = semanticOn() ? await quickEmbed(`${key}: ${value}`) : null;
    const vs = qv ? await vectors("memory") : null;
    const close = closestMemory(key, rows, qv, (id) => vs?.get(id));
    if (close) {
      if (sameValue(close.row.value, value)) return { kind: "duplicate", existing: close.row };
      return { kind: "conflict", existing: close.row, similarity: close.sim };
    }
  }
  await native.memoryUpsert(key, value, opts.category);
  await afterSave(key, value);
  return { kind: "saved" };
}

async function afterSave(key: string, value: string) {
  const row = (await native.memoryList()).find((r) => sameKey(r.key, key));
  if (row) {
    (await vectors("memory")).delete(row.id);
    embedOne("memory", row.id, memoryText({ key, value }));
  }
}

export async function forgetMemory(id: number) {
  await native.memoryDelete(id);
  (await vectors("memory")).delete(id);
}

// ---------------------------------------------------------------------------
// Notes

export async function saveNote(n: { id?: number; title: string; body: string; source?: string; tags?: string }): Promise<number> {
  const id = await native.noteSave(n);
  (await vectors("note")).delete(id);
  embedOne("note", id, noteText({ title: n.title, body: n.body, tags: n.tags ?? "" }));
  return id;
}

export async function deleteNote(id: number) {
  await native.noteDelete(id);
  (await vectors("note")).delete(id);
}

export interface NoteResult {
  id: number;
  title: string;
  snippet: string;
  source: string;
  updated_at: number;
}

/** Notes matching by words (SQLite full-text) and by meaning, merged. */
export async function searchNotes(query: string, limit = 6): Promise<NoteResult[]> {
  const fts = await native.notesSearch(query, limit).catch(() => []);
  const out = new Map<number, NoteResult & { score: number }>();
  fts.forEach((h, i) => out.set(h.id, { ...h, score: 1 - i * 0.05 }));
  const qv = semanticOn() ? await quickEmbed(query) : null;
  if (qv) {
    const vs = await vectors("note");
    const scored = [...vs.entries()].map(([id, v]) => ({ id, cos: cosine(qv, v) })).filter((x) => x.cos >= 0.4).sort((a, b) => b.cos - a.cos).slice(0, limit);
    for (const s of scored) {
      const prev = out.get(s.id);
      if (prev) prev.score += s.cos;
      else {
        const n = await native.noteGet(s.id).catch(() => null);
        if (n) out.set(n.id, { id: n.id, title: n.title, snippet: n.body.slice(0, 240), source: n.source, updated_at: n.updated_at, score: s.cos });
      }
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Conversation history

let session = newSession();
function newSession() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
/** Start a new conversation (e.g. after the chat is cleared or a long gap). */
export function startNewSession() {
  session = newSession();
}
let lastAt = 0;

/** Record one exchange. Secrets aren't kept; nothing is stored if history is off. */
export async function recordExchange(userText: string, reply: string) {
  const s = useSettings.getState().settings;
  if (!s.keepHistory) return;
  // A long pause means a new conversation.
  if (Date.now() - lastAt > 30 * 60_000) startNewSession();
  lastAt = Date.now();
  const clean = (t: string) => (looksLikeSecretValue(t) ? "[not saved: it looked like it contained a key or card number]" : t);
  if (userText.trim()) await native.convAdd(session, "user", clean(userText)).catch(() => {});
  if (reply.trim()) await native.convAdd(session, "assistant", clean(reply)).catch(() => {});
}

export async function pruneHistory() {
  const s = useSettings.getState().settings;
  await native.convPrune(Math.max(1, s.historyDays || 90)).catch(() => {});
}
