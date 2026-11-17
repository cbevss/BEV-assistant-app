/**
 * Background tasks: a goal BEV works on by itself while the user carries on.
 * Each runs in its own Orchestrator (own history, plan and AbortController),
 * can be watched and cancelled, and reports back with a notification. They
 * never touch the screen or input, and anything needing approval is refused
 * and listed for the user.
 */
import { create } from "zustand";
import type { AiProvider, ToolCall } from "./types";
import type { PlanStep } from "./plan";
import { progress } from "./plan";

export type BgStatus = "running" | "done" | "failed" | "cancelled";

export interface BgTask {
  id: number;
  goal: string;
  /** Short name shown instead of the goal (e.g. "Daily briefing"). */
  title?: string;
  status: BgStatus;
  startedAt: number;
  endedAt?: number;
  plan: PlanStep[];
  log: Array<{ tool: string; ok: boolean; summary: string; at: number }>;
  result?: string;
  /** Actions it wanted to take that need the user's OK. */
  needsApproval: string[];
}

interface Store {
  tasks: BgTask[];
  patch: (id: number, p: Partial<BgTask> | ((t: BgTask) => Partial<BgTask>)) => void;
  add: (t: BgTask) => void;
  dismiss: (id: number) => void;
}

export const useBackground = create<Store>((set) => ({
  tasks: [],
  add: (t) => set((s) => ({ tasks: [t, ...s.tasks].slice(0, 30) })),
  patch: (id, p) => set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...(typeof p === "function" ? p(t) : p) } : t)) })),
  dismiss: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id || t.status === "running") })),
}));

export const MAX_RUNNING = 2;
let nextId = 1;
const controllers = new Map<number, AbortController>();

/** Wiring that would otherwise create an import cycle with the orchestrator. */
export interface BgDeps {
  makeProvider: () => AiProvider;
  makeOrchestrator: (
    provider: AiProvider,
    hooks: {
      onState: () => void;
      onAssistantText: () => void;
      onToolResult: (name: string, ok: boolean, result: string) => void;
      requestApproval: (call: ToolCall, description: string) => Promise<boolean>;
      onPlan: (plan: PlanStep[]) => void;
    }
  ) => { send: (text: string, signal?: AbortSignal) => Promise<string> };
  notify: (title: string, body: string) => void;
}
let deps: BgDeps | null = null;
export function configureBackground(d: BgDeps) {
  deps = d;
}

const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function startBackgroundTask(goal: string, opts: { title?: string; quiet?: boolean } = {}): BgTask {
  if (!deps) throw new Error("background tasks aren't ready yet");
  const running = useBackground.getState().tasks.filter((t) => t.status === "running").length;
  if (running >= MAX_RUNNING) throw new Error(`${running} background tasks are already running; wait for one to finish or cancel one`);
  const id = nextId++;
  const task: BgTask = { id, goal, title: opts.title, status: "running", startedAt: Date.now(), plan: [], log: [], needsApproval: [] };
  const store = useBackground.getState();
  store.add(task);
  const ctl = new AbortController();
  controllers.set(id, ctl);
  const { patch } = useBackground.getState();
  const o = deps.makeOrchestrator(deps.makeProvider(), {
    onState: () => {},
    onAssistantText: () => {},
    onToolResult: (tool, ok, result) => patch(id, (t) => ({ log: [...t.log, { tool, ok, summary: short(result), at: Date.now() }].slice(-60) })),
    requestApproval: async (_call, description) => {
      patch(id, (t) => ({ needsApproval: [...t.needsApproval, description] }));
      return false;
    },
    onPlan: (plan) => patch(id, { plan }),
  });
  const d = deps;
  o.send(goal, ctl.signal)
    .then((result) => {
      patch(id, { status: "done", result, endedAt: Date.now() });
      if (!opts.quiet) d.notify("BEV finished a task", short(`${opts.title ?? goal}: ${result || "done"}`, 220));
    })
    .catch((e) => {
      const cancelled = e instanceof DOMException && e.name === "AbortError";
      patch(id, { status: cancelled ? "cancelled" : "failed", result: cancelled ? "Cancelled." : String(e instanceof Error ? e.message : e), endedAt: Date.now() });
      if (!cancelled && !opts.quiet) d.notify("BEV couldn't finish a task", short(opts.title ?? goal, 200));
    })
    .finally(() => controllers.delete(id));
  return task;
}

export function cancelBackgroundTask(id: number): boolean {
  const c = controllers.get(id);
  if (!c) return false;
  c.abort();
  return true;
}

/** One line per task for the AI or a status readout. */
export function describeTask(t: BgTask): string {
  const p = progress(t.plan);
  const steps = p.total ? `, ${p.done}/${p.total} steps` : "";
  const mins = Math.max(0, Math.round(((t.endedAt ?? Date.now()) - t.startedAt) / 60000));
  const head = `#${t.id} ${JSON.stringify(short(t.goal, 80))}: ${t.status}${steps}, ${mins} min`;
  const extra = [t.result && t.status !== "running" ? `result: ${short(t.result, 400)}` : "", t.needsApproval.length ? `needs your OK for: ${t.needsApproval.map((d) => short(d, 80)).join("; ")}` : ""].filter(Boolean);
  return [head, ...extra].join(" · ");
}
