/**
 * Something the user asked to be told about (a timer, an alarm, a watch):
 * a Windows notification, a chime, a line in the chat (which phone control
 * mirrors to the phone) and, unless BEV is busy, a spoken announcement.
 * Unlike BEV's own observations these aren't held back while gaming.
 */
import { notify } from "./notify";
import { useAssistant } from "@/state/assistant";
import { playChime } from "@/voice/sounds";

interface AlertDeps {
  /** Speak a line; false if BEV was busy and didn't. */
  announce: (text: string) => Promise<boolean>;
}
let deps: AlertDeps | null = null;
export function configureAlerts(d: AlertDeps) {
  deps = d;
}

/** Alerts that went off while the user was away, for a summary when they're back. */
let away = false;
let missed: string[] = [];

/** Pure: the "while you were away" line. */
export function awaySummary(items: string[]): string | null {
  if (!items.length) return null;
  const uniq = [...new Set(items)];
  const list = uniq.length === 1 ? uniq[0] : `${uniq.slice(0, -1).join(", ")} and ${uniq[uniq.length - 1]}`;
  return `While you were away: ${list}.`;
}

export const awayNow = () => away;

/** Called by the idle check: away (no input for a while) or back. */
export async function setAway(isAway: boolean, quiet: boolean) {
  if (isAway === away) return;
  away = isAway;
  if (isAway) {
    missed = [];
    return;
  }
  const line = awaySummary(missed);
  missed = [];
  if (line && deps && !quiet) {
    useAssistant.getState().pushMessage({ role: "assistant", content: line });
    await deps.announce(line).catch(() => false);
  }
}

export async function alertUser(title: string, body: string, opts: { speak?: string; toolName?: string } = {}) {
  if (away) missed.push((body || title).replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase()));
  playChime("done", true);
  void notify(title, body);
  useAssistant.getState().pushMessage({ role: "tool", content: `${title}${body ? `: ${body}` : ""}`, toolName: opts.toolName ?? "alert", ok: true });
  if (opts.speak && deps) await deps.announce(opts.speak).catch(() => false);
}
