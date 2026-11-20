/**
 * Window snapping and saved window layouts ("put Discord on my second
 * monitor", "snap Chrome to the left", "save this as my streaming layout",
 * "restore my streaming layout").
 */
import { invoke } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";
import { create } from "zustand";

export interface Placement {
  hwnd: number;
  process: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  state: "normal" | "maximized" | "minimized";
}
export interface WorkArea {
  x: number;
  y: number;
  w: number;
  h: number;
  primary: boolean;
}
export type Position = "left" | "right" | "top" | "bottom" | "full" | "centre" | "top_left" | "top_right" | "bottom_left" | "bottom_right";
export const POSITIONS: Position[] = ["left", "right", "top", "bottom", "full", "centre", "top_left", "top_right", "bottom_left", "bottom_right"];

export const layoutApi = {
  placements: () => invoke<Placement[]>("window_placements"),
  place: (hwnd: number, r: { x: number; y: number; w: number; h: number }, state: Placement["state"] = "normal") => invoke<void>("place_window", { hwnd, x: r.x, y: r.y, w: r.w, h: r.h, state }),
  workAreas: () => invoke<WorkArea[]>("monitor_work_areas"),
};

// ---------------------------------------------------------------------------
// Pure (tested)

/** Monitor 1 is the main one, then left to right. */
export const orderMonitors = (areas: WorkArea[]) => [...areas].sort((a, b) => Number(b.primary) - Number(a.primary) || a.x - b.x || a.y - b.y);

/** The monitor a rectangle is mostly on (by its centre). */
export function monitorOf(r: { x: number; y: number; w: number; h: number }, areas: WorkArea[]): number {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const ordered = orderMonitors(areas);
  const i = ordered.findIndex((a) => cx >= a.x && cx < a.x + a.w && cy >= a.y && cy < a.y + a.h);
  return i < 0 ? 0 : i;
}

