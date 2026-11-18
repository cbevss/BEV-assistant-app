import { useEffect, useState } from "react";
import { native, type TaskRun } from "@/lib/native";
import { Section , EmptyState } from "./Form";
import clsx from "clsx";
import { Check, ListChecks, X } from "lucide-react";

const STATUS: Record<TaskRun["status"], { label: string; cls: string }> = {
  running: { label: "Running", cls: "text-accent" },
  done: { label: "Done", cls: "text-ink-3" },
  failed: { label: "Failed", cls: "text-danger" },
  cancelled: { label: "Cancelled", cls: "text-ink-3" },
  interrupted: { label: "Interrupted", cls: "text-warn" },
};

function when(ms: number): string {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** The task journal: what BEV was asked, what it did, how it ended. */
export function RecentTasks() {
  const [runs, setRuns] = useState<TaskRun[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => native.journalRecent(15).then((r) => alive && setRuns(r)).catch(() => alive && setRuns([]));
    load();
    const id = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <Section title="Recent tasks" description="What BEV was asked and how each request ended." flush>
      {runs === null ? (
        <p className="px-4 py-3 text-sm text-ink-3">Loading…</p>
      ) : runs.length === 0 ? (
        <EmptyState icon={ListChecks} title="Nothing yet">Things you ask BEV to do show up here, step by step.</EmptyState>
      ) : (
        <ul className="divide-y divide-line-subtle">
          {runs.map((r) => {
            const s = STATUS[r.status];
            const expanded = open === r.id;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors duration-fast hover:bg-surface-2"
                  onClick={() => setOpen(expanded ? null : r.id)}
                  aria-expanded={expanded}
                >
                  <span className="min-w-0 truncate text-sm text-ink">{r.request}</span>
                  <span className="flex shrink-0 items-center gap-3 text-xs">
                    <span className={clsx(s.cls)}>{s.label}</span>
                    <span className="tnum text-ink-4">{when(r.started_at)}</span>
                  </span>
                </button>
                {expanded && (
                  <div className="mx-4 mb-3 space-y-1 border-l border-line pl-3 text-xs animate-fade-in">
                    {r.steps.length === 0 && <div className="text-ink-3">No actions were needed.</div>}
                    {r.steps.map((st, i) => (
                      <div key={i} className="flex gap-2">
                        {st.ok ? <Check className="mt-0.5 h-3 w-3 shrink-0 text-ok" aria-label="ok" /> : <X className="mt-0.5 h-3 w-3 shrink-0 text-danger" aria-label="failed" />}
                        <span className="shrink-0 font-mono text-ink-3">{st.tool}</span>
                        <span className="min-w-0 truncate text-ink-2">{st.summary}</span>
                      </div>
                    ))}
                    {r.status === "interrupted" && (
                      <div className="text-warn">BEV stopped before finishing this (it closed or the PC shut down).</div>
                    )}
                    {r.result && <div className="text-ink-2">Result: {r.result}</div>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
