/** Small, dependency-free helpers for local semantic search. */

export function encodeVec(v: Float32Array): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function decodeVec(b64: string): Float32Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new Float32Array(bytes.buffer, 0, Math.floor(bytes.length / 4));
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const STOP = new Set("a an the my is are was to of for in on at and or it its i me you your that this be what whats which with do does".split(" "));

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w));
}

export function jaccard(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Share of query words found in the text (0..1). */
export function keywordScore(query: string, text: string): number {
  const q = tokens(query);
  if (q.length === 0) return 0;
  const t = new Set(tokens(text));
  return q.filter((w) => t.has(w) || [...t].some((x) => x.startsWith(w) && w.length >= 3)).length / q.length;
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/**
 * Rank items for a query by meaning (cosine, when vectors exist) and words.
 * Items with neither a semantic nor a keyword match are dropped.
 */
export function rank<T>(
  items: T[],
  query: string,
  text: (t: T) => string,
  opts: { queryVec?: Float32Array | null; vec?: (t: T) => Float32Array | undefined; minCos?: number; limit?: number } = {}
): Array<Ranked<T>> {
  const minCos = opts.minCos ?? 0.35;
  const out: Array<Ranked<T>> = [];
  for (const item of items) {
    const kw = keywordScore(query, text(item));
    const v = opts.queryVec && opts.vec ? opts.vec(item) : undefined;
    const cos = v && opts.queryVec ? cosine(opts.queryVec, v) : 0;
    const semantic = cos >= minCos ? cos : 0;
    if (kw === 0 && semantic === 0) continue;
    out.push({ item, score: Math.max(semantic, 0) * 0.7 + kw * 0.3 + (semantic && kw ? 0.05 : 0) });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, opts.limit ?? 10);
}
