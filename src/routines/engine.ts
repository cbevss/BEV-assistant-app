import { tools, isSensitive } from "@/ai/tools";
import { native } from "@/lib/native";
import { toolAllowed } from "@/state/settings";
import type { Routine, RoutineStep, RunReport, StepResult, StepCondition } from "./types";

export interface RunHooks {
  onStep?: (r: StepResult, index: number, total: number) => void;
  /** Approve a sensitive step. Return false to decline (step marked declined). */
  requestApproval?: (description: string) => Promise<boolean>;
}

/** Tools a routine may never call, to prevent recursion / self-modification. */
export const ROUTINE_FORBIDDEN = new Set(["create_routine", "delete_routine", "run_routine", "list_routines"]);

let current: AbortController | null = null;

/** Cancel the running routine, if any ("BEV, stop"). */
export function cancelRoutine() {
  current?.abort();
}

export function isRoutineRunning() {
  return current !== null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

async function conditionMet(cond: StepCondition | undefined): Promise<boolean> {
  if (!cond || cond.type === "always") return true;
  const procs = await native.listProcesses().catch(() => []);
  const want = cond.name.toLowerCase().replace(/\.exe$/, "");
  const running = procs.some((p) => p.name.toLowerCase().replace(/\.exe$/, "") === want);
  return cond.type === "process_running" ? running : !running;
}

async function runStep(step: RoutineStep, signal: AbortSignal, hooks: RunHooks): Promise<StepResult> {
  const base = { stepId: step.id, tool: step.tool };
  const tool = tools[step.tool];
  if (!tool) return { ...base, status: "failed", message: `unknown tool "${step.tool}"` };
  if (ROUTINE_FORBIDDEN.has(step.tool))
    return { ...base, status: "failed", message: `"${step.tool}" can't be used inside a routine` };
  if (!toolAllowed(step.tool)) return { ...base, status: "skipped", message: "permission revoked" };

  if (!(await conditionMet(step.condition))) return { ...base, status: "skipped", message: "condition not met" };

  if (step.delayMs && step.delayMs > 0) await sleep(step.delayMs, signal);

  if (isSensitive(step.tool)) {
    const ok = (await hooks.requestApproval?.(`Routine step: ${describeStep(step)}`)) ?? false;
    if (!ok) return { ...base, status: "declined", message: "declined by user" };
  }

  const attempts = Math.max(1, 1 + (step.retries ?? 0));
  let lastErr = "";
  for (let i = 0; i < attempts; i++) {
    if (signal.aborted) return { ...base, status: "cancelled", message: "cancelled" };
    try {
      const message = await tool.run(step.args);
      native.logAction(step.tool, JSON.stringify(step.args), message, true).catch(() => {});
      return { ...base, status: "ok", message };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (i < attempts - 1) await sleep(600, signal).catch(() => {});
    }
  }
  native.logAction(step.tool, JSON.stringify(step.args), lastErr, false).catch(() => {});
  return { ...base, status: "failed", message: lastErr };
}

function describeStep(step: RoutineStep): string {
  const a = step.args;
  switch (step.tool) {
    case "launch_app":
      return `open ${a.name}`;
    case "close_app":
      return `close ${a.name}`;
    case "set_volume":
      return `set volume to ${a.percent}%`;
    case "power_action":
      return `${a.action} the PC`;
    default:
      return `${step.tool} ${JSON.stringify(a)}`;
  }
}

/**
 * Run a routine's steps in order. A failed step stops the routine unless it is
 * marked continueOnError. Honours cancellation throughout.
 */
export async function runRoutine(routine: Routine, hooks: RunHooks = {}): Promise<RunReport> {
  current?.abort();
  const ctl = new AbortController();
  current = ctl;
  const results: StepResult[] = [];
  let cancelled = false;

  try {
    for (let i = 0; i < routine.steps.length; i++) {
      if (ctl.signal.aborted) {
        cancelled = true;
        break;
      }
      let result: StepResult;
      try {
        result = await runStep(routine.steps[i], ctl.signal, hooks);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          cancelled = true;
          break;
        }
        result = { stepId: routine.steps[i].id, tool: routine.steps[i].tool, status: "failed", message: String(e) };
      }
      results.push(result);
      hooks.onStep?.(result, i, routine.steps.length);
      if (result.status === "failed" && !routine.steps[i].continueOnError) break;
    }
  } finally {
    if (current === ctl) current = null;
  }

  const ok = results.every((r) => r.status === "ok" || r.status === "skipped");
  return { routineId: routine.id, name: routine.name, ok: ok && !cancelled, cancelled, results };
}

/** One-line spoken summary of a run for BEV to say back. */
export function summariseRun(report: RunReport): string {
  if (report.cancelled) return `${report.name} cancelled.`;
  const ok = report.results.filter((r) => r.status === "ok").length;
  const failed = report.results.filter((r) => r.status === "failed");
  const declined = report.results.filter((r) => r.status === "declined").length;
  if (report.ok && declined === 0) return `${report.name} done — ${ok} step${ok === 1 ? "" : "s"} completed.`;
  const bits: string[] = [`${report.name}: ${ok} done`];
  if (failed.length) bits.push(`${failed.length} failed (${failed[0].message})`);
  if (declined) bits.push(`${declined} skipped by you`);
  return bits.join(", ") + ".";
}
