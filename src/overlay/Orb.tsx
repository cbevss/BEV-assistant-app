import { memo } from "react";
import type { AssistantState } from "@/state/assistant";
import { Core } from "@/ui/components/Core";
import { hexToRgb } from "@/lib/appearance";

interface OrbProps {
  state: AssistantState;
  /** 0..1 live level from mic (listening) or TTS (speaking). */
  level: number;
  /** User accent (hex) from Appearance. */
  accentOverride?: string;
  /** Kept for the overlay's API; motion follows the reduced-motion rules in CSS. */
  reducedMotion?: boolean;
}

/**
 * The overlay: the BEV Core on a solid plate so it reads over any wallpaper
 * or game, sized for a glance. Every change reflects BEV's real state.
 */
function OrbInner({ state, level, accentOverride }: OrbProps) {
  const rgb = accentOverride ? hexToRgb(accentOverride) : null;
  return (
    <div className="relative grid place-items-center" style={{ width: 240, height: 240, ...(rgb ? { ["--accent" as string]: rgb.join(" ") } : {}) }}>
      <div
        className="grid place-items-center rounded-full border border-line"
        style={{ width: 168, height: 168, background: "rgb(var(--canvas) / 0.94)", boxShadow: "0 10px 30px rgb(0 0 0 / 0.45)" }}
      >
        <Core state={state} level={level} size={124} />
      </div>
    </div>
  );
}

export const Orb = memo(OrbInner);
