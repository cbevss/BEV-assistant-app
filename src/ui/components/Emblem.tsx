/**
 * The BEV emblem: the popup symbol. The hero Core seated in a solid plate with
 * a fine instrument collar. The overlay and the welcome screen both render this
 * component, so the symbol people see on the desktop is the one they see when
 * they open the app.
 *
 * Motion: on first appearance the collar draws itself in, the plate settles
 * and the Core's rings draw in; after that the Core's ambient scan runs every
 * few seconds while BEV is resting.
 */
import clsx from "clsx";
import type { AssistantState } from "@/state/assistant";
import { Core } from "./Core";

export interface EmblemProps {
  state: AssistantState | "off";
  level?: number;
  progress?: number | null;
  /** Outer size in px (collar included). The plate is 70% of it. */
  size?: number;
  /** Drop shadow for floating over a wallpaper or game (overlay only). */
  floating?: boolean;
  /** Keep the emblem moving all the time while resting (the main screen). */
  continuous?: boolean;
  className?: string;
}

export function Emblem({ state, level = 0, progress = null, size = 240, floating = false, continuous = false, className }: EmblemProps) {
  const plate = Math.round(size * 0.7);
  const tone = state === "error" ? "var(--danger)" : state === "completed" ? "var(--ok)" : "var(--accent)";
  const live = state !== "off" && state !== "idle";
  const collarOp = state === "off" ? 0.18 : live ? 0.55 : 0.3;
  return (
    <div className={clsx("relative grid shrink-0 place-items-center", className)} style={{ width: size, height: size }}>
      {/* collar: hairline ring with cardinal marks and short bracket arcs */}
      <svg aria-hidden className="absolute inset-0" width={size} height={size} viewBox="0 0 100 100" fill="none">
        <circle cx="50" cy="50" r="46" stroke={`rgb(${tone})`} strokeOpacity={collarOp * 0.6} strokeWidth="0.25" pathLength={1} className="boot-draw" transform="rotate(-90 50 50)" />
        {[0, 90, 180, 270].map((a, i) => (
          <g key={a} transform={`rotate(${a} 50 50)`} className="boot-fade" style={{ animationDelay: `${380 + i * 70}ms` }}>
            <line x1="50" y1="1.5" x2="50" y2="5.5" stroke={`rgb(${tone})`} strokeOpacity={collarOp * 1.4} strokeWidth="0.5" />
            <path d={arcPath(48.5, -14, -4)} stroke={`rgb(${tone})`} strokeOpacity={collarOp} strokeWidth="0.5" />
            <path d={arcPath(48.5, 4, 14)} stroke={`rgb(${tone})`} strokeOpacity={collarOp} strokeWidth="0.5" />
          </g>
        ))}
        <g className="boot-fade" style={{ animationDelay: "650ms" }}>
          {[45, 135, 225, 315].map((a) => (
            <line key={a} transform={`rotate(${a} 50 50)`} x1="50" y1="3" x2="50" y2="4.6" stroke={`rgb(${tone})`} strokeOpacity={collarOp} strokeWidth="0.35" />
          ))}
        </g>
      </svg>
      {/* plate */}
      <div
        className="boot-in relative grid place-items-center rounded-full border border-line"
        style={{
          width: plate,
          height: plate,
          background: "rgb(var(--canvas) / 0.94)",
          boxShadow: floating ? "0 10px 30px rgb(0 0 0 / 0.45)" : "inset 0 0 0 4px rgb(var(--surface-1))",
        }}
      >
        <Core state={state} level={level} progress={progress} size={Math.round(plate * 0.94)} ambient={!continuous} continuous={continuous} intro />
      </div>
    </div>
  );
}

function arcPath(r: number, a0: number, a1: number): string {
  const p = (d: number) => {
    const t = ((d - 90) * Math.PI) / 180;
    return `${(50 + Math.cos(t) * r).toFixed(2)} ${(50 + Math.sin(t) * r).toFixed(2)}`;
  };
  return `M ${p(a0)} A ${r} ${r} 0 0 1 ${p(a1)}`;
}
