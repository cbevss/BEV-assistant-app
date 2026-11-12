import { getCurrentWindow } from "@tauri-apps/api/window";

/** Frameless-window custom title bar: drag region + window controls. */
export function TitleBar() {
  const w = getCurrentWindow();
  return (
    <div className="drag flex h-10 items-center justify-end gap-1 border-b border-white/5 px-3">
      <div className="no-drag flex gap-1">
        <button
          className="grid h-7 w-7 place-items-center rounded hover:bg-white/10"
          onClick={() => w.minimize()}
          aria-label="Minimise"
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
          onClick={() => w.hide()}
          aria-label="Close to tray"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
