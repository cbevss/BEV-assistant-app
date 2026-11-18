/**
 * The system bar along the bottom of the window: BEV's state and the PC's
 * vital signs as live technical readouts. Everything shown is measured.
 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { native, type SystemStats } from "@/lib/native";
import { useAssistant } from "@/state/assistant";
import { useSettings } from "@/state/settings";
import { useBackground } from "@/ai/background";
import { stateMeta } from "../design";

function useStats() {
  const [s, setS] = useState<SystemStats | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => native.getSystemStats().then((v) => alive && setS(v)).catch(() => {});
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return s;
}

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const Cell = ({ k, v, tone, title }: { k: string; v: string; tone?: "accent" | "warn" | "danger"; title?: string }) => (
  <span className="flex items-center gap-1.5 whitespace-nowrap px-3" title={title}>
    <span className="text-ink-4">{k}</span>
    <span className={clsx("tnum", tone === "accent" ? "text-accent" : tone === "warn" ? "text-warn" : tone === "danger" ? "text-danger" : "text-ink-2")}>{v}</span>
  </span>
);

export function SystemBar() {
  const { state, micEnabled, privacyMode } = useAssistant();
  const { settings } = useSettings();
  const bg = useBackground((b) => b.tasks.filter((t) => t.status === "running").length);
  const s = useStats();
  const now = useClock();
  const model = settings.provider === "openai" ? settings.openaiModel : settings.provider === "ollama" ? settings.ollamaModel : settings.anthropicModel;
  const active = state !== "idle";
  const label = privacyMode ? "PRIVACY" : state === "idle" ? (micEnabled ? "STANDBY" : "MIC OFF") : state === "error" ? "FAULT" : stateMeta[state].label.toUpperCase();

  return (
    <footer className="flex h-6 shrink-0 items-center border-t border-line-subtle bg-rail font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3" aria-label="System status">
      <span className="flex items-center gap-2 px-3">
        <span className={clsx("h-1.5 w-1.5 rounded-full", state === "error" ? "bg-danger" : active ? "bg-accent animate-breathe" : micEnabled && !privacyMode ? "bg-ok" : "bg-ink-4")} aria-hidden />
        <span className={clsx(state === "error" ? "text-danger" : active ? "text-accent" : "text-ink-2")}>{label}</span>
      </span>
      <span className="h-3 w-px bg-line" aria-hidden />
      {s && (
        <>
          <Cell k="CPU" v={`${s.cpu_usage.toFixed(0).padStart(2, "0")}%`} tone={s.cpu_usage >= 90 ? "warn" : undefined} />
          <Cell k="MEM" v={`${(s.mem_used_mb / 1024).toFixed(1)}/${(s.mem_total_mb / 1024).toFixed(0)}G`} tone={s.mem_percent >= 90 ? "warn" : undefined} />
          {s.gpu_usage != null && <Cell k="GPU" v={`${s.gpu_usage.toFixed(0)}%`} />}
          <span className="max-[900px]:hidden">
            <Cell k="UP" v={fmtUp(s.uptime_secs)} />
          </span>
        </>
      )}
      {bg > 0 && <Cell k="TASKS" v={String(bg)} tone="accent" />}
      <span className="flex-1" />
      <span className="max-[1000px]:hidden">
        <Cell k="MODEL" v={model} title={`${settings.provider} · ${model}`} />
      </span>
      <span className="h-3 w-px bg-line" aria-hidden />
      <Cell k="" v={now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} />
    </footer>
  );
}

function fmtUp(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}D ${String(h).padStart(2, "0")}H` : `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
