/**
 * Screen time: how long each app was in front while you were actually at the
 * PC (no keyboard or mouse for 5 minutes = away, unless a game or video is
 * full screen). Counted every 15 seconds, kept 60 days, on this PC only.
 */
import { invoke } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { native } from "./native";
import { useSettings } from "@/state/settings";
import { dayKey } from "@/ai/usage";
import { formatDuration } from "./timers";
import { setAway, awayNow } from "./alerts";
import { isQuiet } from "./gaming";

const TICK_S = 15;
const AWAY_S = 5 * 60;
const KEEP_DAYS = 60;

/** day "YYYY-MM-DD" → app → seconds */
export type ScreenDays = Record<string, Record<string, number>>;

// ---------------------------------------------------------------------------
// Pure (tested)

export const appLabel = (process: string) => {
  const n = process.replace(/\.exe$/i, "");
  const known: Record<string, string> = { chrome: "Chrome", msedge: "Edge", firefox: "Firefox", explorer: "File Explorer", code: "VS Code", "applicationframehost": "Windows apps", steamwebhelper: "Steam", obs64: "OBS", winword: "Word", excel: "Excel", powerpnt: "PowerPoint" };
  return known[n.toLowerCase()] ?? n.charAt(0).toUpperCase() + n.slice(1);
};

/** Count one tick, unless the user is away (and nothing full-screen is on). */
export function addTick(days: ScreenDays, day: string, process: string | null, idleS: number, fullscreen: boolean): ScreenDays {
  if (!process || (idleS >= AWAY_S && !fullscreen)) return days;
  const app = appLabel(process);
  const d = { ...(days[day] ?? {}) };
  d[app] = (d[app] ?? 0) + TICK_S;
  return { ...days, [day]: d };
}

export function pruneDays(days: ScreenDays, now: number): ScreenDays {
  const cutoff = dayKey(now - KEEP_DAYS * 86_400_000);
  return Object.fromEntries(Object.entries(days).filter(([d]) => d >= cutoff));
}

/** Seconds per app over some days, most first. */
export function sumApps(days: ScreenDays, keys: string[], app?: string): Array<[string, number]> {
  const out = new Map<string, number>();
  for (const k of keys) for (const [a, s] of Object.entries(days[k] ?? {})) if (!app || a.toLowerCase().includes(app.toLowerCase())) out.set(a, (out.get(a) ?? 0) + s);
  return [...out.entries()].sort((a, b) => b[1] - a[1]);
}

export function dayKeys(period: "today" | "yesterday" | "week", now: number): string[] {
  if (period === "today") return [dayKey(now)];
  if (period === "yesterday") return [dayKey(now - 86_400_000)];
  return Array.from({ length: 7 }, (_, i) => dayKey(now - i * 86_400_000));
}

// ---------------------------------------------------------------------------

let kv: Store | null = null;
const store = async () => (kv ??= await load("screentime.json", { autoSave: true }));

interface ScreenState {
  days: ScreenDays;
  loaded: boolean;
  load(): Promise<void>;
  clear(): Promise<void>;
}

export const useScreenTime = create<ScreenState>((set, get) => ({
  days: {},
  loaded: false,
  async load() {
    if (get().loaded) return;
    try {
      set({ days: pruneDays((await (await store()).get<ScreenDays>("days")) ?? {}, Date.now()), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  async clear() {
    set({ days: {} });
    await store()
      .then((s) => s.set("days", {}))
      .catch(() => {});
  },
}));

let ticks = 0;
let started = false;

export function startScreenTime() {
  if (started) return;
  started = true;
  void useScreenTime.getState().load();
  setInterval(async () => {
    if (!useScreenTime.getState().loaded) return;
    const [fg, idle, fs] = await Promise.all([
      native.foregroundWindow().catch(() => null),
      invoke<number>("idle_seconds").catch(() => 0),
      native.fullscreenState().catch(() => "none" as const),
    ]);
    // Away for 10 minutes, then back: a short catch-up on anything that went off meanwhile.
    void setAway(idle >= 600 && fs === "none" ? true : idle < 30 ? false : awayNow(), isQuiet());
    if (!useSettings.getState().settings.screenTime) return;
    const days = addTick(useScreenTime.getState().days, dayKey(), fg?.process ?? null, idle, fs !== "none");
    if (days === useScreenTime.getState().days) return;
    useScreenTime.setState({ days });
    // Save every minute, not every tick.
    if (++ticks % 4 === 0) {
      await store()
        .then((s) => s.set("days", pruneDays(days, Date.now())))
        .catch(() => {});
    }
  }, TICK_S * 1000);
}

export function describeScreenTime(period: "today" | "yesterday" | "week", app: string | undefined, now = Date.now()): string {
  const rows = sumApps(useScreenTime.getState().days, dayKeys(period, now), app);
  const when = { today: "today", yesterday: "yesterday", week: "in the last 7 days" }[period];
  if (!useSettings.getState().settings.screenTime) return "Screen time is switched off (Settings → General).";
  if (!rows.length) return `No screen time recorded ${when}${app ? ` for "${app}"` : ""}.`;
  const total = rows.reduce((n, [, s]) => n + s, 0);
  return `${formatDuration(total * 1000)} at the PC ${when}. ${rows.slice(0, 10).map(([a, s]) => `${a}: ${formatDuration(s * 1000)}`).join("; ")}.`;
}
