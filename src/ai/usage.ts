/**
 * Usage and spending: how many requests and tokens each AI used, roughly what
 * that cost, and daily / monthly spending limits.
 *
 * Costs are estimates from list prices (USD per million tokens), not your
 * bill: providers add taxes, discounts, cached-token rates and so on. Built-in
 * prices cover the default models and were checked in November 2026; any
 * model can be given its own price in Settings → Usage.
 *
 * When a limit is reached, paid AIs are skipped. A local AI (Ollama) still
 * answers if it's in the backup list.
 */
import { load, type Store } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import type { ProviderId } from "./catalog";
import type { AiUsage, ChatRequest, AiResponse } from "./types";
import { ProviderError } from "./types";
import { useSettings } from "@/state/settings";
import { notify } from "@/lib/notify";

export interface Price {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

/** List prices, USD per million tokens (input / output), checked Nov 2026. */
export const BUILT_IN_PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  // Prompts up to 100K tokens; BEV's requests are well under that.
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "gpt-5.6-sol": { input: 4, output: 20 },
  "gpt-5.6-terra": { input: 2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gemini-3.5-flash": { input: 1.5, output: 9 },
};

/** Free: runs on this PC. */
export const LOCAL: ReadonlySet<ProviderId> = new Set(["ollama"]);

export interface UsageRow {
  requests: number;
  input: number;
  output: number;
  /** USD; null when the model has no known price. */
  cost: number | null;
  /** Some of the tokens were estimated (the provider didn't report them). */
  estimated: boolean;
}

/** day "YYYY-MM-DD" → "provider/model" → row */
export type UsageDays = Record<string, Record<string, UsageRow>>;

export const dayKey = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function priceFor(provider: ProviderId, model: string, custom: Record<string, Price>): Price | null {
  if (LOCAL.has(provider)) return { input: 0, output: 0 };
  return custom[model] ?? custom[`${provider}/${model}`] ?? BUILT_IN_PRICES[model] ?? null;
}

export const costOf = (u: { input: number; output: number }, p: Price | null) => (p ? (u.input * p.input + u.output * p.output) / 1_000_000 : null);

/** Pure: roughly 4 characters per token, for providers that don't say. */
export function estimateUsage(req: Pick<ChatRequest, "system" | "messages" | "tools">, res: Pick<AiResponse, "text" | "toolCalls">): { input: number; output: number } {
  const inChars = req.system.length + req.messages.reduce((n, m) => n + m.content.length + JSON.stringify(m.toolCalls ?? "").length, 0) + JSON.stringify(req.tools).length;
  const outChars = res.text.length + JSON.stringify(res.toolCalls).length;
  return { input: Math.ceil(inChars / 4), output: Math.ceil(outChars / 4) };
}

/** Pure: add one request to the record. */
export function addUsage(days: UsageDays, day: string, provider: ProviderId, model: string, u: { input: number; output: number }, price: Price | null, estimated: boolean): UsageDays {
  const key = `${provider}/${model}`;
  const today = { ...(days[day] ?? {}) };
  const prev = today[key] ?? { requests: 0, input: 0, output: 0, cost: 0, estimated: false };
  const c = costOf(u, price);
  today[key] = {
    requests: prev.requests + 1,
    input: prev.input + u.input,
    output: prev.output + u.output,
    cost: c === null || prev.cost === null ? null : prev.cost + c,
    estimated: prev.estimated || estimated,
  };
  return { ...days, [day]: today };
}

/** Pure: drop days older than `keep` days. */
export function prune(days: UsageDays, now = Date.now(), keep = 120): UsageDays {
  const cutoff = dayKey(now - keep * 86_400_000);
  return Object.fromEntries(Object.entries(days).filter(([d]) => d >= cutoff));
}

export interface Totals {
  requests: number;
  input: number;
  output: number;
  cost: number;
  /** Requests whose cost isn't known (no price). */
  unpriced: number;
}

export function totals(days: UsageDays, from: string, to = "9999"): Totals {
  const t: Totals = { requests: 0, input: 0, output: 0, cost: 0, unpriced: 0 };
  for (const [d, rows] of Object.entries(days)) {
    if (d < from || d > to) continue;
    for (const r of Object.values(rows)) {
      t.requests += r.requests;
      t.input += r.input;
      t.output += r.output;
      if (r.cost === null) t.unpriced += r.requests;
      else t.cost += r.cost;
    }
  }
  return t;
}

export const monthStart = (t = Date.now()) => `${dayKey(t).slice(0, 7)}-01`;

export interface Limits {
  dailyUsd: number | null;
  monthlyUsd: number | null;
}

/** Pure: which limit (if any) has been reached, and which is close (80%+). */
export function limitState(days: UsageDays, limits: Limits, now = Date.now()): { reached: "daily" | "monthly" | null; near: "daily" | "monthly" | null; today: number; month: number } {
  const today = totals(days, dayKey(now), dayKey(now)).cost;
  const month = totals(days, monthStart(now)).cost;
  const over = (spent: number, lim: number | null) => lim !== null && lim > 0 && spent >= lim;
  const close = (spent: number, lim: number | null) => lim !== null && lim > 0 && spent >= lim * 0.8;
  const reached = over(month, limits.monthlyUsd) ? "monthly" : over(today, limits.dailyUsd) ? "daily" : null;
  const near = reached ? null : close(month, limits.monthlyUsd) ? "monthly" : close(today, limits.dailyUsd) ? "daily" : null;
  return { reached, near, today, month };
}

export const formatUsd = (v: number) => (v === 0 ? "$0" : v < 0.01 ? "<$0.01" : `$${v < 10 ? v.toFixed(2) : v.toFixed(0)}`);

// ---------------------------------------------------------------------------
// The store

let kv: Store | null = null;
const store = async () => (kv ??= await load("usage.json", { autoSave: true }));

interface UsageState {
  days: UsageDays;
  loaded: boolean;
  load(): Promise<void>;
  record(provider: ProviderId, req: ChatRequest, res: AiResponse, fallbackModel: string): Promise<void>;
  clear(): Promise<void>;
}

/** Warnings already shown, so each shows once per day/month. */
const warned = new Set<string>();

export const useUsage = create<UsageState>((set, get) => ({
  days: {},
  loaded: false,
  async load() {
    if (get().loaded) return;
    try {
      const s = await store();
      set({ days: prune(((await s.get<UsageDays>("days")) ?? {}) as UsageDays), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  async record(provider, req, res, fallbackModel) {
    await get().load();
    const reported: AiUsage | undefined = res.usage;
    const u = reported ?? estimateUsage(req, res);
    const model = reported?.model || req.model || fallbackModel;
    const price = priceFor(provider, model, useSettings.getState().settings.spending.prices);
    const days = prune(addUsage(get().days, dayKey(), provider, model, u, price, !reported));
    set({ days });
    await store()
      .then((s) => s.set("days", days))
      .catch(() => {});
    const st = limitState(days, useSettings.getState().settings.spending);
    const which = st.reached ?? st.near;
    if (which) {
      const tag = `${st.reached ? "reached" : "near"}-${which}-${which === "daily" ? dayKey() : monthStart()}`;
      if (!warned.has(tag)) {
        warned.add(tag);
        const spent = formatUsd(which === "daily" ? st.today : st.month);
        void notify(
          st.reached ? "BEV spending limit reached" : "BEV spending limit nearly reached",
          st.reached
            ? `About ${spent} spent ${which === "daily" ? "today" : "this month"}. BEV won't use paid AIs until ${which === "daily" ? "tomorrow" : "next month"}, or until you raise the limit in Settings → Usage.`
            : `About ${spent} spent ${which === "daily" ? "today" : "this month"}, over 80% of your limit.`,
        ).catch(() => {});
      }
    }
  },
  async clear() {
    set({ days: {} });
    await store()
      .then((s) => s.set("days", {}))
      .catch(() => {});
  },
}));

/** Thrown instead of calling a paid AI once a limit is reached. */
export function limitError(which: "daily" | "monthly"): ProviderError {
  return new ProviderError(
    `Your ${which} spending limit for AI is reached, so BEV isn't using paid AIs ${which === "daily" ? "until tomorrow" : "until next month"}. You can raise it in Settings → Usage.`,
    false,
    "quota",
  );
}

/** The limit stopping paid AIs right now, if any. */
export function blockedBy(): "daily" | "monthly" | null {
  return limitState(useUsage.getState().days, useSettings.getState().settings.spending).reached;
}
