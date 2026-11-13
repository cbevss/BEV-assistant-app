import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";
import { useSettings } from "@/state/settings";

/** Frameless-window custom title bar: drag region + window controls. */
export function TitleBar() {
  const w = getCurrentWindow();
  const { closeToTray, minimizeToTray } = useSettings((s) => s.settings);
  return (
    <div className="drag flex h-10 items-center justify-end gap-1 border-b border-white/5 px-3">
      <div className="no-drag flex gap-1">
        <button
          className="grid h-7 w-7 place-items-center rounded hover:bg-white/10"
          onClick={() => (minimizeToTray ? w.hide() : w.minimize())}
          aria-label={minimizeToTray ? "Minimise to tray" : "Minimise"}
        >
          –
        </button>
        <button
          className="grid h-7 w-7 place-items-center rounded hover:bg-white/10"
          onClick={() => w.toggleMaximize()}
          aria-label="Maximise"
        >
          ☐
        </button>
        <button
          className="grid h-7 w-7 place-items-center rounded hover:bg-bev-danger/40"
          onClick={() => (closeToTray ? w.hide() : exit(0))}
          aria-label={closeToTray ? "Close to tray" : "Quit BEV"}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
