/**
 * BEV's design tokens in code: one source for the state colours and words
 * used by the overlay orb, the Dashboard status line and anywhere else BEV
 * shows what it's doing. See docs/DESIGN.md.
 */
import type { AssistantState } from "@/state/assistant";

export const color = {
  canvas: "#0E1014",
  accent: "#4ECDDE",
  accentStrong: "#84E0EC",
  ink3: "#6D7786",
  ok: "#3DC98A",
  warn: "#E8B04B",
  danger: "#EF5B5B",
} as const;

/**
 * How each assistant state looks and reads. BEV has one signal colour; states
 * differ by motion and words (see Core.tsx), not by a rainbow of hues.
 */
export const stateMeta: Record<AssistantState, { color: string; label: string }> = {
  idle: { color: color.ink3, label: "Ready" },
  activating: { color: color.accentStrong, label: "Waking up" },
  listening: { color: color.accent, label: "Listening" },
  thinking: { color: color.accent, label: "Thinking" },
  speaking: { color: color.accent, label: "Speaking" },
  executing: { color: color.accent, label: "Working" },
  completed: { color: color.ok, label: "Done" },
  error: { color: color.danger, label: "Something went wrong" },
};
