/**
 * File management helpers: the native file commands, tidy-up planning, and
 * undo for the last few changes BEV made to your files.
 */
import { invoke } from "@tauri-apps/api/core";

export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  /** ms since 1970 */
  modified: number;
}
export interface FileMove {
  from: string;
  to: string;
}
export interface BatchResult {
  done: FileMove[];
  failed: Array<{ from: string; error: string }>;
}
export interface FindQuery {
  query?: string;
  roots?: string[];
  ext?: string[];
  days?: number;
  min_mb?: number;
  folders?: boolean;
}

export const filesApi = {
  list: (path: string, depth = 0) => invoke<{ entries: FileEntry[]; truncated: boolean }>("files_list", { path, depth }),
  find: (query: FindQuery) => invoke<FileEntry[]>("files_find", { query }),
  move: (items: FileMove[], copy = false) => invoke<BatchResult>("files_move", { items, copy }),
  mkdir: (path: string) => invoke<string>("files_mkdir", { path }),
  trash: (paths: string[]) => invoke<BatchResult>("files_trash", { paths }),
};

// ---------------------------------------------------------------------------
// Paths (Windows-style, but tolerant of forward slashes)

const SEP = /[\\/]/;
export const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(SEP).pop() ?? p;
export const dirName = (p: string) => {
  const t = p.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("\\"), t.lastIndexOf("/"));
  return i > 0 ? t.slice(0, i) : t;
};
export const joinPath = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, "")}${dir.includes("/") && !dir.includes("\\") ? "/" : "\\"}${name}`;

// ---------------------------------------------------------------------------
// Describing

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

const day = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function describeEntries(entries: FileEntry[], base = ""): string {
  return entries
    .map((e) => {
      const shown = base && e.path.startsWith(base) ? e.path.slice(base.length).replace(/^[\\/]/, "") : e.path;
      return e.dir ? `${shown}\\ (folder)` : `${shown} (${formatSize(e.size)}, ${day(e.modified)})`;
    })
    .join("\n");
}

export function describeBatch(r: BatchResult, verb: string): string {
  const parts: string[] = [];
  if (r.done.length) parts.push(`${verb} ${r.done.length} item${r.done.length === 1 ? "" : "s"}${r.done.length <= 8 ? `: ${r.done.map((d) => `${baseName(d.from)} → ${d.to}`).join("; ")}` : ""}`);
  if (r.failed.length) parts.push(`${r.failed.length} didn't work: ${r.failed.slice(0, 8).map((f) => `${baseName(f.from)} (${f.error})`).join("; ")}`);
  return parts.join(". ") || "Nothing to do.";
}

// ---------------------------------------------------------------------------
// Tidying a folder

const KINDS: Array<[string, RegExp]> = [
  ["Images", /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|svg|ico|raw|psd)$/i],
  ["Videos", /\.(mp4|mkv|mov|avi|wmv|webm|flv|m4v)$/i],
  ["Music", /\.(mp3|wav|flac|aac|ogg|m4a|wma|opus)$/i],
  ["Documents", /\.(pdf|docx?|odt|rtf|txt|md|epub)$/i],
  ["Spreadsheets", /\.(xlsx?|ods|csv|tsv)$/i],
  ["Presentations", /\.(pptx?|odp|key)$/i],
  ["Archives", /\.(zip|rar|7z|tar|gz|bz2|xz|iso)$/i],
  ["Installers", /\.(exe|msi|msix|appx|appxbundle)$/i],
  ["Code", /\.(js|ts|tsx|py|rs|java|c|cpp|cs|go|json|ya?ml|html|css|sh|ps1|bat)$/i],
  ["Fonts", /\.(ttf|otf|woff2?)$/i],
  ["3D and design", /\.(stl|obj|fbx|blend|3mf|gcode|fig|ai|xd)$/i],
];

export const kindOf = (name: string) => KINDS.find(([, re]) => re.test(name))?.[0] ?? "Other";

export type TidyBy = "type" | "month";

export interface TidyPlan {
  moves: FileMove[];
  /** Folder name → how many files go there. */
  groups: Record<string, number>;
}

/** Pure: sort the loose files directly in `folder` into subfolders. */
export function tidyPlan(folder: string, entries: FileEntry[], by: TidyBy): TidyPlan {
  const groups: Record<string, number> = {};
  const moves: FileMove[] = [];
  for (const e of entries) {
    if (e.dir) continue;
    // Half-downloaded files belong where the browser left them.
    if (/\.(crdownload|part|partial|tmp|download)$/i.test(e.name)) continue;
    const group =
      by === "month"
        ? new Date(e.modified).toLocaleDateString("en-GB", { month: "long", year: "numeric" })
        : kindOf(e.name);
    groups[group] = (groups[group] ?? 0) + 1;
    moves.push({ from: e.path, to: joinPath(folder, group) });
  }
  return { moves, groups };
}

export function describePlan(folder: string, plan: TidyPlan): string {
  const g = Object.entries(plan.groups)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  return `Sort ${plan.moves.length} file${plan.moves.length === 1 ? "" : "s"} in ${baseName(folder)} into ${Object.keys(plan.groups).length} folder${Object.keys(plan.groups).length === 1 ? "" : "s"} (${g})`;
}

// ---------------------------------------------------------------------------
// Undo

export interface FileChange {
  kind: "move" | "copy";
  items: FileMove[];
  at: number;
  summary: string;
}

const history: FileChange[] = [];
const MAX_HISTORY = 10;

export function recordChange(change: FileChange) {
  if (!change.items.length) return;
  history.push(change);
  while (history.length > MAX_HISTORY) history.shift();
}

export const lastChange = (): FileChange | undefined => history[history.length - 1];

/** Pure: how to reverse a change. Moves go back; copies go to the Recycle Bin. */
export function reversal(change: FileChange): { moveBack: FileMove[]; bin: string[] } {
  if (change.kind === "copy") return { moveBack: [], bin: change.items.map((i) => i.to) };
  return { moveBack: [...change.items].reverse().map((i) => ({ from: i.to, to: i.from })), bin: [] };
}

/** Reverse the most recent change. */
export async function undoLast(): Promise<string> {
  const change = history.pop();
  if (!change) return "There's nothing to undo: BEV hasn't moved or copied any files since it started.";
  const { moveBack, bin } = reversal(change);
  const r = moveBack.length ? await filesApi.move(moveBack) : await filesApi.trash(bin);
  // A failed move back may have landed under a "(2)" name: report, don't hide it.
  return `Undid "${change.summary}". ${describeBatch(r, moveBack.length ? "Put back" : "Sent to the Recycle Bin")}`;
}

/** Tests only. */
export const _resetHistory = () => {
  history.length = 0;
};
