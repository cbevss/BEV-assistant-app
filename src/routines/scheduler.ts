import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { useRoutines } from "./store";
import { runRoutine, summariseRun, isRoutineRunning } from "./engine";
import { useAssistant } from "@/state/assistant";
import type { Routine } from "./types";

let timer: ReturnType<typeof setInterval> | null = null;
/** routineId → "YYYY-M-D-HH:MM" it last fired, so a routine fires once per minute. */
const firedAt = new Map<string, string>();
let notifyGranted = false;

function stamp(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${hh}:${mm}`;
}

function isDue(r: Routine, now: Date): boolean {
  if (!r.enabled || !r.schedule?.time) return false;
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  if (r.schedule.time !== `${hh}:${mm}`) return false;
  // Empty days = every day; otherwise the current weekday must be listed.
  if (r.schedule.days.length > 0 && !r.schedule.days.includes(now.getDay())) return false;
  // Already fired this very minute?
  return firedAt.get(r.id) !== stamp(now);
}

async function notify(title: string, body: string) {
  if (!notifyGranted) return;
  try {
    sendNotification({ title, body });
  } catch {
    /* non-fatal */
  }
}

async function fire(routine: Routine, now: Date) {
  firedAt.set(routine.id, stamp(now));

  // If BEV is mid-conversation, don't hijack the overlay — just run quietly.
  const idle = useAssistant.getState().state === "idle";

  await notify("BEV routine", `Running “${routine.name}”…`);

  if (idle) {
    await native_showOverlay();
    emitState("executing", `Running ${routine.name}`);
  }

  // A scheduled routine that needs approval must be visible: surface the window
  // so the Approve/Cancel modal isn't stuck behind a hidden window.
  const report = await runRoutine(routine, {
    requestApproval: async (description) => {
      await surfaceMainWindow();
      return useAssistant.getState().requestApproval?.(description) ?? Promise.resolve(false);
    },
  });

  useRoutines.getState().markRun(routine.id);
  const summary = summariseRun(report);
  await notify("BEV routine", summary);

  if (idle) {
    emitState(report.ok ? "completed" : "error", summary);
    setTimeout(() => {
      emitState("idle", "");
      native_hideOverlay();
    }, 1500);
  }
}

async function tick() {
  if (isRoutineRunning()) return; // never overlap routine runs
  const now = new Date();
  const due = useRoutines.getState().routines.filter((r) => isDue(r, now));
  for (const r of due) {
    // Run sequentially; stop if one is still going.
    // eslint-disable-next-line no-await-in-loop
    await fire(r, now).catch(() => {});
  }
}

/** Start the minute-aligned scheduler. Idempotent. */
export async function startScheduler() {
  if (timer) return;
  try {
    notifyGranted = await isPermissionGranted();
    if (!notifyGranted) notifyGranted = (await requestPermission()) === "granted";
  } catch {
    notifyGranted = false;
  }
  // Align the first tick to the next minute boundary, then run every minute.
  const now = new Date();
  const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
  setTimeout(() => {
    tick().catch(() => {});
    timer = setInterval(() => tick().catch(() => {}), 60_000);
  }, msToNextMinute);
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// --- small helpers kept local so the scheduler has no hard import cycle ---

async function surfaceMainWindow() {
  try {
    const w = getCurrentWindow();
    await w.show();
    await w.setFocus();
  } catch {
    /* ignore */
  }
}

function emitState(state: string, status: string) {
  useAssistant.getState().setState(state as never, status);
  emit("bev://state", state).catch(() => {});
  emit("bev://status", status).catch(() => {});
}

async function native_showOverlay() {
  const { native } = await import("@/lib/native");
  await native.showOverlay().catch(() => {});
}
async function native_hideOverlay() {
  const { native } = await import("@/lib/native");
  await native.hideOverlay().catch(() => {});
}
