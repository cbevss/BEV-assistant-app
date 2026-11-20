/**
 * Focus sessions: a timed stretch where BEV keeps replies short and holds
 * back its own pop-ups, optionally in Pomodoro rounds with breaks. Ends with
 * a spoken heads-up. Not saved: a restart ends the session.
 */
import { create } from "zustand";
import { alertUser } from "./alerts";
import { formatDuration } from "./timers";

export interface FocusSession {
  label: string;
  phase: "focus" | "break";
  endsAt: number;
  round: number;
  rounds: number;
  focusMin: number;
  breakMin: number;
  startedAt: number;
}

interface FocusState {
  session: FocusSession | null;
}
export const useFocus = create<FocusState>(() => ({ session: null }));

export const focusing = () => useFocus.getState().session?.phase === "focus";

/** Pure: what happens when the current phase ends. */
export function nextPhase(s: FocusSession, now: number): { next: FocusSession | null; say: string } {
  if (s.phase === "focus") {
    if (s.round >= s.rounds) return { next: null, say: `Focus session done: ${formatDuration(s.focusMin * s.rounds * 60_000)} of focus${s.label ? ` on ${s.label}` : ""}. Nice work.` };
    return { next: { ...s, phase: "break", endsAt: now + s.breakMin * 60_000 }, say: `Round ${s.round} of ${s.rounds} done. Take a ${s.breakMin} minute break.` };
  }
  return { next: { ...s, phase: "focus", round: s.round + 1, endsAt: now + s.focusMin * 60_000 }, say: `Break's over. Round ${s.round + 1} of ${s.rounds}, ${s.focusMin} minutes.` };
}

export function startFocus(opts: { minutes?: number; rounds?: number; breakMinutes?: number; label?: string }, now = Date.now()): FocusSession {
  const focusMin = Math.min(Math.max(Math.round(opts.minutes ?? 25), 1), 240);
  const rounds = Math.min(Math.max(Math.round(opts.rounds ?? 1), 1), 12);
  const breakMin = Math.min(Math.max(Math.round(opts.breakMinutes ?? 5), 1), 60);
  const session: FocusSession = { label: opts.label?.trim() ?? "", phase: "focus", endsAt: now + focusMin * 60_000, round: 1, rounds, focusMin, breakMin, startedAt: now };
  useFocus.setState({ session });
  return session;
}

export function stopFocus(): FocusSession | null {
  const s = useFocus.getState().session;
  useFocus.setState({ session: null });
  return s;
}

let ticking: ReturnType<typeof setInterval> | null = null;
export function startFocusClock() {
  if (ticking) return;
  ticking = setInterval(async () => {
    const s = useFocus.getState().session;
    if (!s || Date.now() < s.endsAt) return;
    const { next, say } = nextPhase(s, Date.now());
    useFocus.setState({ session: next });
    await alertUser(next ? (next.phase === "break" ? "Break time" : "Back to it") : "Focus session done", say, { speak: say, toolName: "focus" });
  }, 1000);
}
