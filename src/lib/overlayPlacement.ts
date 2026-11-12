import { native } from "./native";
import { useSettings } from "@/state/settings";

/** Base overlay window edge in logical px at scale 1. */
export const OVERLAY_BASE = 420;

/** Move/resize the overlay to match current Appearance settings. */
export function placeOverlayFromSettings(): Promise<void> {
  const s = useSettings.getState().settings;
  return native.placeOverlay(s.overlayCorner, OVERLAY_BASE * s.overlayScale).catch(() => {});
}

/** Show the overlay briefly cycling through states so the user can see it. */
export async function previewOverlay(): Promise<void> {
  const { emit } = await import("@tauri-apps/api/event");
  await placeOverlayFromSettings();
  await native.showOverlay();
  const seq: Array<[string, number]> = [
    ["activating", 600],
    ["listening", 1400],
    ["thinking", 1400],
    ["speaking", 1400],
    ["executing", 1200],
    ["completed", 900],
  ];
  for (const [state, ms] of seq) {
    await emit("bev://state", state);
    await emit("bev://status", `Preview — ${state}`);
    if (state === "listening" || state === "speaking") {
      // Drive the visualiser with a visible synthetic sweep (preview only).
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        await emit("bev://audio-level", 0.3 + 0.5 * Math.abs(Math.sin((performance.now() - t0) / 180)));
        await new Promise((r) => setTimeout(r, 50));
      }
      await emit("bev://audio-level", 0);
    } else {
      await new Promise((r) => setTimeout(r, ms));
    }
  }
  await emit("bev://state", "idle");
  await emit("bev://status", "");
  await native.hideOverlay();
}
