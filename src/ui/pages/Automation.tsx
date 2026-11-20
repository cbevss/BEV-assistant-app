import { useEffect, useState } from "react";
import { useRoutines } from "@/routines/store";
import { runRoutine, cancelRoutine, summariseRun } from "@/routines/engine";
import type { Routine, StepResult } from "@/routines/types";
import { useAssistant } from "@/state/assistant";
import clsx from "clsx";
import { ChevronRight, Pencil, Play, Plus, Square, Trash2, Workflow } from "lucide-react";
import { PageHeader, Button, Toggle, IconButton, Card, EmptyState } from "../components/Form";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { RoutineEditor } from "../components/RoutineEditor";
import { TeachBev } from "../components/TeachBev";
import { prettyAccelerator } from "@/lib/hotkeys";
import { TimersSection, WatchesSection, LayoutsSection, CountdownsSection } from "../components/TimersSection";
import { describeSteps } from "@/ai/learn";

export function Automation() {
  const { routines, init, save, remove, markRun } = useRoutines();
  const [running, setRunning] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, StepResult[]>>({});
  const [editing, setEditing] = useState<Routine | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<{ text: string; run: () => void } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

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
        title="Automations"
        subtitle="Routines BEV runs from a phrase, a button or a schedule. Say the phrase to run one hands-free."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
            New routine
          </Button>
        }
      />

      {routines.length === 0 ? (
        <Card>
          <EmptyState icon={Workflow} title="No routines yet" action={<Button icon={Plus} onClick={() => setCreating(true)}>New routine</Button>}>
            Group several actions under one phrase, like “gaming mode”. You can also say “BEV, create a routine…”.
          </EmptyState>
        </Card>
      ) : (
        <ul className="divide-y divide-line-subtle rounded-lg border border-line-subtle bg-surface-1">
          {routines.map((r) => {
            const steps = progress[r.id] ?? [];
            const isRunning = running === r.id;
            const isOpen = open === r.id || isRunning;
            return (
              <li key={r.id} className={clsx(!r.enabled && "opacity-60")}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <button className="group flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={isOpen}>
                    <ChevronRight className={clsx("h-3.5 w-3.5 shrink-0 text-ink-4 transition-transform duration-fast", isOpen && "rotate-90")} aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">{r.name}</span>
                      <span className="block truncate text-xs text-ink-3">
                        {r.triggers.length ? r.triggers.map((t) => `“${t}”`).join(", ") : "No phrase"}
                        {r.handsOn ? " · uses your apps" : r.schedule ? ` · daily at ${r.schedule.time}` : ""}{r.hotkey ? ` · ${prettyAccelerator(r.hotkey)}` : ""} · {r.steps.length} step{r.steps.length === 1 ? "" : "s"}
                      </span>
                    </span>
                  </button>
                  <Toggle label={`Enable ${r.name}`} checked={r.enabled} onChange={(enabled) => save({ ...r, enabled })} />
                  {isRunning ? (
                    <Button variant="danger" size="sm" icon={Square} onClick={() => cancelRoutine()}>
                      Stop
                    </Button>
                  ) : (
                    <Button size="sm" icon={Play} onClick={() => run(r)} disabled={!r.enabled || running !== null}>
                      Run
                    </Button>
                  )}
                  <IconButton icon={Pencil} label={`Edit ${r.name}`} size="sm" onClick={() => setEditing(r)} />
                  <IconButton
                    icon={Trash2}
                    label={`Delete ${r.name}`}
                    size="sm"
                    className="hover:!bg-danger/10 hover:!text-danger"
                    onClick={() => setConfirm({ text: `Delete the routine "${r.name}"? This can't be undone.`, run: () => remove(r.id) })}
                  />
                </div>
                {isOpen && (
                  <div className="border-t border-line-subtle px-4 py-3 pl-10 animate-fade-in">
                    {r.description && <p className="mb-2 text-sm text-ink-2">{r.description}</p>}
                    <ol className="space-y-1">
                      {r.steps.map((st, i) => {
                        const res = steps[i];
                        return (
                          <li key={st.id} className="flex items-center gap-2.5 text-sm">
                            <StepDot status={res?.status} running={isRunning && steps.length === i} />
                            <span className="text-ink-2">{stepLabel(st.tool, st.args)}</span>
                            {res && res.status !== "ok" && <span className="text-xs text-ink-3">{res.message}</span>}
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-8">
        <TimersSection />
        <WatchesSection />
        <CountdownsSection />
        <LayoutsSection />
        <TeachBev />
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
      ? "bg-ok"
      : status === "failed"
        ? "bg-danger"
        : status === "skipped" || status === "declined"
          ? "bg-slate-500"
          : running
            ? "bg-accent animate-pulse"
            : "bg-ink-4";
  return <span className={`h-2 w-2 rounded-full ${color}`} />;
}

export function stepLabel(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "launch_app":
      return `Open ${args.name}`;
    case "launch_game":
      return `Open ${args.name} (${args.mode === "offline" ? "offline" : "online"})`;
    case "open_path": {
      const p = String(args.path ?? "");
      return `Open ${p.split(/[\\/]/).filter(Boolean).pop() ?? p}`;
    }
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
    default: {
      const [line] = describeSteps([{ id: "", tool, args }]);
      return line.charAt(0).toUpperCase() + line.slice(1);
    }
  }
}
