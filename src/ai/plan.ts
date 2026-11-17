/** A task plan the AI keeps up to date while it works (update_plan tool). */

export type StepStatus = "pending" | "in_progress" | "done" | "failed" | "skipped";
export interface PlanStep {
  text: string;
  status: StepStatus;
  /** What happened, e.g. the evidence it worked or why it failed. */
  note?: string;
}

const STATUSES: StepStatus[] = ["pending", "in_progress", "done", "failed", "skipped"];

/** Validate the model's plan argument; throws with a message the model can act on. */
export function parsePlan(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('argument "steps" must be a non-empty list');
  if (raw.length > 15) throw new Error("keep the plan to 15 steps or fewer");
  return raw.map((s, i) => {
    const o = (typeof s === "string" ? { text: s } : s) as Record<string, unknown>;
    const text = typeof o?.text === "string" ? o.text.trim().slice(0, 200) : "";
    if (!text) throw new Error(`step ${i + 1} needs text`);
    const status = STATUSES.includes(o.status as StepStatus) ? (o.status as StepStatus) : "pending";
    const note = typeof o.note === "string" && o.note.trim() ? o.note.trim().slice(0, 300) : undefined;
    return { text, status, note };
  });
}

export const unfinished = (p: PlanStep[] | null) => (p ?? []).filter((s) => s.status === "pending" || s.status === "in_progress");

export function progress(p: PlanStep[]): { done: number; total: number } {
  const total = p.filter((s) => s.status !== "skipped").length;
  return { done: p.filter((s) => s.status === "done").length, total };
}

const MARK: Record<StepStatus, string> = { pending: "[ ]", in_progress: "[>]", done: "[x]", failed: "[!]", skipped: "[-]" };
export const formatPlan = (p: PlanStep[]) => p.map((s, i) => `${MARK[s.status]} ${i + 1}. ${s.text}${s.note ? ` (${s.note})` : ""}`).join("\n");
