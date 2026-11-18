import { memo } from "react";
import type { AssistantState } from "@/state/assistant";
import { Emblem } from "@/ui/components/Emblem";
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
 * The overlay: the BEV emblem on its solid plate so it reads over any
 * wallpaper or game, sized for a glance. The welcome screen shows the same emblem. Every change reflects BEV's real state.
 */
function OrbInner({ state, level, accentOverride }: OrbProps) {
  const rgb = accentOverride ? hexToRgb(accentOverride) : null;
  return (
    <div style={rgb ? { ["--accent" as string]: rgb.join(" ") } : undefined}>
      <Emblem state={state} level={level} size={240} floating />
    </div>
  );
}

export const Orb = memo(OrbInner);
