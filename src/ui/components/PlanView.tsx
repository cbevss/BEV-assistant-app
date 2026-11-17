import clsx from "clsx";
import type { PlanStep } from "@/ai/plan";
import { progress } from "@/ai/plan";

const DOT: Record<PlanStep["status"], string> = {
  pending: "border border-slate-500",
  in_progress: "bg-bev-cyan animate-pulse",
  done: "bg-bev-ok",
  failed: "bg-bev-danger",
  skipped: "bg-slate-600",
};

/** A task plan with live step status. */
export function PlanView({ plan, compact }: { plan: PlanStep[]; compact?: boolean }) {
  if (!plan.length) return null;
  const p = progress(plan);
  return (
    <div className={clsx("rounded-lg border border-white/10", compact ? "p-2" : "p-3")}>
      <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
        <span>Plan</span>
        <span className="tabular-nums">
          {p.done}/{p.total}
        </span>
      </div>
      <div className="mb-2 h-1 overflow-hidden rounded bg-white/5">
        <div className="h-full bg-bev-cyan transition-[width]" style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%` }} />
      </div>
      <ol className="space-y-1">
        {plan.map((s, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <span className={clsx("mt-1.5 h-2 w-2 shrink-0 rounded-full", DOT[s.status])} aria-label={s.status} />
            <span className={clsx(s.status === "done" || s.status === "skipped" ? "text-slate-400" : s.status === "failed" ? "text-bev-danger" : "text-slate-200", s.status === "skipped" && "line-through")}>
              {s.text}
              {s.note && !compact && <span className="block text-xs text-slate-500">{s.note}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
