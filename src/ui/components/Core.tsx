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
 * With `ambient`, a resting Core (idle or mic off) runs a short scan every 7s
 * (a sweep round the bezel, a centre blip, one turn of the hero ring) so the
 * logo reads as alive. It stops the moment BEV has real work to show.
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
  /** A small idle animation every few seconds (the rail logo and the emblem). */
  ambient?: boolean;
  /** Draw the rings in when it first appears (the emblem). */
  intro?: boolean;
}

export function Core({ state, level = 0, progress = null, size = 32, className, title, ambient = false, intro = false }: CoreProps) {
  const lv = Math.max(0, Math.min(1, level));
  const orbiting = state === "thinking" || state === "activating" || (state === "executing" && progress == null);
  const tone = state === "error" ? "rgb(var(--danger))" : state === "completed" ? "rgb(var(--ok))" : "rgb(var(--accent))";
  const dim = "rgb(var(--ink-4))";
  const detail = size >= 28;
  // Mid-size Cores (56px+) leave room for the scale; large ones become the reactor.
  const hud = size >= 56;
  const active = state !== "idle" && state !== "off" && state !== "completed";
  const resting = ambient && (state === "idle" || state === "off");
  const draw = intro ? "boot-draw" : undefined;
  const delay = (ms: number) => (intro ? { animationDelay: `${ms}ms` } : undefined);

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

  // Hero size (welcome screen, overlay): the reactor. The live bezel shrinks
  // to the middle and is surrounded by concentric instrument rings.
  const hero = size >= 120;
  const k = hero ? 0.6 : 1;
  const ringTone = state === "off" ? dim : tone;
  const ringOp = state === "off" ? 0.35 : active ? 0.75 : 0.32;

  return (
    <svg
      width={size}
      height={size}
      viewBox={hud && !hero ? "-5 -5 110 110" : "0 0 100 100"}
      className={clsx("shrink-0 overflow-visible", className)}
      role="img"
      aria-label={title ?? `BEV is ${state === "off" ? "not listening" : state}`}
    >
      {hero && (
        <g aria-hidden fill="none">
          {/* outer frame: two long arcs with gaps at the poles */}
          <path d={arc(49, 8, 172)} stroke={ringTone} strokeOpacity={ringOp * 0.5} strokeWidth="0.5" pathLength={1} className={draw} style={delay(120)} />
          <path d={arc(49, 188, 352)} stroke={ringTone} strokeOpacity={ringOp * 0.5} strokeWidth="0.5" pathLength={1} className={draw} style={delay(120)} />
          {/* degree scale */}
          <g className={intro ? "boot-fade" : undefined} style={delay(260)}>
          {Array.from({ length: 90 }, (_, i) => {
            const a = (i / 90) * Math.PI * 2 - Math.PI / 2;
            const r1 = i % 15 === 0 ? 42 : i % 5 === 0 ? 43.2 : 44;
            return <line key={i} x1={50 + Math.cos(a) * r1} y1={50 + Math.sin(a) * r1} x2={50 + Math.cos(a) * 45.5} y2={50 + Math.sin(a) * 45.5} stroke={ringTone} strokeOpacity={i % 15 === 0 ? ringOp : ringOp * 0.55} strokeWidth={i % 15 === 0 ? 0.7 : 0.4} />;
          })}
          </g>
          <circle cx="50" cy="50" r="39.5" stroke={ringTone} strokeOpacity={ringOp * 0.6} strokeWidth="0.4" pathLength={1} className={draw} style={delay(200)} />
          {/* segmented ring: turns only while BEV is working */}
          <g className={active ? "animate-orbit" : resting ? "core-ambient-turn" : undefined} style={{ transformBox: "view-box", transformOrigin: "50px 50px", ...(active ? { animationDuration: state === "thinking" || state === "activating" ? "2.6s" : "8s" } : {}) }}>
            <path d={arc(35, 0, 74)} stroke={ringTone} strokeOpacity={ringOp} strokeWidth="1.4" strokeLinecap="round" pathLength={1} className={draw} style={delay(320)} />
            <path d={arc(35, 104, 148)} stroke={ringTone} strokeOpacity={ringOp} strokeWidth="1.4" strokeLinecap="round" pathLength={1} className={draw} style={delay(380)} />
            <path d={arc(35, 178, 300)} stroke={ringTone} strokeOpacity={ringOp} strokeWidth="1.4" strokeLinecap="round" pathLength={1} className={draw} style={delay(440)} />
          </g>
          <g className={active ? "animate-orbit" : undefined} style={{ transformBox: "view-box", transformOrigin: "50px 50px", animationDuration: "14s", animationDirection: "reverse" }}>
            <circle cx="50" cy="50" r="31.5" stroke={ringTone} strokeOpacity={ringOp * 0.7} strokeWidth="0.5" strokeDasharray="1 3" />
          </g>
        </g>
      )}
      <g transform={hero ? `translate(50 50) scale(${k}) translate(-50 -50)` : undefined}>
        {/* bezel */}
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
        {/* ambient scan: one sweep around the bezel every few seconds while resting */}
        {resting && (
          <g className="core-ambient-sweep">
            <path d="M 50 3 A 47 47 0 0 1 82.2 15.8" fill="none" stroke={state === "off" ? dim : "rgb(var(--accent))"} strokeOpacity={state === "off" ? 0.9 : 0.85} strokeWidth={detail ? 3.4 : 5} strokeLinecap="round" />
          </g>
        )}
        {/* orbiting arc for thinking / working without a plan */}
        {orbiting && (
          <g className="animate-orbit" style={{ transformBox: "view-box", transformOrigin: "50px 50px" }}>
            <path d="M 50 3 A 47 47 0 0 1 82.2 15.8" fill="none" stroke={tone} strokeWidth={detail ? 3.6 : 5} strokeLinecap="round" />
          </g>
        )}
        {/* inner ring */}
        {detail && <circle cx="50" cy="50" r="27" fill="none" stroke={state === "idle" || state === "off" ? (hero && state === "idle" ? tone : dim) : tone} strokeOpacity={state === "idle" || state === "off" ? 0.5 : 0.35} strokeWidth="1.6" />}
        {/* centre */}
        <circle cx="50" cy="50" r={centreR} fill={hero && state === "idle" ? tone : centreFill} className={resting ? "core-ambient-blip" : undefined} style={{ transition: "r 80ms linear, fill 160ms" }} />
      </g>
    </svg>
  );
}

/** SVG arc path on the Core's 100×100 grid, angles in degrees clockwise from 12 o'clock. */
function arc(r: number, a0: number, a1: number): string {
  const p = (d: number) => {
    const t = ((d - 90) * Math.PI) / 180;
    return `${(50 + Math.cos(t) * r).toFixed(2)} ${(50 + Math.sin(t) * r).toFixed(2)}`;
  };
  return `M ${p(a0)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${p(a1)}`;
}
