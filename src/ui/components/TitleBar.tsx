import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";
import { Copy, Minus, Search, Square, X } from "lucide-react";
import { useSettings } from "@/state/settings";
import { pageTitle, SETTINGS_NAV } from "../shell/nav";
import { Kbd } from "./Form";

/**
 * Frameless-window title bar: page name, search/commands and window controls
 * sized like Windows' own (46px), so it feels native.
 */
export function TitleBar({ onSearch }: { onSearch: () => void }) {
  const w = getCurrentWindow();
  const { closeToTray, minimizeToTray } = useSettings((s) => s.settings);
  const loc = useLocation();
  const [maxed, setMaxed] = useState(false);
  useEffect(() => {
    let un: (() => void) | undefined;
    w.isMaximized().then(setMaxed).catch(() => {});
    w.onResized(() => w.isMaximized().then(setMaxed).catch(() => {}))
      .then((f) => (un = f))
      .catch(() => {});
    return () => un?.();
  }, [w]);
  // Window commands reject when a permission is missing; log instead of failing silently.
  const run = (what: string, action: () => Promise<unknown>) => action().catch((e) => console.error(`[titlebar] ${what} failed:`, e));
  const section = SETTINGS_NAV.find((n) => loc.pathname.startsWith(n.to));
  const ctl = "grid h-12 w-[46px] place-items-center text-ink-3 transition-colors duration-fast hover:bg-surface-2 hover:text-ink";

  return (
    <div className="drag flex h-12 shrink-0 items-center border-b border-line-subtle pl-5">
      <div className="min-w-0 flex-1 truncate text-sm">
        <span className="font-medium text-ink">{pageTitle(loc.pathname)}</span>
        {section && <span className="text-ink-3"> / {section.label}</span>}
      </div>
      <button
        onClick={onSearch}
        className="no-drag mr-3 flex h-7 w-[240px] items-center gap-2 rounded border border-line-subtle bg-surface-1 px-2.5 text-xs text-ink-3 transition-colors duration-fast hover:border-line hover:text-ink-2 max-[900px]:w-auto"
        aria-label="Search and commands"
      >
        <Search className="h-3.5 w-3.5" aria-hidden />
        <span className="flex-1 text-left max-[900px]:hidden">Search or run a command</span>
        <Kbd>Ctrl K</Kbd>
      </button>
      <div className="no-drag flex">
        <button className={ctl} onClick={() => run("minimise", () => (minimizeToTray ? w.hide() : w.minimize()))} aria-label={minimizeToTray ? "Minimise to tray" : "Minimise"}>
          <Minus className="h-4 w-4" strokeWidth={1.5} aria-hidden />
        </button>
        <button className={ctl} onClick={() => run("maximise", () => w.toggleMaximize())} aria-label={maxed ? "Restore" : "Maximise"}>
          {maxed ? <Copy className="h-3.5 w-3.5 -scale-x-100" strokeWidth={1.5} aria-hidden /> : <Square className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />}
        </button>
        <button className={`${ctl} hover:!bg-[#c42b1c] hover:!text-white`} onClick={() => run("close", () => (closeToTray ? w.hide() : exit(0)))} aria-label={closeToTray ? "Close to tray" : "Quit BEV"}>
          <X className="h-4 w-4" strokeWidth={1.5} aria-hidden />
        </button>
      </div>
    </div>
  );
}
