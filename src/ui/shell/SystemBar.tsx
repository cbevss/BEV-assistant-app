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
import { gpuApi, useGaming, type GpuStats } from "@/lib/gaming";
import { useTimers, clockDown, clockTime } from "@/lib/timers";

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

/** GPU readings every few seconds (usage is Windows' own counter; temperature needs an AMD card). */
function useGpu() {
  const [g, setG] = useState<GpuStats | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => gpuApi.stats().then((v) => alive && setG(v)).catch(() => {});
    tick();
    const id = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return g;
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
  const replay = useSettings((x) => x.settings.screenReplay && x.settings.toolPermissions.look_back !== false && !privacyMode);
  const bg = useBackground((b) => b.tasks.filter((t) => t.status === "running").length);
  const s = useStats();
  const gpu = useGpu();
  const now = useClock();
  const timers = useTimers((t) => t.timers);
  const stopwatch = useTimers((t) => t.stopwatch);
  // Countdown timers first, then whatever is soonest.
  const nextTimer = timers.find((t) => t.kind === "timer") ?? timers[0];
  const sw = stopwatch.since ? stopwatch.before + now.getTime() - stopwatch.since : 0;
  const game = useGaming((g) => g.game);
  const autoQuiet = useSettings((x) => x.settings.autoGamingMode || x.settings.gamingQuietMode);
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
          {gpu?.usage != null && <Cell k="GPU" v={`${gpu.usage.toFixed(0).padStart(2, "0")}%`} title={gpu.name ?? undefined} />}
          {gpu?.temp_c != null && (
            <Cell
              k="TEMP"
              v={`${Math.round(gpu.temp_c)}°C`}
              tone={(gpu.hotspot_c ?? gpu.temp_c) >= 95 ? "danger" : (gpu.hotspot_c ?? gpu.temp_c) >= 85 ? "warn" : undefined}
              title={gpu.hotspot_c != null ? `Hotspot ${Math.round(gpu.hotspot_c)}°C` : undefined}
            />
          )}
        </>
      )}
      {game && <Cell k="GAMING" v={autoQuiet ? "QUIET" : "ON"} tone="accent" title={`${game.name}${autoQuiet ? ": BEV is keeping it short" : ""}`} />}
      {nextTimer && <Cell k={nextTimer.kind === "timer" ? "TIMER" : nextTimer.kind === "alarm" ? "ALARM" : "REMIND"} v={nextTimer.kind === "timer" ? clockDown(nextTimer.due - now.getTime()) : clockTime(nextTimer.due)} tone="accent" title={nextTimer.label || undefined} />}
      {sw > 0 && <Cell k="STOPWATCH" v={clockDown(sw)} tone="accent" />}
      {bg > 0 && <Cell k="TASKS" v={String(bg)} tone="accent" />}
      {replay && <Cell k="REPLAY" v="ON" tone="accent" title="Screen replay is keeping the last 15 minutes of the screen your mouse is on, in memory only" />}
      <span className="flex-1" />
      <Cell k="" v={now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} />
    </footer>
  );
}
