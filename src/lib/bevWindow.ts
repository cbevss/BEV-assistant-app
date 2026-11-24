/**
 * BEV's own window. Other apps' windows are moved through Win32, which skips
 * BEV on purpose; this moves BEV itself through its own window API, so
 * "move yourself to my second monitor" works.
 */
import { getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";

/** Does this name mean BEV's own window? ("BEV", "yourself", "your window"…) */
export function isBevItself(app: string): boolean {
  const a = app.trim().toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  return /^(bev|bev assistant|bev app|you|yourself|your ?self|your (own )?(window|app)|this (window|app)|the bev (window|app)|bev s window|bevs window)$/.test(a);
}

export async function bevRect(): Promise<{ x: number; y: number; w: number; h: number; maximized: boolean }> {
  const w = getCurrentWindow();
  const [p, s, maximized] = await Promise.all([w.outerPosition(), w.outerSize(), w.isMaximized()]);
  return { x: p.x, y: p.y, w: s.width, h: s.height, maximized };
}

/** Put BEV's window at a rectangle (physical pixels), or maximise it there. */
export async function placeBev(r: { x: number; y: number; w: number; h: number }, state: "normal" | "maximized"): Promise<void> {
  const w = getCurrentWindow();
  if (await w.isMinimized()) await w.unminimize();
  if (await w.isMaximized()) await w.unmaximize();
  await w.setPosition(new PhysicalPosition(Math.round(r.x), Math.round(r.y)));
  if (state === "maximized") {
    await w.maximize();
  } else {
    await w.setSize(new PhysicalSize(Math.round(r.w), Math.round(r.h)));
    // Windows can nudge the window after a resize across monitors with different scaling: set it again.
    await w.setPosition(new PhysicalPosition(Math.round(r.x), Math.round(r.y)));
  }
  await w.show();
  await w.setFocus();
}
