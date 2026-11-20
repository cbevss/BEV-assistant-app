/** Countdowns to dates you care about ("days until my holiday"). */
import { load, type Store } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { startOfDay } from "./playtime";

export interface Countdown {
  name: string;
  /** "YYYY-MM-DD" */
  date: string;
  /** Comes round again every year (birthdays, Christmas). */
  yearly?: boolean;
}

/** Pure: the next occurrence (yearly ones roll over) as ms at local midnight. */
export function nextDate(c: Countdown, now: number): number {
  const [y, m, d] = c.date.split("-").map(Number);
  let t = new Date(y, m - 1, d).getTime();
  if (c.yearly) {
    const today = startOfDay(now);
    let yy = new Date(now).getFullYear();
    t = new Date(yy, m - 1, d).getTime();
    while (t < today) t = new Date(++yy, m - 1, d).getTime();
  }
  return t;
}

/** Pure: whole days from today (0 = today, negative = past). */
export const daysUntil = (c: Countdown, now: number) => Math.round((nextDate(c, now) - startOfDay(now)) / 86_400_000);

export function describeCountdown(c: Countdown, now: number): string {
  const n = daysUntil(c, now);
  const when = new Date(nextDate(c, now)).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  if (n === 0) return `${c.name} is today (${when})`;
  if (n < 0) return `${c.name} was ${-n} day${n === -1 ? "" : "s"} ago (${when})`;
  const weeks = n >= 14 ? ` (about ${Math.round(n / 7)} weeks)` : "";
  return `${n} day${n === 1 ? "" : "s"} until ${c.name}${weeks}, ${when}${c.yearly ? ", every year" : ""}`;
}

let kv: Store | null = null;
const store = async () => (kv ??= await load("countdowns.json", { autoSave: true }));

interface State {
  items: Countdown[];
  loaded: boolean;
  load(): Promise<void>;
  set(items: Countdown[]): Promise<void>;
}

export const useCountdowns = create<State>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    if (get().loaded) return;
    try {
      set({ items: (await (await store()).get<Countdown[]>("items")) ?? [], loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  async set(items) {
    set({ items });
    await store()
      .then((s) => s.set("items", items))
      .catch(() => {});
  },
}));

export async function manageCountdown(action: string, name: string, date: string, yearly: boolean, now = Date.now()): Promise<string> {
  const st = useCountdowns.getState();
  await st.load();
  const items = useCountdowns.getState().items;
  const find = (n: string) => items.find((c) => c.name.toLowerCase() === n.toLowerCase()) ?? items.find((c) => c.name.toLowerCase().includes(n.toLowerCase()));
  if (action === "add") {
    if (!name.trim()) throw new Error("give the countdown a name");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date).getTime())) throw new Error("date must be YYYY-MM-DD");
    const c: Countdown = { name: name.trim(), date, ...(yearly ? { yearly: true } : {}) };
    await st.set([...items.filter((x) => x.name.toLowerCase() !== c.name.toLowerCase()), c]);
    return `Counting down: ${describeCountdown(c, now)}.`;
  }
  if (action === "remove") {
    const c = find(name);
    if (!c) return `No countdown called "${name}".`;
    await st.set(items.filter((x) => x !== c));
    return `Removed the ${c.name} countdown.`;
  }
  if (name.trim()) {
    const c = find(name);
    return c ? `${describeCountdown(c, now)}.` : `No countdown called "${name}". Work it out from today's date instead, and offer to save it.`;
  }
  const sorted = [...items].sort((a, b) => nextDate(a, now) - nextDate(b, now));
  return sorted.length ? sorted.map((c) => describeCountdown(c, now)).join("\n") : "No countdowns saved.";
}
