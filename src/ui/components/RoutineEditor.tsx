import { useState } from "react";
import { motion } from "framer-motion";
import type { Routine, RoutineStep } from "@/routines/types";
import { TextInput, Select, Button, Toggle } from "./Form";

const TOOL_OPTIONS = [
  { value: "launch_app", label: "Open app" },
  { value: "close_app", label: "Close app" },
  { value: "set_volume", label: "Set volume" },
  { value: "set_muted", label: "Mute / unmute" },
  { value: "set_quiet_mode", label: "Quiet mode" },
  { value: "open_website", label: "Open website / search" },
  { value: "open_settings_page", label: "Open Windows setting" },
  { value: "get_system_stats", label: "Check system stats" },
  { value: "get_datetime", label: "Get time & date" },
  { value: "power_action", label: "Power (sleep/restart/shutdown)" },
];

const newStep = (): RoutineStep => ({ id: crypto.randomUUID(), tool: "launch_app", args: { name: "" } });

export function RoutineEditor({
  routine,
  onSave,
  onCancel,
}: {
  routine: Routine | null;
  onSave: (r: Routine) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(routine?.name ?? "");
  const [triggers, setTriggers] = useState((routine?.triggers ?? []).join(", "));
  const [steps, setSteps] = useState<RoutineStep[]>(routine?.steps.length ? routine.steps : [newStep()]);
  const [scheduleTime, setScheduleTime] = useState(routine?.schedule?.time ?? "");
  const [days, setDays] = useState<number[]>(routine?.schedule?.days ?? []);

  const patchStep = (i: number, patch: Partial<RoutineStep>) =>
    setSteps((s) => s.map((st, idx) => (idx === i ? { ...st, ...patch } : st)));
  const patchArgs = (i: number, patch: Record<string, unknown>) =>
    setSteps((s) => s.map((st, idx) => (idx === i ? { ...st, args: { ...st.args, ...patch } } : st)));
  const move = (i: number, dir: -1 | 1) =>
    setSteps((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.length) return s;
      const copy = [...s];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed || steps.length === 0) return;
    const trig = triggers.split(",").map((t) => t.trim()).filter(Boolean);
    onSave({
      id: routine?.id ?? crypto.randomUUID(),
      name: trimmed,
      description: routine?.description,
      triggers: trig.length ? trig : [trimmed.toLowerCase()],
      steps,
      enabled: routine?.enabled ?? true,
      builtIn: routine?.builtIn,
      schedule: scheduleTime ? { time: scheduleTime, days } : undefined,
      lastRunAt: routine?.lastRunAt,
    });
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6 backdrop-blur-sm" role="dialog" aria-modal="true">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="glass max-h-[85vh] w-[560px] overflow-y-auto rounded-2xl p-6"
      >
        <h2 className="mb-4 text-lg font-semibold text-glow">{routine ? "Edit routine" : "New routine"}</h2>

        <label className="mb-1 block text-xs uppercase tracking-widest text-slate-400">Name</label>
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Gaming Mode" />

        <label className="mb-1 mt-4 block text-xs uppercase tracking-widest text-slate-400">
          Voice triggers (comma-separated)
        </label>
        <TextInput value={triggers} onChange={(e) => setTriggers(e.target.value)} placeholder="gaming mode, game time" />

        <label className="mb-2 mt-4 block text-xs uppercase tracking-widest text-slate-400">Steps</label>
        <div className="space-y-2">
          {steps.map((s, i) => (
            <div key={s.id} className="rounded-lg border border-white/10 bg-white/5 p-3">
              <div className="flex items-center gap-2">
                <span className="w-5 text-center text-xs text-slate-500">{i + 1}</span>
                <div className="flex-1">
                  <Select
                    ariaLabel={`Step ${i + 1} action`}
                    value={s.tool}
                    onChange={(tool) => patchStep(i, { tool, args: defaultArgs(tool) })}
                    options={TOOL_OPTIONS}
                  />
                </div>
                <button className="px-1 text-slate-400 hover:text-white disabled:opacity-30" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                  ↑
                </button>
                <button className="px-1 text-slate-400 hover:text-white disabled:opacity-30" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label="Move down">
                  ↓
                </button>
                <button className="px-1 text-bev-danger hover:opacity-80" onClick={() => setSteps((st) => st.filter((_, idx) => idx !== i))} aria-label="Remove step">
                  ✕
                </button>
              </div>
              <div className="mt-2 pl-7">
                <ArgEditor step={s} onArgs={(patch) => patchArgs(i, patch)} onDelay={(delayMs) => patchStep(i, { delayMs })} />
              </div>
            </div>
          ))}
        </div>
        <Button variant="ghost" className="mt-2" onClick={() => setSteps((s) => [...s, newStep()])}>
          + Add step
        </Button>

        <label className="mb-1 mt-5 block text-xs uppercase tracking-widest text-slate-400">
          Schedule (optional)
        </label>
        <div className="flex items-center gap-3">
          <input
            type="time"
            className="no-drag rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100"
            value={scheduleTime}
            onChange={(e) => setScheduleTime(e.target.value)}
          />
          <span className="text-xs text-slate-500">
            {scheduleTime ? "fires at this time" : "no schedule"}
          </span>
        </div>
        {scheduleTime && (
          <div className="mt-2">
            <div className="mb-1 text-xs text-slate-500">
              On these days {days.length === 0 && "(every day)"}
            </div>
            <div className="flex gap-1">
              {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d, i) => {
                const on = days.includes(i);
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setDays((ds) => (on ? ds.filter((x) => x !== i) : [...ds, i].sort()))}
                    className={`no-drag h-8 w-9 rounded text-xs transition ${
                      on ? "bg-bev-cyan/25 text-bev-cyan shadow-glow" : "bg-white/5 text-slate-400 hover:bg-white/10"
                    }`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!name.trim()}>
            Save routine
          </Button>
        </div>
      </motion.div>
    </div>
  );
}

function defaultArgs(tool: string): Record<string, unknown> {
  switch (tool) {
    case "launch_app":
    case "close_app":
      return { name: "" };
    case "set_volume":
      return { percent: 40 };
    case "set_muted":
      return { muted: true };
    case "set_quiet_mode":
      return { enabled: true };
    case "open_website":
      return { search: "" };
    case "open_settings_page":
      return { page: "display" };
    case "power_action":
      return { action: "sleep" };
    default:
      return {};
  }
}

function ArgEditor({ step, onArgs, onDelay }: { step: RoutineStep; onArgs: (p: Record<string, unknown>) => void; onDelay: (ms: number) => void }) {
  const a = step.args;
  const common = (
    <input
      type="number"
      min={0}
      step={0.5}
      className="no-drag ml-2 w-20 rounded border border-white/10 bg-white/5 px-2 py-1 text-xs"
      value={(step.delayMs ?? 0) / 1000}
      onChange={(e) => onDelay(Math.max(0, Number(e.target.value)) * 1000)}
      aria-label="Delay before step (seconds)"
    />
  );
  const delay = (
    <div className="mt-2 flex items-center text-xs text-slate-500">
      wait before{common}s
    </div>
  );

  switch (step.tool) {
    case "launch_app":
    case "close_app":
      return (
        <>
          <TextInput placeholder="App name, e.g. Discord" value={String(a.name ?? "")} onChange={(e) => onArgs({ name: e.target.value })} />
          {delay}
        </>
      );
    case "set_volume":
      return (
        <>
          <div className="flex items-center gap-2">
            <input type="range" min={0} max={100} className="no-drag flex-1 accent-cyan-400" value={Number(a.percent ?? 40)} onChange={(e) => onArgs({ percent: Number(e.target.value) })} aria-label="Volume" />
            <span className="w-10 text-right font-mono text-xs">{Number(a.percent ?? 40)}%</span>
          </div>
          {delay}
        </>
      );
    case "set_muted":
      return (
        <div className="flex items-center gap-2 text-sm text-slate-300">
          <Toggle label="Mute" checked={Boolean(a.muted)} onChange={(muted) => onArgs({ muted })} /> {a.muted ? "Mute" : "Unmute"}
          {delay}
        </div>
      );
    case "set_quiet_mode":
      return (
        <div className="flex items-center gap-2 text-sm text-slate-300">
          <Toggle label="Quiet mode" checked={Boolean(a.enabled)} onChange={(enabled) => onArgs({ enabled })} /> {a.enabled ? "On" : "Off"}
          {delay}
        </div>
      );
    case "open_website":
      return (
        <>
          <TextInput placeholder="URL or search terms" value={String(a.url ?? a.search ?? "")} onChange={(e) => onArgs({ search: e.target.value, url: undefined })} />
          {delay}
        </>
      );
    case "open_settings_page":
      return (
        <>
          <TextInput placeholder="display, sound, bluetooth…" value={String(a.page ?? "")} onChange={(e) => onArgs({ page: e.target.value })} />
          {delay}
        </>
      );
    case "power_action":
      return (
        <>
          <Select
            ariaLabel="Power action"
            value={String(a.action ?? "sleep")}
            onChange={(action) => onArgs({ action })}
            options={[
              { value: "sleep", label: "Sleep" },
              { value: "restart", label: "Restart" },
              { value: "shutdown", label: "Shut down" },
            ]}
          />
          {delay}
        </>
      );
    default:
      return delay;
  }
}
