import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";
import { useSettings } from "@/state/settings";

/** Frameless-window custom title bar: drag region + window controls. */
export function TitleBar() {
  const w = getCurrentWindow();
  const { closeToTray, minimizeToTray } = useSettings((s) => s.settings);
  // Window commands reject when a permission is missing from the capability
  // file; log it instead of leaving a button that silently does nothing.
  const run = (what: string, action: () => Promise<unknown>) =>
    action().catch((e) => console.error(`[titlebar] ${what} failed:`, e));
  return (
    <div className="drag flex h-10 items-center justify-end gap-1 border-b border-white/5 px-3">
      <div className="no-drag flex gap-1">
        <button
          className="grid h-7 w-7 place-items-center rounded hover:bg-white/10"
          onClick={() => run("minimise", () => (minimizeToTray ? w.hide() : w.minimize()))}
          aria-label={minimizeToTray ? "Minimise to tray" : "Minimise"}
        >
          –
        </button>
        <button
          className="grid h-7 w-7 place-items-center rounded hover:bg-white/10"
          onClick={() => run("maximise", () => w.toggleMaximize())}
          aria-label="Maximise"
        >
          ☐
        </button>
        <button
          className="grid h-7 w-7 place-items-center rounded hover:bg-bev-danger/40"
          onClick={() => run("close", () => (closeToTray ? w.hide() : exit(0)))}
          aria-label={closeToTray ? "Close to tray" : "Quit BEV"}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