export function snapRect(a: WorkArea, p: Position): { x: number; y: number; w: number; h: number } {
  const hw = Math.round(a.w / 2);
  const hh = Math.round(a.h / 2);
  switch (p) {
    case "left":
      return { x: a.x, y: a.y, w: hw, h: a.h };
    case "right":
      return { x: a.x + hw, y: a.y, w: a.w - hw, h: a.h };
    case "top":
      return { x: a.x, y: a.y, w: a.w, h: hh };
    case "bottom":
      return { x: a.x, y: a.y + hh, w: a.w, h: a.h - hh };
    case "top_left":
      return { x: a.x, y: a.y, w: hw, h: hh };
    case "top_right":
      return { x: a.x + hw, y: a.y, w: a.w - hw, h: hh };
    case "bottom_left":
      return { x: a.x, y: a.y + hh, w: hw, h: a.h - hh };
    case "bottom_right":
      return { x: a.x + hw, y: a.y + hh, w: a.w - hw, h: a.h - hh };
    case "centre": {
      const w = Math.round(a.w * 0.6);
      const h = Math.round(a.h * 0.7);
      return { x: a.x + Math.round((a.w - w) / 2), y: a.y + Math.round((a.h - h) / 2), w, h };
    }
    case "full":
      return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
}

/** Move a rectangle to another monitor, keeping its relative spot and size (fitted). */
export function moveToMonitor(r: { x: number; y: number; w: number; h: number }, from: WorkArea, to: WorkArea) {
  const w = Math.min(r.w, to.w);
  const h = Math.min(r.h, to.h);
  const fx = from.w > r.w ? (r.x - from.x) / (from.w - r.w) : 0;
  const fy = from.h > r.h ? (r.y - from.y) / (from.h - r.h) : 0;
  return { x: to.x + Math.round(Math.max(0, Math.min(1, fx)) * (to.w - w)), y: to.y + Math.round(Math.max(0, Math.min(1, fy)) * (to.h - h)), w, h };
}

const exe = (p: string) => p.toLowerCase().replace(/\.exe$/, "");

/** Windows matching "chrome", "Discord", "spotify.exe" or part of a title. */
export function findWindows(ps: Placement[], app: string): Placement[] {
  const w = exe(app.trim());
  if (!w) return [];
  const byProc = ps.filter((p) => exe(p.process) === w);
  if (byProc.length) return byProc;
  const partial = ps.filter((p) => exe(p.process).includes(w) || w.includes(exe(p.process)));
  if (partial.length) return partial;
  return ps.filter((p) => p.title.toLowerCase().includes(w));
}

export interface SavedWindow {
  process: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  state: Placement["state"];
}
export interface Layout {
  name: string;
  windows: SavedWindow[];
  savedAt: number;
}

/** Words shared between two titles, to tell two Chrome windows apart. */
const overlap = (a: string, b: string) => {
  const wa = new Set(a.toLowerCase().split(/\W+/).filter((x) => x.length > 2));
  return b.toLowerCase().split(/\W+/).filter((x) => wa.has(x)).length;
};

/** Pure: which open window goes where. Each window is used once. */
export function planRestore(layout: Layout, open: Placement[]): { moves: Array<{ hwnd: number; to: SavedWindow }>; missing: string[] } {
  const used = new Set<number>();
  const moves: Array<{ hwnd: number; to: SavedWindow }> = [];
  const missing: string[] = [];
  for (const s of layout.windows) {
    const cands = open.filter((p) => !used.has(p.hwnd) && exe(p.process) === exe(s.process)).sort((a, b) => overlap(s.title, b.title) - overlap(s.title, a.title));
    if (!cands.length) {
      missing.push(s.process.replace(/\.exe$/i, ""));
      continue;
    }
    used.add(cands[0].hwnd);
    moves.push({ hwnd: cands[0].hwnd, to: s });
  }
  return { moves, missing: [...new Set(missing)] };
}

// ---------------------------------------------------------------------------

let kv: Store | null = null;
const store = async () => (kv ??= await load("layouts.json", { autoSave: true }));

interface LayoutState {
  layouts: Layout[];
  loaded: boolean;
  load(): Promise<void>;
  save(name: string): Promise<Layout>;
  remove(name: string): Promise<void>;
  restore(name: string): Promise<string>;
}

const findLayout = (ls: Layout[], name: string) => {
  const n = name.trim().toLowerCase().replace(/\s*layout$/, "");
  return ls.find((l) => l.name.toLowerCase() === n) ?? ls.find((l) => l.name.toLowerCase().includes(n) || n.includes(l.name.toLowerCase()));
};

export const useLayouts = create<LayoutState>((set, get) => ({
  layouts: [],
  loaded: false,
  async load() {
    if (get().loaded) return;
    try {
      set({ layouts: (await (await store()).get<Layout[]>("layouts")) ?? [], loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  async save(name) {
    await get().load();
    const clean = name.trim().replace(/\s*layout$/i, "") || "My layout";
    const windows = (await layoutApi.placements()).filter((p) => p.state !== "minimized").map(({ process, title, x, y, w, h, state }) => ({ process, title, x, y, w, h, state }));
    if (!windows.length) throw new Error("there are no open windows to save");
    const layout: Layout = { name: clean, windows, savedAt: Date.now() };
    const layouts = [...get().layouts.filter((l) => l.name.toLowerCase() !== clean.toLowerCase()), layout];
    set({ layouts });
    await (await store()).set("layouts", layouts);
    return layout;
  },
  async remove(name) {
    const l = findLayout(get().layouts, name);
    if (!l) return;
    const layouts = get().layouts.filter((x) => x !== l);
    set({ layouts });
    await store()
      .then((s) => s.set("layouts", layouts))
      .catch(() => {});
  },
  async restore(name) {
    await get().load();
    const l = findLayout(get().layouts, name);
    if (!l) throw new Error(`no layout called "${name}"${get().layouts.length ? `; saved: ${get().layouts.map((x) => x.name).join(", ")}` : ""}`);
    const { moves, missing } = planRestore(l, await layoutApi.placements());
    let moved = 0;
    for (const m of moves) {
      try {
        await layoutApi.place(m.hwnd, m.to, m.to.state);
        moved++;
      } catch {
        /* closed meanwhile */
      }
    }
    return `Restored "${l.name}": moved ${moved} window${moved === 1 ? "" : "s"}.${missing.length ? ` Not open: ${missing.join(", ")} (open them and restore again).` : ""}`;
  },
}));
