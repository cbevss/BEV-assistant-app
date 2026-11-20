/**
 * Play time: how long each game has been played, from gaming mode's game
 * detection. Sessions are saved (90 days), the current one every minute so
 * a crash doesn't lose it. Optional daily limit and one-off "after an hour
 * of playing" reminders.
 */
import { load, type Store } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { useGaming } from "./gaming";
import { useSettings } from "@/state/settings";
import { alertUser } from "./alerts";
import { formatDuration } from "./timers";

export interface Session {
  game: string;
  start: number;
  end: number;
}

const KEEP_MS = 90 * 86_400_000;
/** Sessions shorter than this (a launcher flash) aren't counted. */
const MIN_SESSION_MS = 60_000;
/** A gap this short joins two sessions of the same game (a crash and relaunch). */
const JOIN_MS = 3 * 60_000;

// ---------------------------------------------------------------------------
// Pure (tested)

export const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Start of the period: today, this week (from Monday), this month, all. */
export function periodStart(period: "today" | "week" | "month" | "all", now: number): number {
  if (period === "all") return 0;
  const d = new Date(startOfDay(now));
  if (period === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (period === "month") d.setDate(1);
  return d.getTime();
}

/** Add a finished session, joining it to the last one if it's the same game straight after. */
export function addSession(list: Session[], s: Session, now: number): Session[] {
  const kept = list.filter((x) => x.end > now - KEEP_MS);
  const last = kept[kept.length - 1];
  if (last && last.game === s.game && s.start - last.end < JOIN_MS) return [...kept.slice(0, -1), { ...last, end: s.end }];
  if (s.end - s.start < MIN_SESSION_MS) return kept;
  return [...kept, s];
}

export interface GameTotal {
  game: string;
  ms: number;
  sessions: number;
  longest: number;
  last: number;
}

/** Time per game since `from` (sessions crossing it are clipped), longest first. */
export function totalsSince(list: Session[], from: number, game?: string): GameTotal[] {
  const by = new Map<string, GameTotal>();
  for (const s of list) {
    if (s.end <= from) continue;
    if (game && !s.game.toLowerCase().includes(game.toLowerCase())) continue;
    const ms = s.end - Math.max(s.start, from);
    const t = by.get(s.game) ?? { game: s.game, ms: 0, sessions: 0, longest: 0, last: 0 };
    t.ms += ms;
    t.sessions += 1;
    t.longest = Math.max(t.longest, s.end - s.start);
    t.last = Math.max(t.last, s.end);
    by.set(s.game, t);
  }
  return [...by.values()].sort((a, b) => b.ms - a.ms);
}

/** Minutes played per day for the last `days` days (oldest first). */
export function perDay(list: Session[], days: number, now: number): number[] {
  const out: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const from = startOfDay(now) - i * 86_400_000;
    const to = from + 86_400_000;
    let ms = 0;
    for (const s of list) ms += Math.max(0, Math.min(s.end, to) - Math.max(s.start, from));
    out.push(Math.round(ms / 60_000));
  }
  return out;
}

// ---------------------------------------------------------------------------

let kv: Store | null = null;
const store = async () => (kv ??= await load("playtime.json", { autoSave: true }));

interface PlayState {
  sessions: Session[];
  /** The game being played now. */
  current: Session | null;
  /** One-off: tell me after this many minutes of the current (or next) session. */
  remindAfterMin: number | null;
  loaded: boolean;
  load(): Promise<void>;
  clear(): Promise<void>;
}

