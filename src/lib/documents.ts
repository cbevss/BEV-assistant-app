/**
 * "Ask about your documents": the local index of the user's documents
 * (see src-tauri/src/docs.rs) and helpers for the AI tools and the UI.
 */
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "@/state/settings";

export interface DocHit {
  path: string;
  name: string;
  page: number;
  snippet: string;
}
export interface DocStatus {
  files: number;
  passages: number;
  unreadable: number;
  running: boolean;
  done: number;
  total: number;
}
export interface IndexReport {
  indexed: number;
  unchanged: number;
  removed: number;
  unreadable: number;
}
export interface DocText {
  name: string;
  pages: number;
  from_page: number;
  to_page: number;
  text: string;
  truncated: boolean;
}

export const docsApi = {
  index: (folders: string[]) => invoke<IndexReport>("docs_index", { folders }),
  status: () => invoke<DocStatus>("docs_status"),
  search: (query: string, limit = 8) => invoke<{ hits: DocHit[]; named: DocHit[] }>("docs_search", { query, limit }),
  read: (path: string, page?: number) => invoke<DocText>("docs_read", { path, page }),
  clear: () => invoke<void>("docs_clear"),
};

/** Re-read the chosen folders if it's been a while (called at start-up). */
export const REINDEX_AFTER_MS = 12 * 3600_000;

export function needsReindex(folders: string[], lastIndexed: number | undefined, now = Date.now()): boolean {
  return folders.length > 0 && (!lastIndexed || now - lastIndexed > REINDEX_AFTER_MS);
}

/** Read the chosen folders now; records when, for the start-up check. */
export async function indexDocuments(): Promise<IndexReport> {
  const { settings, update } = useSettings.getState();
  const r = await docsApi.index(settings.documents.folders);
  await update({ documents: { ...useSettings.getState().settings.documents, lastIndexed: Date.now() } });
  return r;
}

export function describeReport(r: IndexReport): string {
  const parts = [`read ${r.indexed} new or changed`];
  if (r.unchanged) parts.push(`${r.unchanged} unchanged`);
  if (r.removed) parts.push(`${r.removed} removed`);
  if (r.unreadable) parts.push(`${r.unreadable} couldn't be read`);
  return parts.join(", ");
}

/** Pure: search results as text for the AI, grouped by document. */
export function formatHits(hits: DocHit[], named: DocHit[]): string {
  if (!hits.length && !named.length) return "";
  const byDoc = new Map<string, DocHit[]>();
  for (const h of hits) byDoc.set(h.path, [...(byDoc.get(h.path) ?? []), h]);
  const lines: string[] = [];
  for (const [path, hs] of byDoc) {
    lines.push(`${hs[0].name} (${path})`);
    for (const h of hs) lines.push(`  ${h.page ? `p.${h.page}: ` : ""}${h.snippet.replace(/\s+/g, " ").trim()}`);
  }
  const extra = named.filter((n) => !byDoc.has(n.path));
  if (extra.length) lines.push(`Documents whose names match: ${extra.map((n) => `${n.name} (${n.path})`).join("; ")}`);
  return lines.join("\n");
}
