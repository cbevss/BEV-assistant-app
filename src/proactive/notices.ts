/**
 * Things BEV noticed on its own. Every proactive alert goes through here:
 * duplicates are dropped, nothing pops up while a fullscreen game is in front
 * or quiet mode is on (they wait until afterwards), and recent ones are given
 * to the AI so it can bring them up when relevant.
 */
import { create } from "zustand";

export type NoticeKind = "resources" | "crash" | "network" | "disk" | "stability" | "briefing" | "task";

export interface Notice {
  id: number;
  at: number;
  kind: NoticeKind;
  title: string;
  body: string;
  /** Shown to the user yet (held back while gaming)? */
  delivered: boolean;
}

interface Store {
  items: Notice[];
  add: (n: Notice) => void;
  markDelivered: (ids: number[]) => void;
  clear: () => void;
}

export const useNotices = create<Store>((set) => ({
  items: [],
  add: (n) => set((s) => ({ items: [n, ...s.items].slice(0, 50) })),
  markDelivered: (ids) => set((s) => ({ items: s.items.map((n) => (ids.includes(n.id) ? { ...n, delivered: true } : n)) })),
  clear: () => set({ items: [] }),
}));

export interface NoticeDeps {
  notify: (title: string, body: string) => Promise<void> | void;
  /** True while a game owns the screen or quiet mode is on. */
  holdBack: () => Promise<boolean>;
  now?: () => number;
}

let deps: NoticeDeps | null = null;
let nextId = 1;
const lastByKey = new Map<string, number>();

export function configureNotices(d: NoticeDeps) {
  deps = d;
}
export function _resetNotices() {
  lastByKey.clear();
  nextId = 1;
  useNotices.getState().clear();
}

/**
 * Record and show a notice. `key` + `cooldownMs` stop repeats (e.g. one CPU
 * alert per 10 minutes). Returns false if it was a repeat.
 */
export async function raise(kind: NoticeKind, title: string, body: string, opts: { key?: string; cooldownMs?: number } = {}): Promise<boolean> {
  const now = deps?.now?.() ?? Date.now();
  const key = opts.key ?? `${kind}:${title}`;
  const last = lastByKey.get(key);
  if (last !== undefined && now - last < (opts.cooldownMs ?? 30 * 60_000)) return false;
  lastByKey.set(key, now);
  const n: Notice = { id: nextId++, at: now, kind, title, body, delivered: false };
  useNotices.getState().add(n);
  await deliverPending();
  return true;
}

/** Show anything held back, unless still gaming. */
export async function deliverPending() {
  if (!deps) return;
  const pending = useNotices.getState().items.filter((n) => !n.delivered);
  if (!pending.length || (await deps.holdBack().catch(() => false))) return;
  // After a gaming session, one summary instead of a burst.
  if (pending.length > 2) {
    await deps.notify(`BEV noticed ${pending.length} things`, pending.slice(0, 4).map((n) => n.title).join("; "));
  } else {
    for (const n of pending.reverse()) await deps.notify(n.title, n.body);
  }
  useNotices.getState().markDelivered(pending.map((n) => n.id));
}

/** Recent notices for the system prompt, newest first. */
export function noticesForPrompt(now = Date.now()): string {
  const recent = useNotices.getState().items.filter((n) => n.kind !== "briefing" && now - n.at < 6 * 3600_000).slice(0, 6);
  if (!recent.length) return "";
  return `Things BEV noticed on the PC recently (mention them only if relevant):\n${recent
    .map((n) => `- ${new Date(n.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} ${n.title}: ${n.body}`)
    .join("\n")}`;
}
