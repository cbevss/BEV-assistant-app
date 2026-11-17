/**
 * BEV's design tokens in code: one source for the state colours and words
 * used by the overlay orb, the Dashboard status line and anywhere else BEV
 * shows what it's doing. See docs/DESIGN.md.
 */
import type { AssistantState } from "@/state/assistant";

export const color = {
  void: "#05070d",
  carbon: "#0a0e17",
  cyan: "#22d3ee",
  blue: "#3b82f6",
  violet: "#8b5cf6",
  ok: "#34d399",
  warn: "#fbbf24",
  danger: "#f43f5e",
} as const;

/** How each assistant state looks and reads. Words are plain, present tense. */
export const stateMeta: Record<AssistantState, { color: string; label: string }> = {
  idle: { color: color.cyan, label: "Ready" },
  activating: { color: "#38e8ff", label: "Waking up" },
  listening: { color: color.cyan, label: "Listening" },
  thinking: { color: color.violet, label: "Thinking" },
  speaking: { color: color.blue, label: "Speaking" },
  executing: { color: color.ok, label: "Working" },
  completed: { color: color.ok, label: "Done" },
  error: { color: color.danger, label: "Something went wrong" },
};
