/**
 * Automations → Teach BEV: show it a task once ("watch me"), and see the
 * tasks it has learned by doing them, ready to keep as routines.
 */
import { useEffect, useRef, useState } from "react";
import { Circle, GraduationCap, Save, Square, Trash2 } from "lucide-react";
import { native } from "@/lib/native";
import { useRoutines } from "@/routines/store";
import { useSettings } from "@/state/settings";
import { demonstrationToSteps, type Demonstration } from "@/ai/demonstration";
import { describeSteps, useLearned, type LearnedTask } from "@/ai/learn";
import type { RoutineStep } from "@/routines/types";
import { Section, Field, Button, TextInput, Toggle, IconButton, Notice } from "./Form";

type Phase = { step: "idle" } | { step: "recording"; since: number } | { step: "review"; demo: Demonstration; name: string; phrase: string; from?: string };

export function TeachBev() {
  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  const [events, setEvents] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const learned = useLearned();
  const { settings, update } = useSettings();

  useEffect(() => {
    void learned.load();
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    setErr(null);
    setSaved(null);
    try {
      await native.recordStart();
      setEvents(0);
      setPhase({ step: "recording", since: Date.now() });
      timer.current = setInterval(async () => {
        const s = await native.recordStatus().catch(() => null);
        if (!s) return;
        setEvents(s.events);
        if (!s.recording) void stop(); // hit the time limit
      }, 1000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const stop = async () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    const evs = await native.recordStop().catch(() => []);
    const demo = demonstrationToSteps(evs);
    setPhase({ step: "review", demo, name: "", phrase: "" });
  };

  const review = (task: LearnedTask) =>
    setPhase({ step: "review", demo: { steps: task.steps, skipped: [] }, name: task.example, phrase: task.example.toLowerCase(), from: task.id });

  const keep = async (steps: RoutineStep[], name: string, phrase: string, from?: string) => {
    const routine = {
      id: crypto.randomUUID(),
      name: name.trim() || "Taught task",
      description: from ? "Learned by doing it." : "Shown by you.",
      triggers: phrase.trim() ? [phrase.trim().toLowerCase()] : [],
      steps,
      enabled: true,
      handsOn: true,
    };
    await useRoutines.getState().save(routine);
    if (from) await learned.remove(from);
    setSaved(`Saved “${routine.name}”${routine.triggers.length ? `. Say “${routine.triggers[0]}” to run it.` : "."}`);
    setPhase({ step: "idle" });
  };

  const secs = phase.step === "recording" ? Math.floor((Date.now() - phase.since) / 1000) : 0;

  return (
    <>
      <Section
        title="Teach BEV"
        description="Show BEV a task once and it can repeat it from a phrase. It records which buttons you click and what you type, then you check the steps before saving. Typing in password boxes is never kept, and recording stops by itself after 5 minutes."
      >
        {phase.step === "idle" && (
          <Field label="Show BEV how" hint="Press Start, do the task in your apps as normal, then come back and press Stop.">
            <Button variant="primary" icon={Circle} onClick={start}>
              Start recording
            </Button>
          </Field>
        )}

        {phase.step === "recording" && (
          <Field label="Recording" hint={`Do the task now. ${events} action${events === 1 ? "" : "s"} so far.`}>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 font-mono text-xs text-danger">
                <span className="h-2 w-2 animate-pulse rounded-full bg-danger" aria-hidden />
                <span className="tnum">
                  {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
                </span>
              </span>
              <Button variant="danger" icon={Square} onClick={stop}>
                Stop
              </Button>
            </div>
          </Field>
        )}

        {phase.step === "review" && (
          <div className="space-y-3 px-4 py-4">
            {phase.demo.steps.length === 0 ? (
              <Notice tone="warn">Nothing BEV can repeat was recorded. Try again, clicking named buttons and boxes rather than empty space.</Notice>
            ) : (
              <>
                <p className="text-sm text-ink-2">These are the steps BEV will repeat:</p>
                <ol className="space-y-1 pl-5 text-sm text-ink">
                  {describeSteps(phase.demo.steps).map((s, i) => (
                    <li key={i} className="list-decimal">
                      {s}
                    </li>
                  ))}
                </ol>
              </>
            )}
            {phase.demo.skipped.length > 0 && (
              <p className="text-xs text-ink-3">Left out: {[...new Set(phase.demo.skipped)].join("; ")}.</p>
            )}
            {phase.demo.steps.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <TextInput aria-label="Routine name" placeholder="Name, e.g. Leave the Discord call" className="min-w-[220px] flex-1" value={phase.name} onChange={(e) => setPhase({ ...phase, name: e.target.value })} />
                <TextInput aria-label="Phrase that runs it" placeholder="Phrase, e.g. leave the call" className="min-w-[200px] flex-1" value={phase.phrase} onChange={(e) => setPhase({ ...phase, phrase: e.target.value })} />
              </div>
            )}
            <div className="flex gap-2">
              {phase.demo.steps.length > 0 && (
                <Button variant="primary" icon={Save} onClick={() => keep(phase.demo.steps, phase.name, phase.phrase, phase.from)}>
                  Save routine
                </Button>
              )}
              <Button onClick={() => setPhase({ step: "idle" })}>{phase.demo.steps.length ? "Discard" : "Close"}</Button>
            </div>
          </div>
        )}
        {(err || saved) && <div className="px-4 py-3">{err ? <Notice tone="danger">{err}</Notice> : <Notice tone="ok">{saved}</Notice>}</div>}
      </Section>

      <Section
        title="Learned tasks"
        description="When BEV finishes a task by clicking and typing in apps, it remembers the steps. Ask for the same thing again and it repeats them straight away, checking each one, instead of working it out from scratch."
        aside={<Toggle label="Learn from tasks" checked={settings.learnTasks} onChange={(learnTasks) => update({ learnTasks })} />}
      >
        {learned.tasks.length === 0 ? (
          <Field label="Nothing learned yet" hint="Ask BEV to do something in an app, like “leave the Discord call”, and it'll appear here.">
            <GraduationCap className="h-4 w-4 text-ink-4" aria-hidden />
          </Field>
        ) : (
          learned.tasks.map((t) => (
            <Field key={t.id} label={`“${t.example}”`} hint={`${t.steps.length} steps · used ${t.uses} time${t.uses === 1 ? "" : "s"}: ${describeSteps(t.steps).join(", then ")}`}>
              <div className="flex items-center gap-1">
                <Button size="sm" onClick={() => review(t)}>
                  Save as routine
                </Button>
                <IconButton icon={Trash2} size="sm" label={`Forget “${t.example}”`} onClick={() => learned.remove(t.id)} />
              </div>
            </Field>
          ))
        )}
      </Section>
    </>
  );
}
