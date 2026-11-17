import { useEffect, useState } from "react";
import clsx from "clsx";
import { useBackground, startBackgroundTask, cancelBackgroundTask, MAX_RUNNING, type BgTask } from "@/ai/background";
import { Section, TextInput, Button } from "./Form";
import { PlanView } from "./PlanView";

const STATUS: Record<BgTask["status"], { label: string; cls: string }> = {
  running: { label: "Working", cls: "text-bev-cyan" },
  done: { label: "Done", cls: "text-bev-ok" },
  failed: { label: "Failed", cls: "text-bev-danger" },
  cancelled: { label: "Cancelled", cls: "text-slate-400" },
};

function elapsed(t: BgTask, now: number) {
  const s = Math.round(((t.endedAt ?? now) - t.startedAt) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Jobs BEV is doing in the background: progress, results, cancel. */
export function BackgroundTasks() {
  const { tasks, dismiss } = useBackground();
  const [goal, setGoal] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const running = tasks.filter((t) => t.status === "running").length;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const start = () => {
    try {
      startBackgroundTask(goal.trim());
      setGoal("");
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Section title="Background tasks">
      <div className="flex gap-2">
        <TextInput
          placeholder="Give BEV a job to work on, e.g. compare the three cheapest 1440p monitors and save a note"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && goal.trim() && start()}
        />
        <Button onClick={start} disabled={!goal.trim() || running >= MAX_RUNNING}>
          Start
        </Button>
      </div>
      {err && <p className="text-sm text-bev-danger">{err}</p>}
      {tasks.length === 0 && <p className="text-sm text-slate-500">Nothing running. You can also say “BEV, in the background, …”.</p>}
      <ul className="divide-y divide-white/5">
        {tasks.map((t) => {
          const current = t.plan.find((s) => s.status === "in_progress")?.text ?? t.log[t.log.length - 1]?.tool;
          return (
            <li key={t.id} className="py-3">
              <div className="flex items-start justify-between gap-3">
                <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(open === t.id ? null : t.id)}>
                  <div className="truncate text-sm text-slate-100">{t.goal}</div>
                  <div className="text-xs text-slate-500">
                    <span className={STATUS[t.status].cls}>{STATUS[t.status].label}</span> · {elapsed(t, now)}
                    {t.status === "running" && current ? ` · ${current}` : ""}
                    {t.needsApproval.length ? <span className="text-amber-300"> · needs your OK</span> : null}
                  </div>
                </button>
                {t.status === "running" ? (
                  <Button variant="ghost" onClick={() => cancelBackgroundTask(t.id)}>
                    Cancel
                  </Button>
                ) : (
                  <Button variant="ghost" onClick={() => dismiss(t.id)}>
                    Dismiss
                  </Button>
                )}
              </div>
              {open === t.id && (
                <div className="mt-2 space-y-2">
                  <PlanView plan={t.plan} />
                  {t.result && <p className="whitespace-pre-wrap rounded-lg bg-white/5 p-3 text-sm text-slate-200">{t.result}</p>}
                  {t.needsApproval.length > 0 && (
                    <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-sm text-amber-200">
                      It wanted to do these, which need you. Ask BEV directly if you want them done:
                      <ul className="mt-1 list-disc pl-5">
                        {t.needsApproval.map((d, i) => (
                          <li key={i}>{d}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {t.log.length > 0 && (
                    <ul className="space-y-0.5 text-xs text-slate-500">
                      {t.log.slice(-12).map((l, i) => (
                        <li key={i} className={clsx(!l.ok && "text-bev-danger")}>
                          {l.tool}: {l.summary}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
