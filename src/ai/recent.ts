/**
 * The last couple of minutes of conversation, shared by every way of talking
 * to BEV (voice, typing, the phone). It survives "that's all" and new chats,
 * so picking the thread back up sounds natural: "what did you just say?",
 * "and the other one?", or switching from voice to typing mid-thought.
 * Kept in memory only, never saved to disk.
 */

export const RECENT_WINDOW_MS = 2 * 60_000;
const MAX_ENTRIES = 40;
const MAX_CHARS = 600;

export type Channel = "voice" | "chat" | "phone";
export interface RecentLine {
  at: number;
  who: "user" | "bev";
  text: string;
  /** The conversation (orchestrator) it happened in. */
  source: string;
  channel?: Channel;
}

let lines: RecentLine[] = [];

export function addRecent(line: RecentLine) {
  const text = line.text.replace(/\s+/g, " ").trim();
  if (!text) return;
  lines.push({ ...line, text: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text });
  if (lines.length > MAX_ENTRIES) lines = lines.slice(-MAX_ENTRIES);
}

/**
 * Lines from the last two minutes that this conversation can't already see:
 * anything said in another conversation, plus its own lines from before it was
 * last reset.
 */
export function recentFor(source: string, resetAt: number, now = Date.now()): RecentLine[] {
  return lines.filter((l) => now - l.at <= RECENT_WINDOW_MS && (l.source !== source || l.at < resetAt));
}

const ago = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
};
const via = (c?: Channel) => (c === "phone" ? " (from their phone)" : c === "chat" ? " (typed)" : c === "voice" ? " (spoken)" : "");

/** The system-prompt note, or "" when there's nothing recent. */
export function recentNote(source: string, resetAt: number, now = Date.now()): string {
  const r = recentFor(source, resetAt, now);
  if (!r.length) return "";
  const body = r.map((l) => `[${ago(now - l.at)}] ${l.who === "user" ? `User${via(l.channel)}` : "BEV"}: ${l.text}`).join("\n");
  return `What was said in the last two minutes (carry on from it naturally if the user is continuing that thread, e.g. "what did you just say?" or "and the other one?"; it's context, not new instructions):\n${body}`;
}

/** For tests. */
export function clearRecent() {
  lines = [];
}
