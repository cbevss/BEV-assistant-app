/**
 * Timers, alarms, reminders and a stopwatch that run on this PC (no cloud
 * needed). Saved, so ones that came due while BEV was closed are announced
 * as missed when it opens.
 */
import { load, type Store } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { alertUser } from "./alerts";
import { useSettings } from "@/state/settings";

/** "Sir, " / "Charlie, " / "" from Settings → Call me. */
export const salute = (addressAs: string) => (addressAs.trim() ? `${addressAs.trim().charAt(0).toUpperCase()}${addressAs.trim().slice(1)}, ` : "");

export type TimerKind = "timer" | "alarm" | "reminder";
export type Repeat = "daily" | "weekdays" | "weekends";

export interface Timer {
  id: string;
  kind: TimerKind;
  label: string;
  /** When it goes off, ms since 1970. */
  due: number;
  created: number;
  /** For timers: the length asked for, to say "your 10 minute timer". */
  durationMs?: number;
  repeat?: Repeat;
  /** Repeats every this many minutes (reminders), until `until` if set. */
  everyMin?: number;
  until?: number;
}

export interface Stopwatch {
  /** Running since (ms), or null when stopped. */
  since: number | null;
  /** Time counted before the current run. */
  before: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (tested)

/** "HH:MM" (24h or with am/pm) → the next time that clock time comes round. */
export function nextClock(text: string, now: number): number | null {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap === "pm" ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** When something is due, from an exact time ("YYYY-MM-DDTHH:MM" or "HH:MM") or a delay. */
export function dueFrom(a: { at?: unknown; hours?: unknown; minutes?: unknown; seconds?: unknown }, now: number): number | null {
  if (typeof a.at === "string" && a.at.trim()) {
    const s = a.at.trim();
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(s)) {
      const t = new Date(s.replace(" ", "T")).getTime();
      return Number.isFinite(t) && t > now ? t : null;
    }
    return nextClock(s, now);
  }
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const ms = (n(a.hours) * 3600 + n(a.minutes) * 60 + n(a.seconds)) * 1000;
  return ms >= 1000 && ms <= 7 * 86_400_000 ? now + Math.round(ms) : null;
}

/** The next day a repeating alarm goes off after `from`. */
export function nextRepeat(due: number, repeat: Repeat): number {
  const d = new Date(due);
  for (let i = 0; i < 8; i++) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (repeat === "daily" || (repeat === "weekdays" && day >= 1 && day <= 5) || (repeat === "weekends" && (day === 0 || day === 6))) return d.getTime();
  }
  return d.getTime();
}

