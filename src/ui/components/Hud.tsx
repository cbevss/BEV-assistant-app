/**
 * HUD primitives: the technical layer that gives BEV its instrument feel.
 * Flat lines and real readouts only — no glow, no gradients, no fake data.
 */
import { ReactNode, useEffect, useState } from "react";
import clsx from "clsx";

/** Thin corner brackets around content, like a targeting frame. */
export function HudFrame({ children, className, tone = "line", size = 8 }: { children: ReactNode; className?: string; tone?: "line" | "accent"; size?: number }) {
  const c = tone === "accent" ? "border-accent/70" : "border-line-strong";
  const s = { width: size, height: size };
  return (
    <div className={clsx("relative", className)}>
      <span aria-hidden className={clsx("pointer-events-none absolute -left-1 -top-1 border-l border-t", c)} style={s} />
      <span aria-hidden className={clsx("pointer-events-none absolute -right-1 -top-1 border-r border-t", c)} style={s} />
      <span aria-hidden className={clsx("pointer-events-none absolute -bottom-1 -left-1 border-b border-l", c)} style={s} />
      <span aria-hidden className={clsx("pointer-events-none absolute -bottom-1 -right-1 border-b border-r", c)} style={s} />
      {children}
    </div>
  );
}

/** A small technical label: mono, tracked, upper case. Only for HUD readouts. */
export function HudLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx("font-mono text-[10px] uppercase tracking-[0.14em] text-ink-3", className)}>{children}</span>;
}

/** Label + value pair for live readouts. */
export function Readout({ label, value, tone, className }: { label: string; value: ReactNode; tone?: "accent" | "warn" | "danger" | "ok"; className?: string }) {
  return (
    <div className={clsx("min-w-0", className)}>
      <HudLabel>{label}</HudLabel>
      <div
        className={clsx(
          "tnum mt-0.5 truncate font-mono text-sm",
          tone === "accent" ? "text-accent" : tone === "warn" ? "text-warn" : tone === "danger" ? "text-danger" : tone === "ok" ? "text-ok" : "text-ink"
        )}
      >
        {value}
      </div>
    </div>
  );
}

/** A horizontal measurement scale: ticks every 10%, a filled run for the value. */
export function Scale({ value, tone = "accent", label }: { value: number; tone?: "accent" | "warn"; label: string }) {
  const v = Math.max(0, Math.min(100, value));
  // Fill from zero when the meter first appears, then follow the live value.
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(v));
    return () => cancelAnimationFrame(id);
  }, [v]);
  return (
    <div className="relative h-2.5" role="meter" aria-label={label} aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <div className="absolute inset-x-0 bottom-0 h-px bg-line" />
      {Array.from({ length: 11 }, (_, i) => (
        <div key={i} className="absolute bottom-0 w-px bg-line-strong" style={{ left: `${i * 10}%`, height: i % 5 === 0 ? 6 : 3 }} />
      ))}
      <div className={clsx("absolute bottom-0 left-0 h-[3px] transition-[width] duration-[600ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]", tone === "warn" ? "bg-warn" : "bg-accent")} style={{ width: `${shown}%` }} />
    </div>
  );
}