export const usePlaytime = create<PlayState>((set, get) => ({
  sessions: [],
  current: null,
  remindAfterMin: null,
  loaded: false,
  async load() {
    if (get().loaded) return;
    try {
      const s = await store();
      let sessions = (await s.get<Session[]>("sessions")) ?? [];
      // A session still open when BEV last closed ends at its last checkpoint.
      const open = await s.get<Session>("current");
      if (open) {
        sessions = addSession(sessions, open, Date.now());
        await s.set("current", null);
        await s.set("sessions", sessions);
      }
      set({ sessions, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  async clear() {
    set({ sessions: [] });
    await store()
      .then((s) => s.set("sessions", []))
      .catch(() => {});
  },
}));

/** Everything including the session in progress. */
export function allSessions(now = Date.now()): Session[] {
  const st = usePlaytime.getState();
  return st.current ? [...st.sessions, { ...st.current, end: now }] : st.sessions;
}

const limitTold = new Set<string>();

async function checkpoint() {
  const st = usePlaytime.getState();
  const now = Date.now();
  if (st.current) {
    const cur = { ...st.current, end: now };
    usePlaytime.setState({ current: cur });
    await store()
      .then((s) => s.set("current", cur))
      .catch(() => {});
    // "Remind me after an hour of playing"
    if (st.remindAfterMin && now - cur.start >= st.remindAfterMin * 60_000) {
      usePlaytime.setState({ remindAfterMin: null });
      await alertUser("Play time", `You've been playing ${cur.game} for ${formatDuration(now - cur.start)}.`, { speak: `You've been playing for ${formatDuration(now - cur.start)}.`, toolName: "playtime" });
    }
  }
  // Daily limit, told once a day.
  const limit = useSettings.getState().settings.playLimitMinutes;
  if (limit && st.current) {
    const today = totalsSince(allSessions(now), startOfDay(now)).reduce((n, t) => n + t.ms, 0);
    const key = new Date(now).toDateString();
    if (today >= limit * 60_000 && !limitTold.has(key)) {
      limitTold.add(key);
      await alertUser("Daily play limit", `You've played ${formatDuration(today)} today, over your ${formatDuration(limit * 60_000)} limit.`, { speak: `Heads up: that's ${formatDuration(today)} of gaming today, past your limit.`, toolName: "playtime" });
    }
  }
}

let started = false;

export function startPlaytime() {
  if (started) return;
  started = true;
  void usePlaytime.getState().load();
  useGaming.subscribe(async (g, prev) => {
    const now = Date.now();
    const st = usePlaytime.getState();
    const name = g.game?.name ?? null;
    const before = prev.game?.name ?? null;
    if (name === before) return;
    // The generic full-screen name gets upgraded to the Steam name mid-session: same session.
    if (name && before && st.current && before === "a full-screen game") {
      usePlaytime.setState({ current: { ...st.current, game: name } });
      return;
    }
    if (st.current) {
      const sessions = addSession(st.sessions, { ...st.current, end: now }, now);
      usePlaytime.setState({ sessions, current: null });
      await store()
        .then(async (s) => {
          await s.set("sessions", sessions);
          await s.set("current", null);
        })
        .catch(() => {});
    }
    if (name) usePlaytime.setState({ current: { game: name, start: g.game?.since ?? now, end: now } });
  });
  setInterval(() => void checkpoint(), 60_000);
}

/** For the AI: a period's play time in a sentence or two. */
export function describePlay(period: "today" | "week" | "month" | "all", game: string | undefined, now = Date.now()): string {
  const totals = totalsSince(allSessions(now), periodStart(period, now), game);
  const when = { today: "today", week: "this week", month: "this month", all: "in the last 90 days" }[period];
  const cur = usePlaytime.getState().current;
  const playing = cur ? ` Playing ${cur.game} right now (${formatDuration(now - cur.start)} so far).` : "";
  if (!totals.length) return `No games played ${when}${game ? ` matching "${game}"` : ""}.${playing}`;
  const sum = totals.reduce((n, t) => n + t.ms, 0);
  const rows = totals.slice(0, 8).map((t) => `${t.game}: ${formatDuration(t.ms)} over ${t.sessions} session${t.sessions === 1 ? "" : "s"}`);
  return `${formatDuration(sum)} played ${when}. ${rows.join("; ")}.${playing}`;
}
