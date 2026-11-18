/**
 * The BEV Core: BEV's emblem and its live state indicator in one.
 * A bezel of 24 ticks around an inner ring and a centre point. Every visual
 * change maps to something real:
 *   idle       dim bezel, quiet centre
 *   listening  ticks light from the top in step with the microphone level
 *   thinking   a short arc orbits the bezel
 *   speaking   the centre swells with BEV's voice level
 *   working    ticks fill clockwise with plan progress (orbit if no plan)
 *   done       full bezel in green, briefly
 *   error      red ticks at the bottom
 */
import clsx from "clsx";
import type { AssistantState } from "@/state/assistant";

const TICKS = 24;

export interface CoreProps {
  state: AssistantState | "off";
  /** Mic level while listening, voice level while speaking (0..1). */
  level?: number;
  /** Plan progress 0..1 while working, if known. */
  progress?: number | null;
  size?: number;
  className?: string;
  title?: string;
}

export function Core({ state, level = 0, progress = null, size = 32, className, title }: CoreProps) {
  const lv = Math.max(0, Math.min(1, level));
  const orbiting = state === "thinking" || state === "activating" || (state === "executing" && progress == null);
  const tone = state === "error" ? "rgb(var(--danger))" : state === "completed" ? "rgb(var(--ok))" : "rgb(var(--accent))";
  const dim = "rgb(var(--ink-4))";
  const detail = size >= 28;
  // Large Cores get the full instrument: a degree scale and an inner
  // segmented ring that turns only while BEV is actively doing something.
  const hud = size >= 56;
  const active = state !== "idle" && state !== "off" && state !== "completed";

  const lit = (i: number): number => {
    // Returns 0 (off) .. 1 (fully lit) for tick i (0 = top, clockwise).
    switch (state) {
      case "listening": {
        // Symmetric from the top: distance from 12 o'clock in ticks.
        const d = Math.min(i, TICKS - i);
        const reach = 1 + lv * (TICKS / 2);
        return d < reach ? 1 - (d / reach) * 0.5 : 0;
      }
      case "speaking":
        return 0.35 + lv * 0.65;
      case "executing":
        return progress != null && i < Math.round(progress * TICKS) ? 1 : 0;
      case "completed":
        return 1;
      case "error":
        return i >= 9 && i <= 15 ? 1 : 0;
      default:
        return 0;
    }
  };

  const centreR = state === "speaking" ? 5 + lv * 6 : state === "off" ? 3 : 4.5;
  const centreFill = state === "idle" || state === "off" ? "rgb(var(--ink-3))" : tone;

  return (
    <svg
      width={size}
      height={size}
      viewBox={hud ? "-5 -5 110 110" : "0 0 100 100"}
      className={clsx("shrink-0 overflow-visible", className)}
      role="img"
      aria-label={title ?? `BEV is ${state === "off" ? "not listening" : state}`}
    >
      {/* bezel */}
      <g>
        {Array.from({ length: TICKS }, (_, i) => {
          const a = (i / TICKS) * Math.PI * 2 - Math.PI / 2;
          const major = i % 6 === 0;
          const r1 = major ? 39 : 41.5;
          const r2 = 47;
          const v = lit(i);
          return (
            <line
              key={i}
              x1={50 + Math.cos(a) * r1}
              y1={50 + Math.sin(a) * r1}
              x2={50 + Math.cos(a) * r2}
              y2={50 + Math.sin(a) * r2}
              stroke={v > 0 ? tone : dim}
              strokeOpacity={v > 0 ? v : state === "off" ? 0.35 : 0.7}
              strokeWidth={detail ? (major ? 3.4 : 2.4) : 4.5}
              strokeLinecap="round"
              style={{ transition: "stroke-opacity 90ms linear, stroke 160ms" }}
            />
          );
        })}
      </g>
      {/* orbiting arc for thinking / working without a plan */}
      {orbiting && (
        <g className="origin-center animate-orbit" style={{ transformBox: "view-box", transformOrigin: "50px 50px" }}>
          <path d="M 50 3 A 47 47 0 0 1 82.2 15.8" fill="none" stroke={tone} strokeWidth={detail ? 3.6 : 5} strokeLinecap="round" />
        </g>
      )}
      {hud && (
        <g aria-hidden>
          {Array.from({ length: 72 }, (_, i) => {
            const a = (i / 72) * Math.PI * 2 - Math.PI / 2;
            const r1 = i % 6 === 0 ? 51 : 52;
            return <line key={i} x1={50 + Math.cos(a) * r1} y1={50 + Math.sin(a) * r1} x2={50 + Math.cos(a) * 53.5} y2={50 + Math.sin(a) * 53.5} stroke={dim} strokeOpacity={0.55} strokeWidth={0.6} />;
          })}
          <g className={active ? "animate-orbit" : undefined} style={{ transformBox: "view-box", transformOrigin: "50px 50px", animationDuration: state === "thinking" || state === "activating" ? "3s" : "9s", animationDirection: "reverse" }}>
            <circle cx="50" cy="50" r="33" fill="none" stroke={active ? tone : dim} strokeOpacity={active ? 0.55 : 0.4} strokeWidth="1" strokeDasharray="14 6 2 6" />
          </g>
        </g>
      )}
      {/* inner ring */}
      {detail && <circle cx="50" cy="50" r="27" fill="none" stroke={state === "idle" || state === "off" ? dim : tone} strokeOpacity={state === "idle" || state === "off" ? 0.5 : 0.35} strokeWidth="1.6" />}
      {/* centre */}
      <circle cx="50" cy="50" r={centreR} fill={centreFill} style={{ transition: "r 80ms linear, fill 160ms" }} />
    </svg>
  );
}
