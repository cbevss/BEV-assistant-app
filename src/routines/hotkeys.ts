/**
 * Global keyboard shortcuts for routines: press the keys anywhere (even in a
 * game) and the routine runs, with the usual approval checks.
 */
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { useRoutines } from "./store";
import { runRoutine, summariseRun } from "./engine";
import { useAssistant } from "@/state/assistant";
import { useSettings } from "@/state/settings";
import type { Routine } from "./types";

/** Pure: why this shortcut can't be used for this routine, or null. */
export function shortcutClash(accelerator: string, routineId: string | undefined, routines: Routine[], bevShortcuts: string[]): string | null {
  const a = accelerator.trim().toLowerCase();
  if (!a) return null;
  if (bevShortcuts.some((s) => s.trim().toLowerCase() === a)) return "That's already one of BEV's own shortcuts (Settings → Voice).";
  const other = routines.find((r) => r.id !== routineId && r.hotkey?.trim().toLowerCase() === a);
  return other ? `“${other.name}” already uses that shortcut.` : null;
}

let bound: string[] = [];
const running = new Set<string>();

async function runFromKey(id: string) {
  const r = useRoutines.getState().routines.find((x) => x.id === id);
  if (!r || !r.enabled || running.has(id)) return;
  running.add(id);
  try {
    const report = await runRoutine(r, {
      requestApproval: (d) => useAssistant.getState().requestApproval?.(d) ?? Promise.resolve(false),
    });
    useRoutines.getState().markRun(r.id);
    useAssistant.getState().pushMessage({ role: "assistant", content: summariseRun(report) });
  } finally {
    running.delete(id);
  }
}

/** Match registered shortcuts to the routines. */
export async function syncRoutineHotkeys() {
  for (const a of bound) await unregister(a).catch(() => {});
  bound = [];
  const s = useSettings.getState().settings;
  const own = [s.pushToTalkShortcut, s.muteShortcut].filter(Boolean);
  for (const r of useRoutines.getState().routines) {
    if (!r.enabled || !r.hotkey?.trim()) continue;
    if (own.some((o) => o.toLowerCase() === r.hotkey!.toLowerCase()) || bound.some((b) => b.toLowerCase() === r.hotkey!.toLowerCase())) continue;
    try {
      const id = r.id;
      await register(r.hotkey, (e) => {
        if (e.state === "Pressed") void runFromKey(id);
      });
      bound.push(r.hotkey);
    } catch {
      /* in use by another app: the editor reports this when it's set */
    }
  }
}

/** Test whether Windows will give us a shortcut, without keeping it. */
export async function tryShortcut(accelerator: string): Promise<string | null> {
  if (bound.some((b) => b.toLowerCase() === accelerator.toLowerCase())) return null;
  try {
    await register(accelerator, () => {});
    await unregister(accelerator);
    return null;
  } catch {
    return `Couldn't use ${accelerator}: another app may already have it.`;
  }
}

let started = false;
export function startRoutineHotkeys() {
  if (started) return;
  started = true;
  let last = "";
  const sig = () => JSON.stringify(useRoutines.getState().routines.map((r) => [r.id, r.enabled, r.hotkey ?? ""]));
  const resync = () => {
    const s = sig();
    if (s === last) return;
    last = s;
    void syncRoutineHotkeys();
  };
  useRoutines.subscribe(resync);
  resync();
}
