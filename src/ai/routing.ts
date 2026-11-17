/**
 * Model routing: quick, simple turns go to a faster model; anything that
 * needs planning, several tools, reasoning or a screenshot stays on the
 * main model. Pure, so it's tested.
 */
import type { Settings } from "@/state/settings";
import type { AiMessage } from "./types";

export type Workload = "quick" | "complex" | "vision";

const COMPLEX = /\b(research|compare|investigate|troubleshoot|diagnos\w*|fix|why (is|does|won'?t|isn'?t|can'?t)|plan|organi[sz]e|summari[sz]e|write|draft|explain|analy[sz]e|figure out|find out|step by step|set up|install|configure|debug|code|script|then|after that|and also|every|schedule|background)\b/i;

/** What kind of turn this is, from the request and what's happened so far in it. */
export function classify(userText: string, turn: readonly AiMessage[], opts: { hasPlan?: boolean; background?: boolean } = {}): Workload {
  if (turn.some((m) => m.images?.length)) return "vision";
  if (opts.background || opts.hasPlan) return "complex";
  const words = userText.trim().split(/\s+/).filter(Boolean).length;
  if (words > 22 || COMPLEX.test(userText)) return "complex";
  // Several tool rounds already: it's turned into a real task.
  const toolRounds = turn.filter((m) => m.role === "assistant" && m.toolCalls?.length).length;
  if (toolRounds >= 2) return "complex";
  // Tool results that failed deserve the stronger model to recover.
  if (turn.some((m) => m.role === "tool" && /^error:|declined|couldn'?t|failed/i.test(m.content))) return "complex";
  return "quick";
}

/** The model to use, or undefined for the provider's default (main) model. */
export function modelFor(s: Settings, w: Workload): string | undefined {
  if (!s.modelRouting || w !== "quick") return undefined;
  const fast = s.provider === "openai" ? s.openaiFastModel : s.provider === "ollama" ? s.ollamaFastModel : s.anthropicFastModel;
  return fast?.trim() || undefined;
}

export const maxTokensFor = (w: Workload) => (w === "quick" ? 800 : 2048);
