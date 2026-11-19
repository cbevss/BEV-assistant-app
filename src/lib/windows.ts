/**
 * Finding an app's window wherever it is: any monitor, behind other windows,
 * or minimised. BEV should never need the user to move a window for it.
 */
import { native } from "./native";

export interface WinEntry {
  hwnd: number;
  title: string;
  /** Executable name, e.g. "Discord.exe". */
  process: string;
  minimized: boolean;
  /** e.g. "display 2 of 2" (empty when minimised). */
  display: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\.exe$/, "").replace(/[^a-z0-9]+/g, "");

/** Best window for a name like "discord", "spotify", "chrome", "the steam window". */
export function matchWindow(list: WinEntry[], app: string): WinEntry | null {
  const want = norm(app.replace(/\b(the|window|app)\b/gi, ""));
  if (!want) return null;
  let best: { w: WinEntry; score: number } | null = null;
  list.forEach((w, i) => {
    const proc = norm(w.process);
    const title = norm(w.title);
    let score = proc === want ? 30 : proc.includes(want) ? 20 : title.includes(want) ? 10 : 0;
    if (!score) return;
    if (!w.minimized) score += 2;
    score -= i * 0.01; // earlier in the list = nearer the front
    if (!best || score > best.score) best = { w, score };
  });
  return best ? (best as { w: WinEntry }).w : null;
}

/** One line per window, for the AI. */
export function describeWindows(list: WinEntry[]): string {
  if (!list.length) return "No app windows are open.";
  return list
    .map((w) => `hwnd ${w.hwnd}: "${w.title}" (${w.process || "unknown app"}, ${w.minimized ? "minimised" : w.display || "on screen"})`)
    .join("\n");
}

/**
 * Resolve an app name or hwnd to a window, restoring it if it's minimised so it
 * can be read and operated. Throws a helpful message if there's no window.
 */
export async function findWindow(opts: { app?: unknown; hwnd?: unknown }, restore = true): Promise<WinEntry> {
  const list = await native.listWindows();
  let w: WinEntry | null = null;
  if (typeof opts.hwnd === "number" && Number.isFinite(opts.hwnd)) w = list.find((x) => x.hwnd === opts.hwnd) ?? null;
  else if (typeof opts.app === "string" && opts.app.trim()) w = matchWindow(list, opts.app);
  if (!w) {
    const name = typeof opts.app === "string" ? opts.app.trim() : "that window";
    throw new Error(
      `No open window for ${name}. It may be closed or only in the system tray: launch_app it to bring its window back, then try again.`
    );
  }
  if (w.minimized && restore) {
    await native.focusWindow(w.hwnd);
    await new Promise((r) => setTimeout(r, 350)); // let it redraw before reading
    w = { ...w, minimized: false };
  }
  return w;
}
