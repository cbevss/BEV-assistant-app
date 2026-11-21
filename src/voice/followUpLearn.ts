/**
 * Learns how the user actually follows up, so BEV stops waiting when they're
 * done. Two kinds of reply are tracked separately: ones that asked the user
 * something, and plain statements ("Done."). For each, BEV keeps a running
 * response rate and how quickly the user usually starts talking.
 */

export type ReplyKind = "question" | "statement";

interface Stat {
  /** Share of follow-up windows the user spoke in (moving average, 0..1). */
  rate: number;
  /** Typical delay before they start talking, ms (moving average). */
  delay: number;
  /** Samples seen (capped). */
  n: number;
}
export type FollowUpStats = Record<ReplyKind, Stat>;

const KEY = "bev.followUpStats.v1";
const ALPHA = 0.2;
/** Samples needed before learning changes anything. */
export const MIN_SAMPLES = 5;

export const freshStats = (): FollowUpStats => ({
  question: { rate: 0.9, delay: 2500, n: 0 },
  statement: { rate: 0.4, delay: 2000, n: 0 },
});

export function loadStats(): FollowUpStats {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as FollowUpStats;
      if (p?.question && p?.statement) return p;
    }
  } catch {
    /* unavailable or corrupt: start again */
  }
  return freshStats();
}

function save(s: FollowUpStats) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* unavailable */
  }
}

/** Fold one follow-up window into the stats: `afterMs` is null when the user didn't respond. */
export function learn(stats: FollowUpStats, kind: ReplyKind, afterMs: number | null): FollowUpStats {
  const s = stats[kind];
  const responded = afterMs !== null;
  const next: Stat = {
    rate: s.rate + ALPHA * ((responded ? 1 : 0) - s.rate),
    delay: responded ? s.delay + ALPHA * (Math.min(afterMs, 20_000) - s.delay) : s.delay,
    n: Math.min(s.n + 1, 1000),
  };
  return { ...stats, [kind]: next };
}

export function recordFollowUp(kind: ReplyKind, afterMs: number | null) {
  save(learn(loadStats(), kind, afterMs));
}

/**
 * Adjust a follow-up window from what's been learned. Returns 0 when the user
 * almost never follows up on this kind of reply, so BEV stops listening.
 * Questions always get a window (BEV is waiting on an answer), just a tighter
 * one if the user tends to answer fast.
 */
export function learnedWindow(stats: FollowUpStats, kind: ReplyKind, baseMs: number): number {
  const s = stats[kind];
  if (s.n < MIN_SAMPLES) return baseMs;
  // Long enough for nearly all of their usual delays, never longer than the setting.
  const fit = Math.round(s.delay * 2 + 1500);
  if (kind === "question") return Math.min(baseMs, Math.max(4000, fit));
  if (s.rate < 0.12) return 0;
  // Rarely follows up: keep the window short.
  const cap = s.rate < 0.3 ? 3000 : baseMs;
  return Math.min(cap, Math.max(2500, fit));
}
