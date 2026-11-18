import clsx from "clsx";
import { Check, Minus, X } from "lucide-react";
import type { PlanStep } from "@/ai/plan";
import { progress } from "@/ai/plan";

/** A task plan with live step status. */
export function PlanView({ plan, compact }: { plan: PlanStep[]; compact?: boolean }) {
  if (!plan.length) return null;
  const p = progress(plan);
  return (
    <div className={clsx("rounded-lg border border-line-subtle bg-surface-1", compact ? "px-3 py-2.5" : "px-4 py-3")}>
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="text-ink-2">Plan</span>
        <span className="tnum text-ink-3">
          {p.done} of {p.total}
        </span>
      </div>
      <div className="mb-2.5 h-[3px] overflow-hidden rounded-full bg-surface-3">
        <div className="h-full rounded-full bg-accent transition-[width] duration-base" style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%` }} />
      </div>
      <ol className="space-y-1">
        {plan.map((s, i) => (
          <li key={i} className="flex items-start gap-2.5 text-sm">
            <span className="mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center" aria-label={s.status}>
              {s.status === "done" ? (
                <Check className="h-3.5 w-3.5 text-ok" strokeWidth={2.2} />
              ) : s.status === "failed" ? (
                <X className="h-3.5 w-3.5 text-danger" strokeWidth={2.2} />
              ) : s.status === "skipped" ? (
                <Minus className="h-3.5 w-3.5 text-ink-4" />
              ) : s.status === "in_progress" ? (
                <span className="h-2 w-2 rounded-full bg-accent animate-breathe" />
              ) : (
                <span className="h-2 w-2 rounded-full border border-ink-4" />
              )}
            </span>
            <span className={clsx(s.status === "done" || s.status === "skipped" ? "text-ink-3" : s.status === "failed" ? "text-danger" : "text-ink", s.status === "skipped" && "line-through")}>
              {s.text}
              {s.note && !compact && <span className="block text-xs text-ink-3">{s.note}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