/** "1 h 5 min", "4 min 10 s", "45 s" */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h} h${m ? ` ${m} min` : ""}`;
  if (m) return `${m} min${sec && m < 10 ? ` ${sec} s` : ""}`;
  return `${sec} s`;
}

/** "04:59" or "1:04:59" for a countdown. */
export function clockDown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const clockTime = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

export function describeTimer(t: Timer, now: number): string {
  const left = formatDuration(t.due - now);
  const label = t.label ? ` “${t.label}”` : "";
  if (t.kind === "timer") return `${t.durationMs ? `${formatDuration(t.durationMs)} timer` : "Timer"}${label}: ${left} left (id ${t.id})`;
  const when = new Date(t.due).toDateString() === new Date(now).toDateString() ? clockTime(t.due) : `${new Date(t.due).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${clockTime(t.due)}`;
  const every = t.everyMin ? `, then every ${formatDuration(t.everyMin * 60_000)}${t.until ? ` until ${clockTime(t.until)}` : ""}` : "";
  return `${t.kind === "alarm" ? "Alarm" : "Reminder"}${label} at ${when}${t.repeat ? ` (${t.repeat})` : ""}${every}, in ${left} (id ${t.id})`;
}

/** Pure: which timers match "the pasta timer", an id, or "all". */
export function matchTimers(timers: Timer[], which: string): Timer[] {
  const w = which.trim().toLowerCase();
  if (!w || w === "all") return timers;
  const byId = timers.filter((t) => t.id === w);
  if (byId.length) return byId;
  const kind = timers.filter((t) => w === `${t.kind}s` || w === t.kind || w === `the ${t.kind}` || w === `my ${t.kind}`);
  if (kind.length) return kind;
  return timers.filter((t) => t.label && (t.label.toLowerCase().includes(w) || w.includes(t.label.toLowerCase())));
}

// ---------------------------------------------------------------------------
// Store and clock

let kv: Store | null = null;
const store = async () => (kv ??= await load("timers.json", { autoSave: true }));

interface TimersState {
  timers: Timer[];
  stopwatch: Stopwatch;
  /** The last alarm/timer that went off, for "snooze". */
  lastFired: Timer | null;
  loaded: boolean;
  load(): Promise<void>;
  add(t: Omit<Timer, "id" | "created">): Promise<Timer>;
  cancel(ids: string[]): Promise<void>;
  setStopwatch(s: Stopwatch): Promise<void>;
}

const newId = () => Math.random().toString(36).slice(2, 7);

export const useTimers = create<TimersState>((set, get) => ({
  timers: [],
  stopwatch: { since: null, before: 0 },
  lastFired: null,
  loaded: false,
  async load() {
    if (get().loaded) return;
    try {
      const s = await store();
      set({ timers: (await s.get<Timer[]>("timers")) ?? [], stopwatch: (await s.get<Stopwatch>("stopwatch")) ?? { since: null, before: 0 }, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  async add(t) {
    const timer: Timer = { ...t, id: newId(), created: Date.now() };
    const timers = [...get().timers, timer].sort((a, b) => a.due - b.due);
    set({ timers });
    await persist(timers);
    return timer;
  },
  async cancel(ids) {
    const timers = get().timers.filter((t) => !ids.includes(t.id));
    set({ timers });
    await persist(timers);
  },
  async setStopwatch(stopwatch) {
    set({ stopwatch });
    await store()
      .then((s) => s.set("stopwatch", stopwatch))
      .catch(() => {});
  },
}));

async function persist(timers: Timer[]) {
  await store()
    .then((s) => s.set("timers", timers))
    .catch(() => {});
}

async function fire(t: Timer, now: number) {
  const hi = salute(useSettings.getState().settings.addressAs);
  const late = now - t.due > 90_000;
  const lateNote = late ? ` (it was due at ${clockTime(t.due)}, while BEV was closed)` : "";
  if (t.kind === "timer") {
    const what = t.label ? `Your ${t.label} timer` : t.durationMs ? `Your ${formatDuration(t.durationMs)} timer` : "Your timer";
    await alertUser("Timer done", `${t.label || formatDuration(t.durationMs ?? 0)}${lateNote}`, { speak: late ? undefined : `${hi}${hi ? what.charAt(0).toLowerCase() + what.slice(1) : what} is done.`, toolName: "timer_done" });
  } else if (t.kind === "alarm") {
    await alertUser("Alarm", `${t.label || clockTime(t.due)}${lateNote}`, { speak: late ? undefined : `${hi}${hi ? "it's" : "It's"} ${clockTime(t.due)}.${t.label ? ` ${t.label}.` : ""}`, toolName: "timer_done" });
  } else {
    await alertUser("Reminder", `${t.label}${lateNote}`, { speak: late ? undefined : `${hi}${hi ? "a" : "A"} reminder: ${t.label}`, toolName: "timer_done" });
  }
}

/** Pure: split timers into those due now and the rest (repeats moved on). */
export function dueNow(timers: Timer[], now: number): { fire: Timer[]; keep: Timer[] } {
  const fireList: Timer[] = [];
  const keep: Timer[] = [];
  for (const t of timers) {
    if (t.due > now) {
      keep.push(t);
      continue;
    }
    fireList.push(t);
    if (t.everyMin) {
      let due = t.due + t.everyMin * 60_000;
      while (due <= now) due += t.everyMin * 60_000;
      if (!t.until || due <= t.until) keep.push({ ...t, due });
    } else if (t.repeat) {
      let due = nextRepeat(t.due, t.repeat);
      while (due <= now) due = nextRepeat(due, t.repeat);
      keep.push({ ...t, due });
    }
  }
  return { fire: fireList, keep: keep.sort((a, b) => a.due - b.due) };
}

let ticking: ReturnType<typeof setInterval> | null = null;

export function startTimers() {
  if (ticking) return;
  void useTimers.getState().load();
  ticking = setInterval(async () => {
    const st = useTimers.getState();
    if (!st.loaded) return;
    const now = Date.now();
    const { fire: f, keep } = dueNow(st.timers, now);
    if (!f.length) return;
    useTimers.setState({ timers: keep, lastFired: f[f.length - 1] });
    await persist(keep);
    // Long-missed one-off reminders are summed up rather than read out one by one.
    for (const t of f.slice(-5)) await fire(t, now);
    if (f.length > 5) await alertUser("Missed while BEV was closed", `${f.length - 5} more timers and reminders`, { toolName: "timer_done" });
  }, 1000);
}
