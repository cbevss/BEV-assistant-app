/**
 * Turn-taking: knowing when the user has finished a sentence, whether BEV
 * should keep listening after it replies, and whether something it overheard
 * was meant for it (or for friends on a Discord call).
 *
 * The rules are plain functions so they can be tested; the quick AI check for
 * when they aren't sure lives in addressee.ts.
 */
import type { Settings } from "@/state/settings";

export type FollowUpMode = "smart" | "always" | "off";

const words = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Words that mean the sentence isn't finished yet ("open Spotify and…"). */
const CONTINUES = new Set([
  "and", "but", "or", "so", "because", "cos", "then", "if", "when", "while", "with", "without", "to", "for", "of",
  "the", "a", "an", "my", "your", "its", "this", "that", "on", "in", "at", "from", "into", "about", "like",
  "um", "uh", "erm", "er", "hmm", "also", "plus", "is", "are", "was", "can", "could", "should", "would", "will",
]);

/**
 * How long a pause ends the user's turn, given what they've said so far.
 * A finished-sounding sentence ends quickly; a trailing "and…" or "um" waits.
 */
export function endOfSpeechMs(partial: string, base: number): number {
  const w = words(partial);
  if (w.length === 0) return base;
  const last = w[w.length - 1];
  if (CONTINUES.has(last)) return Math.min(base + 900, 2600);
  if (/[.?!]\s*$/.test(partial.trim()) || w.length >= 3) return Math.max(700, base - 300);
  return base;
}

export interface FollowUpPlan {
  /** Keep listening after this reply at all. */
  listen: boolean;
  /** How long to wait for the user to start talking. */
  windowMs: number;
  /** Treat whatever is heard as meant for BEV (BEV asked something). */
  expectAnswer: boolean;
}

/** Did BEV's reply end by asking the user something? */
export function asksQuestion(reply: string): boolean {
  const last = reply.trim().split(/(?<=[.!?])\s+/).pop() ?? "";
  return /\?\s*$/.test(last);
}

/**
 * Whether to keep listening after BEV replies. In smart mode BEV listens
 * properly only when it asked a question; otherwise it gives a short window
 * and checks that anything it hears is really for it.
 */
export function followUpPlan(reply: string, s: Pick<Settings, "followUpMode" | "conversationTimeoutMs">): FollowUpPlan {
  const full = s.conversationTimeoutMs;
  if (s.followUpMode === "off") return { listen: false, windowMs: 0, expectAnswer: false };
  if (s.followUpMode === "always") return { listen: true, windowMs: full, expectAnswer: true };
  if (asksQuestion(reply)) return { listen: true, windowMs: full, expectAnswer: true };
  return { listen: true, windowMs: Math.min(full, 4000), expectAnswer: false };
}

const TO_FRIENDS =
  /\b(bro|bruv|bruh|mate|mates|guys|lads|boys|dude|fam|you lot|y'all|yall|hold on|one sec|wait wait|did you see|look at him|he's|she's|they're|he is|she is|they are|lol|lmao)\b/;
const TO_BEV_START =
  /^(open|close|launch|start|stop|play|pause|resume|skip|next|previous|turn|set|mute|unmute|volume|search|find|look|check|show|tell|read|send|remind|save|remember|what|what's|whats|how|why|when|where|who|which|can you|could you|will you|would you|please|and|also|now|then|ok so|okay so|actually)\b/;
const ANSWERS = /^(yes|yeah|yep|yup|no|nope|nah|sure|go on|go ahead|do it|ok|okay|please|correct|right|that one|the first|the second|the last)\b/;

export type Addressee = "bev" | "other" | "unsure";

/** Quick rules for "was that meant for BEV?". */
export function addresseeHeuristic(utterance: string, expectAnswer: boolean): Addressee {
  const u = utterance.toLowerCase().trim();
  if (!u) return "other";
  if (/\bbev\b/.test(u)) return "bev";
  if (TO_FRIENDS.test(u)) return "other";
  if (expectAnswer && ANSWERS.test(u)) return "bev";
  if (TO_BEV_START.test(u)) return expectAnswer ? "bev" : "unsure";
  return expectAnswer ? "unsure" : "unsure";
}

/**
 * A spoken answer to "should I go ahead?". Anything with a no in it counts as
 * no (safer when it's mixed, like "yeah, no"); null when it's neither.
 */
export function parseYesNo(heard: string): boolean | null {
  const u = heard.toLowerCase().replace(/[^a-z' ]/g, " ").replace(/\s+/g, " ").trim();
  if (!u) return null;
  if (/\b(no|nope|nah|don't|dont|do not|stop|cancel|wait|hold on|leave it|never mind|nevermind|deny|not)\b/.test(u)) return false;
  if (/\b(yes|yeah|yep|yup|ya|sure|ok|okay|go ahead|go for it|do it|allow|approve|confirm|correct|affirmative|please)\b/.test(u)) return true;
  return null;
}

/** The approval prompt's text, shortened to one spoken question. */
export function spokenApproval(description: string): string {
  const first = description.split("(")[0].trim().split(/(?<=[.!?])\s+/)[0] ?? description;
  const s = first.replace(/^BEV wants to\s+/i, "I need your OK to ").replace(/\.$/, "");
  return `${s}. Should I go ahead?`;
}
