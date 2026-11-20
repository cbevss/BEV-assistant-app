/**
 * "Tell me when…": one-off watches the user sets by asking BEV. Checked
 * every few seconds while BEV is open, only fetching what the active watches
 * need. Thresholds have to hold for a little while before they count, so a
 * blip doesn't set them off. Each watch expires after a day unless it fires.
 */
import { load, type Store } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { native } from "./native";
import { gpuApi, useGaming } from "./gaming";
import { filesApi } from "./files";
import { alertUser } from "./alerts";

export type WatchKind =
  | "app_closes"
  | "app_opens"
  | "download_done"
  | "game_ends"
  | "game_starts"
  | "cpu_below"
  | "cpu_above"
  | "gpu_below"
  | "gpu_temp_above"
  | "ram_above"
  | "disk_free_below"
  | "internet_back"
  | "internet_down";

export const WATCH_KINDS: Record<WatchKind, string> = {
  app_closes: "an app closes (app)",
  app_opens: "an app starts (app)",
  download_done: "downloads in the Downloads folder finish",
  game_ends: "the current game is closed",
  game_starts: "a game starts",
  cpu_below: "CPU use drops below value % (e.g. a render or install finishing)",
  cpu_above: "CPU use goes over value %",
  gpu_below: "GPU use drops below value %",
  gpu_temp_above: "GPU temperature goes over value °C",
  ram_above: "memory use goes over value %",
  disk_free_below: "free space on any drive drops below value GB",
  internet_back: "the internet comes back",
  internet_down: "the internet drops",
};

export interface Watch {
  id: string;
  kind: WatchKind;
  app?: string;
  value?: number;
  /** What to say when it happens (the user's words, if they gave any). */
  message?: string;
  created: number;
  expires: number;
}

/** One look at the PC, with only the fields active watches asked for. */
export interface Sample {
  apps?: string[];
  downloadsInProgress?: number;
  game?: string | null;
  cpu?: number;
  gpu?: number | null;
  gpuTemp?: number | null;
  ram?: number;
  minDiskFreeGb?: { mount: string; free: number } | null;
  online?: boolean;
}

/** How many looks in a row a threshold must hold (looks are 5 s apart). */
const HOLD: Partial<Record<WatchKind, number>> = { cpu_below: 4, gpu_below: 4, cpu_above: 3, ram_above: 3, gpu_temp_above: 2, internet_down: 3, internet_back: 1 };

const appName = (a: string) => a.toLowerCase().replace(/\.exe$/, "").trim();
const hasApp = (apps: string[], want: string) => {
  const w = appName(want);
  return apps.some((a) => {
    const n = appName(a);
    return n === w || n.includes(w) || (w.length > 3 && w.includes(n) && n.length > 3);
  });
};

/**
 * Pure: is the condition true in this sample? `base` is the first sample
 * after the watch was set, for "changes" like an app closing. Undefined
 * when the sample can't tell.
 */
export function holds(w: Watch, s: Sample, base: Sample | undefined): boolean | undefined {
  switch (w.kind) {
    case "app_closes":
      return s.apps && w.app ? !hasApp(s.apps, w.app) : undefined;
    case "app_opens":
      return s.apps && w.app ? hasApp(s.apps, w.app) : undefined;
    case "download_done":
      // Done once something was downloading and nothing is now.
      if (s.downloadsInProgress === undefined) return undefined;
      return (base?.downloadsInProgress ?? 0) > 0 || w.value === 1 ? s.downloadsInProgress === 0 : undefined;
    case "game_ends":
      return s.game === undefined ? undefined : s.game === null;
    case "game_starts":
      return s.game === undefined ? undefined : s.game !== null;
    case "cpu_below":
      return s.cpu === undefined ? undefined : s.cpu < (w.value ?? 15);
    case "cpu_above":
      return s.cpu === undefined ? undefined : s.cpu > (w.value ?? 90);
    case "gpu_below":
      return s.gpu == null ? undefined : s.gpu < (w.value ?? 15);
    case "gpu_temp_above":
      return s.gpuTemp == null ? undefined : s.gpuTemp > (w.value ?? 85);
    case "ram_above":
      return s.ram === undefined ? undefined : s.ram > (w.value ?? 90);
    case "disk_free_below":
      return s.minDiskFreeGb == null ? undefined : s.minDiskFreeGb.free < (w.value ?? 10);
    case "internet_back":
      return s.online === undefined ? undefined : s.online;
    case "internet_down":
      return s.online === undefined ? undefined : !s.online;
  }
}

