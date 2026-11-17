import { useEffect, useState } from "react";
import { native, type TaskRun } from "@/lib/native";
import { Section } from "./Form";
import clsx from "clsx";

const STATUS: Record<TaskRun["status"], { label: string; cls: string }> = {
  running: { label: "Running", cls: "text-bev-cyan" },
  done: { label: "Done", cls: "text-bev-ok" },
  failed: { label: "Failed", cls: "text-bev-danger" },
  cancelled: { label: "Cancelled", cls: "text-slate-400" },
  interrupted: { label: "Interrupted", cls: "text-amber-400" },
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
    <Section title="Recent tasks">
      {runs === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing yet. Things you ask BEV to do show up here, step by step.</p>
      ) : (
        <ul className="divide-y divide-white/5">
          {runs.map((r) => {
            const s = STATUS[r.status];
            const expanded = open === r.id;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 py-2 text-left"
                  onClick={() => setOpen(expanded ? null : r.id)}
                  aria-expanded={expanded}
                >
                  <span className="min-w-0 truncate text-sm text-slate-200">{r.request}</span>
                  <span className="flex shrink-0 items-center gap-3 text-xs">
                    <span className={clsx(s.cls)}>{s.label}</span>
                    <span className="tabular-nums text-slate-500">{when(r.started_at)}</span>
                  </span>
                </button>
                {expanded && (
                  <div className="mb-2 space-y-1 border-l border-white/10 pl-3 text-xs">
                    {r.steps.length === 0 && <div className="text-slate-500">No actions were needed.</div>}
                    {r.steps.map((st, i) => (
                      <div key={i} className="flex gap-2">
                        <span className={st.ok ? "text-bev-ok" : "text-bev-danger"}>{st.ok ? "✓" : "✕"}</span>
                        <span className="text-slate-400">{st.tool}</span>
                        <span className="min-w-0 truncate text-slate-300">{st.summary}</span>
                      </div>
                    ))}
                    {r.status === "interrupted" && (
                      <div className="text-amber-400">BEV stopped before finishing this (it closed or the PC shut down).</div>
                    )}
                    {r.result && <div className="text-slate-400">Result: {r.result}</div>}
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
