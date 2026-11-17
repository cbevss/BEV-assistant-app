/**
 * The Dashboard's status line: what BEV is doing right now, in words, with a
 * live trace of the microphone or voice level in the current state's colour.
 * Every value shown is read from live state; nothing is decorative filler.
 */
import { useEffect, useRef, useState } from "react";
import { useAssistant } from "@/state/assistant";
import { useSettings } from "@/state/settings";
import { useBackground } from "@/ai/background";
import { progress } from "@/ai/plan";
import { stateMeta } from "../design";

const SAMPLES = 64;

function useLevelTrace(active: boolean): number[] {
  const [trace, setTrace] = useState<number[]>(() => Array(SAMPLES).fill(0));
  const buf = useRef<number[]>(Array(SAMPLES).fill(0));
  useEffect(() => {
    if (!active) {
      buf.current = Array(SAMPLES).fill(0);
      setTrace(buf.current);
      return;
    }
    const id = setInterval(() => {
      const v = useAssistant.getState().audioLevel;
      buf.current = [...buf.current.slice(1), Math.max(0, Math.min(1, v))];
      setTrace(buf.current);
    }, 50);
    return () => clearInterval(id);
  }, [active]);
  return trace;
}

function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function StatusHud() {
  const { state, statusText, micEnabled, privacyMode, wake, plan } = useAssistant();
  const { settings } = useSettings();
  const running = useBackground((s) => s.tasks.filter((t) => t.status === "running").length);
  const meta = stateMeta[state];
  const live = (state === "listening" || state === "speaking") && !prefersReducedMotion();
  const trace = useLevelTrace(live);

  let headline: string;
  if (privacyMode) headline = "Privacy mode is on, so the microphone is off";
  else if (state === "idle") headline = micEnabled ? "Waiting for the wake word" : "The microphone is off. Type in Chat, or turn it on.";
  else headline = statusText?.trim() || meta.label;

  const openPlan = plan && plan.length ? plan : null;
  const p = openPlan ? progress(openPlan) : null;
  const current = openPlan?.find((s) => s.status === "in_progress");

  const mainModel = settings.provider === "openai" ? settings.openaiModel : settings.provider === "ollama" ? settings.ollamaModel : settings.anthropicModel;
  const fastModel = settings.provider === "openai" ? settings.openaiFastModel : settings.provider === "ollama" ? settings.ollamaFastModel : settings.anthropicFastModel;

  // Trace geometry: a centred bar per sample, height from level.
  const W = 640;
  const H = 36;
  const bw = W / SAMPLES;

  return (
    <section aria-label="BEV status" aria-live="polite" className="grid gap-x-10 gap-y-4 md:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-9 w-full" preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" x2={W} y1={H / 2} y2={H / 2} stroke={meta.color} strokeOpacity={0.35} strokeWidth="1" />
          {live &&
            trace.map((v, i) => {
              const h = Math.max(1, v * (H - 4));
              return <rect key={i} x={i * bw + bw * 0.2} width={bw * 0.6} y={(H - h) / 2} height={h} rx={bw * 0.3} fill={meta.color} opacity={0.35 + (i / SAMPLES) * 0.65} />;
            })}
          <circle cx={live ? W - bw / 2 : 4} cy={H / 2} r="4" fill={meta.color} />
        </svg>
        <p className="mt-3 text-xl font-medium text-slate-100" style={{ textWrap: "balance" } as React.CSSProperties}>
          {headline}
        </p>
        {openPlan && p && (
          <p className="mt-1 text-sm text-slate-400">
            {current ? `Step ${openPlan.indexOf(current) + 1} of ${openPlan.length}: ${current.text}` : `${p.done} of ${p.total} steps done`}
          </p>
        )}
        {wake?.note && <p className="mt-1 text-sm text-amber-300">{wake.note}</p>}
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 self-end text-sm">
        <dt className="text-slate-500">Wake word</dt>
        <dd className="truncate text-slate-200">{wake ? (wake.engine === "on-device" ? "On this PC" : "Windows speech") : "Not listening"}</dd>
        <dt className="text-slate-500">Speech</dt>
        <dd className="truncate text-slate-200">{settings.sttEngine === "whisper" ? `Whisper ${settings.whisperSize}, on this PC` : "Windows (online)"}</dd>
        <dt className="text-slate-500">Replies</dt>
        <dd className="truncate text-slate-200" title={mainModel}>
          {mainModel}
          {settings.modelRouting && fastModel ? <span className="text-slate-500">, quick ones on {fastModel}</span> : null}
        </dd>
        <dt className="text-slate-500">In the background</dt>
        <dd className="text-slate-200">{running ? `${running} task${running === 1 ? "" : "s"} running` : "Nothing"}</dd>
      </dl>
    </section>
  );
}