/** Pure: what to fetch for these watches. */
export function needs(ws: Watch[]) {
  const k = new Set(ws.map((w) => w.kind));
  return {
    apps: k.has("app_closes") || k.has("app_opens"),
    downloads: k.has("download_done"),
    game: k.has("game_ends") || k.has("game_starts"),
    stats: k.has("cpu_below") || k.has("cpu_above") || k.has("ram_above"),
    gpu: k.has("gpu_below") || k.has("gpu_temp_above"),
    disks: k.has("disk_free_below"),
    net: k.has("internet_back") || k.has("internet_down"),
  };
}

/** Pure: a one-line description of a watch. */
export function describeWatch(w: Watch): string {
  const v = w.value;
  const what: Record<WatchKind, string> = {
    app_closes: `${w.app} closes`,
    app_opens: `${w.app} starts`,
    download_done: "your downloads finish",
    game_ends: "you stop playing",
    game_starts: "a game starts",
    cpu_below: `CPU use drops below ${v ?? 15}%`,
    cpu_above: `CPU use goes over ${v ?? 90}%`,
    gpu_below: `GPU use drops below ${v ?? 15}%`,
    gpu_temp_above: `the GPU goes over ${v ?? 85}°C`,
    ram_above: `memory use goes over ${v ?? 90}%`,
    disk_free_below: `a drive gets below ${v ?? 10} GB free`,
    internet_back: "the internet comes back",
    internet_down: "the internet drops",
  };
  return `when ${what[w.kind]}`;
}

/** Pure: what was seen, for the alert. */
export function happened(w: Watch, s: Sample): string {
  switch (w.kind) {
    case "app_closes":
      return `${w.app} has closed.`;
    case "app_opens":
      return `${w.app} has started.`;
    case "download_done":
      return "Your downloads have finished.";
    case "game_ends":
      return "Your game has closed.";
    case "game_starts":
      return `${s.game ?? "A game"} has started.`;
    case "cpu_below":
      return `CPU use is down to ${Math.round(s.cpu ?? 0)}%.`;
    case "cpu_above":
      return `CPU use is up at ${Math.round(s.cpu ?? 0)}%.`;
    case "gpu_below":
      return `GPU use is down to ${Math.round(s.gpu ?? 0)}%.`;
    case "gpu_temp_above":
      return `The GPU is at ${Math.round(s.gpuTemp ?? 0)}°C.`;
    case "ram_above":
      return `Memory use is at ${Math.round(s.ram ?? 0)}%.`;
    case "disk_free_below":
      return `${s.minDiskFreeGb?.mount ?? "A drive"} has ${s.minDiskFreeGb?.free.toFixed(1)} GB free.`;
    case "internet_back":
      return "The internet is back.";
    case "internet_down":
      return "The internet has dropped.";
  }
}

// ---------------------------------------------------------------------------

const DOWNLOADING = /\.(crdownload|part|partial|download|opdownload|!ut|tmp)$/i;

async function sample(ws: Watch[]): Promise<Sample> {
  const n = needs(ws);
  const s: Sample = {};
  const jobs: Promise<unknown>[] = [];
  if (n.apps)
    jobs.push(
      native
        .listProcesses()
        .then((ps) => (s.apps = [...new Set(ps.map((p) => p.name))]))
        .catch(() => {}),
    );
  if (n.downloads)
    jobs.push(
      filesApi
        .list("%USERPROFILE%\\Downloads")
        .then((r) => (s.downloadsInProgress = r.entries.filter((e) => !e.dir && DOWNLOADING.test(e.name)).length))
        .catch(() => {}),
    );
  if (n.game) s.game = useGaming.getState().game?.name ?? null;
  if (n.stats || n.disks)
    jobs.push(
      native
        .diagSystem()
        .then((f) => {
          s.cpu = f.cpu;
          s.ram = f.mem_total_mb ? (100 * f.mem_used_mb) / f.mem_total_mb : undefined;
          const d = [...f.disks].filter((x) => x.total_gb > 1).sort((a, b) => a.free_gb - b.free_gb)[0];
          s.minDiskFreeGb = d ? { mount: d.mount, free: d.free_gb } : null;
        })
        .catch(() => {}),
    );
  if (n.gpu)
    jobs.push(
      gpuApi
        .stats()
        .then((g) => {
          s.gpu = g.usage;
          s.gpuTemp = g.hotspot_c ?? g.temp_c;
        })
        .catch(() => {}),
    );
  if (n.net)
    jobs.push(
      native
        .diagNetwork()
        .then((f) => (s.online = f.dns.ok || f.direct.some(([, p]) => p.ok)))
        .catch(() => {}),
    );
  await Promise.all(jobs);
  return s;
}

