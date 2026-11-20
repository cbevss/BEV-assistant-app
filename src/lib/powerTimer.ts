/**
 * Sleep timer: sleep, shut down or restart the PC later ("shut down in an
 * hour"). Approved when it's set; a minute before, BEV says so and it can be
 * cancelled. Not saved: closing BEV cancels it.
 */
import { create } from "zustand";
import { native } from "./native";
import { alertUser } from "./alerts";
import { clockTime } from "./timers";

export type PowerKind = "sleep" | "shutdown" | "restart";
interface State {
  pending: { action: PowerKind; at: number; warned: boolean } | null;
}
export const usePowerTimer = create<State>(() => ({ pending: null }));

const verb = (a: PowerKind) => (a === "sleep" ? "go to sleep" : a === "shutdown" ? "shut down" : "restart");

export function setPowerTimer(action: PowerKind, at: number) {
  usePowerTimer.setState({ pending: { action, at, warned: false } });
  return `The PC will ${verb(action)} at ${clockTime(at)}. I'll warn you a minute before; say "cancel the sleep timer" to stop it.`;
}

export function cancelPowerTimer(): string {
  const p = usePowerTimer.getState().pending;
  usePowerTimer.setState({ pending: null });
  return p ? `Cancelled: the PC won't ${verb(p.action)}.` : "There's no sleep timer set.";
}

let started = false;
export function startPowerTimer() {
  if (started) return;
  started = true;
  setInterval(async () => {
    const p = usePowerTimer.getState().pending;
    if (!p) return;
    const left = p.at - Date.now();
    if (left <= 60_000 && !p.warned) {
      usePowerTimer.setState({ pending: { ...p, warned: true } });
      await alertUser("Sleep timer", `The PC will ${verb(p.action)} in about a minute.`, { speak: `Heads up: the PC will ${verb(p.action)} in about a minute. Say cancel the sleep timer to stop it.`, toolName: "sleep_timer" });
    }
    if (left <= 0) {
      usePowerTimer.setState({ pending: null });
      await native.powerAction(p.action, p.action === "sleep" ? undefined : 15).catch(() => {});
    }
  }, 5000);
}
