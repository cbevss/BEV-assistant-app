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

export async function alertUser(title: string, body: string, opts: { speak?: string; toolName?: string } = {}) {
  playChime("done", true);
  void notify(title, body);
  useAssistant.getState().pushMessage({ role: "tool", content: `${title}${body ? `: ${body}` : ""}`, toolName: opts.toolName ?? "alert", ok: true });
  if (opts.speak && deps) await deps.announce(opts.speak).catch(() => false);
}