let kv: Store | null = null;
const store = async () => (kv ??= await load("watches.json", { autoSave: true }));

interface WatchState {
  watches: Watch[];
  loaded: boolean;
  load(): Promise<void>;
  add(w: Omit<Watch, "id" | "created" | "expires"> & { hours?: number }): Promise<Watch>;
  remove(ids: string[]): Promise<void>;
}

export const useWatches = create<WatchState>((set, get) => ({
  watches: [],
  loaded: false,
  async load() {
    if (get().loaded) return;
    try {
      const all = (await (await store()).get<Watch[]>("watches")) ?? [];
      set({ watches: all.filter((w) => w.expires > Date.now()), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  async add({ hours, ...w }) {
    const now = Date.now();
    const watch: Watch = { ...w, id: Math.random().toString(36).slice(2, 7), created: now, expires: now + Math.min(Math.max(hours ?? 24, 0.1), 24 * 7) * 3600_000 };
    const watches = [...get().watches, watch];
    set({ watches });
    await save(watches);
    return watch;
  },
  async remove(ids) {
    const watches = get().watches.filter((w) => !ids.includes(w.id));
    set({ watches });
    await save(watches);
  },
}));

async function save(ws: Watch[]) {
  await store()
    .then((s) => s.set("watches", ws))
    .catch(() => {});
}

const bases = new Map<string, Sample>();
const streaks = new Map<string, number>();

/** Pure-ish step: which watches fire on this sample (updates streaks/bases). */
export function step(ws: Watch[], s: Sample, baseMap: Map<string, Sample>, streakMap: Map<string, number>): Watch[] {
  const fired: Watch[] = [];
  for (const w of ws) {
    if (!baseMap.has(w.id)) {
      baseMap.set(w.id, s);
      // "Tell me when Steam closes" while it's already closed: wait for it to open and close.
      if (w.kind === "app_closes" && holds(w, s, s) === true) continue;
      if (w.kind === "game_ends" && s.game === null) continue;
    }
    const base = baseMap.get(w.id);
    if (w.kind === "app_closes" && base && holds(w, base, base) === true) {
      // It was closed when set: re-base once it's seen running.
      if (holds(w, s, base) === false) baseMap.set(w.id, s);
      continue;
    }
    if (w.kind === "game_ends" && base?.game === null) {
      if (s.game) baseMap.set(w.id, s);
      continue;
    }
    if (w.kind === "download_done" && (base?.downloadsInProgress ?? 0) === 0 && (s.downloadsInProgress ?? 0) > 0) baseMap.set(w.id, s);
    const ok = holds(w, s, baseMap.get(w.id));
    const n = ok ? (streakMap.get(w.id) ?? 0) + 1 : 0;
    streakMap.set(w.id, n);
    if (n >= (HOLD[w.kind] ?? 1)) fired.push(w);
  }
  return fired;
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

export function startWatches() {
  if (timer) return;
  void useWatches.getState().load();
  timer = setInterval(async () => {
    const st = useWatches.getState();
    if (busy || !st.loaded) return;
    const now = Date.now();
    const expired = st.watches.filter((w) => w.expires <= now);
    if (expired.length) await st.remove(expired.map((w) => w.id));
    const live = useWatches.getState().watches;
    if (!live.length) return;
    busy = true;
    try {
      const s = await sample(live);
      const fired = step(live, s, bases, streaks);
      if (fired.length) {
        await useWatches.getState().remove(fired.map((w) => w.id));
        for (const w of fired) {
          bases.delete(w.id);
          streaks.delete(w.id);
          const text = happened(w, s);
          await alertUser(w.message ? w.message : text.replace(/\.$/, ""), w.message ? text : "", { speak: w.message ? `${w.message}. ${text}` : text, toolName: "watch_done" });
        }
      }
    } finally {
      busy = false;
    }
  }, 5000);
}
