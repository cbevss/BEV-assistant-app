import { useEffect, useState } from "react";
import { useRoutines } from "@/routines/store";
import { runRoutine, cancelRoutine, summariseRun } from "@/routines/engine";
import type { Routine, StepResult } from "@/routines/types";
import { useAssistant } from "@/state/assistant";
import { PageHeader, Section, Button, Toggle } from "../components/Form";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { RoutineEditor } from "../components/RoutineEditor";

export function Automation() {
  const { routines, init, save, remove, markRun } = useRoutines();
  const [running, setRunning] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, StepResult[]>>({});
  const [editing, setEditing] = useState<Routine | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<{ text: string; run: () => void } | null>(null);

  useEffect(() => {
    if (!useRoutines.getState().loaded) init();
  }, [init]);

  const run = async (r: Routine) => {
    setRunning(r.id);
    setProgress((p) => ({ ...p, [r.id]: [] }));
    const report = await runRoutine(r, {
      onStep: (res) => setProgress((p) => ({ ...p, [r.id]: [...(p[r.id] ?? []), res] })),
      requestApproval: (d) => useAssistant.getState().requestApproval?.(d) ?? Promise.resolve(false),
    });
    markRun(r.id);
    setRunning(null);
    useAssistant.getState().pushMessage({ role: "assistant", content: summariseRun(report) });
  };

  return (
    <div>
      <PageHeader
        title="Automation Centre"
        subtitle="Multi-step routines you can trigger by voice, by button, or on a schedule. Say the trigger phrase to run one hands-free."
      />

      <div className="mb-5 flex justify-end">
        <Button onClick={() => setCreating(true)}>+ New routine</Button>
      </div>

      <div className="space-y-4">
        {routines.map((r) => {
          const steps = progress[r.id] ?? [];
          const isRunning = running === r.id;
          return (
            <Section
              key={r.id}
              title={r.name}
              aside={
                <div className="flex items-center gap-2">
                  <Toggle
                    label={`Enable ${r.name}`}
                    checked={r.enabled}
                    onChange={(enabled) => save({ ...r, enabled })}
                  />
                  {isRunning ? (
                    <Button variant="danger" onClick={() => cancelRoutine()}>
                      Stop
                    </Button>
                  ) : (
                    <Button onClick={() => run(r)} disabled={!r.enabled || running !== null}>
                      Run
                    </Button>
                  )}
                </div>
              }
            >
              {r.description && <p className="text-sm text-slate-400">{r.description}</p>}
              <div className="flex flex-wrap gap-2 text-[11px]">
                {r.triggers.map((t) => (
                  <span key={t} className="rounded-full bg-bev-cyan/10 px-2 py-0.5 text-bev-cyan">
                    “{t}”
                  </span>
                ))}
                {r.schedule && (
                  <span className="rounded-full bg-bev-violet/15 px-2 py-0.5 text-bev-violet">
                    ⏰ {r.schedule.time}
                  </span>
                )}
              </div>

              <ol className="mt-1 space-y-1">
                {r.steps.map((s, i) => {
                  const res = steps[i];
                  return (
                    <li key={s.id} className="flex items-center gap-2 text-sm">
                      <StepDot status={res?.status} running={isRunning && steps.length === i} />
                      <span className="text-slate-300">{stepLabel(s.tool, s.args)}</span>
                      {res && res.status !== "ok" && (
                        <span className="text-xs text-slate-500">— {res.message}</span>
                      )}
                    </li>
                  );
                })}
              </ol>

              <div className="flex justify-end gap-1 pt-1">
                <Button variant="ghost" onClick={() => setEditing(r)}>
                  Edit
                </Button>
                <Button
                  variant="danger"
                  onClick={() =>
                    setConfirm({
                      text: `Delete the routine "${r.name}"?`,
                      run: () => remove(r.id),
                    })
                  }
                >
                  Delete
                </Button>
              </div>
            </Section>
          );
        })}
        {routines.length === 0 && (
          <p className="text-sm text-slate-500">No routines yet. Create one, or say “BEV, create a routine…”.</p>
        )}
      </div>

      {(editing || creating) && (
        <RoutineEditor
          routine={editing}
          onCancel={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSave={async (r) => {
            await save(r);
            setEditing(null);
            setCreating(false);
          }}
        />
      )}

      {confirm && (
        <ConfirmDialog
          text={confirm.text}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            confirm.run();
            setConfirm(null);
          }}
        />
      )}
    </div>
  );
}

function StepDot({ status, running }: { status?: string; running?: boolean }) {
  const color =
    status === "ok"
      ? "bg-bev-ok"
      : status === "failed"
        ? "bg-bev-danger"
        : status === "skipped" || status === "declined"
          ? "bg-slate-500"
          : running
            ? "bg-bev-cyan animate-pulse"
            : "bg-white/20";
  return <span className={`h-2 w-2 rounded-full ${color}`} />;
}

export function stepLabel(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "launch_app":
      return `Open ${args.name}`;
    case "close_app":
      return `Close ${args.name}`;
    case "set_volume":
      return `Set volume to ${args.percent}%`;
    case "set_muted":
      return args.muted ? "Mute audio" : "Unmute audio";
    case "set_quiet_mode":
      return args.enabled ? "Enable quiet mode" : "Disable quiet mode";
    case "power_action":
      return `${String(args.action ?? "power")} the PC`;
    case "get_system_stats":
      return "Check system stats";
    case "get_datetime":
      return "Get the time & date";
    case "open_settings_page":
      return `Open Settings: ${args.page || "home"}`;
    case "open_website":
      return `Open ${args.url ?? args.search}`;
    default:
      return `${tool} ${JSON.stringify(args)}`;
  }
}
