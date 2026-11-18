/** The navigation rail: BEV's mark, the main areas, the microphone and settings. */
import { useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import clsx from "clsx";
import { prettyAccelerator } from "@/lib/hotkeys";
import { EyeOff, Mic, MicOff, Settings2 } from "lucide-react";
import { useAssistant } from "@/state/assistant";
import { useSettings } from "@/state/settings";
import { getController, setPrivacy } from "@/voice/bootstrap";
import { progress } from "@/ai/plan";
import { Core } from "../components/Core";
import { MAIN_NAV } from "./nav";
import { SlidingHighlight, useActiveRect } from "../components/Motion";

const item = (active: boolean, sliding = false) =>
  clsx(
    "group flex h-8 items-center gap-2.5 rounded px-2.5 text-sm transition-colors duration-fast",
    // In a list with a sliding highlight, the highlight paints the active background.
    active ? clsx(!sliding && "bg-surface-2", "text-ink") : "text-ink-2 hover:bg-surface-1 hover:text-ink"
  );

export function Rail() {
  const { state, micEnabled, privacyMode, audioLevel, plan } = useAssistant();
  const shortcut = useSettings((s) => s.settings.pushToTalkShortcut);
  const loc = useLocation();
  const p = plan && plan.length ? progress(plan) : null;
  const off = privacyMode || !micEnabled;
  const navRef = useRef<HTMLElement>(null);
  const { rect, ready } = useActiveRect(navRef, loc.pathname);

  const toggleMic = () => {
    const c = getController();
    if (!c) return;
    if (privacyMode) {
      setPrivacy(false);
      c.enableListening();
    } else if (micEnabled) c.disableListening();
    else c.enableListening();
  };

  return (
    <aside className="flex w-[212px] shrink-0 flex-col border-r border-line-subtle bg-rail max-[1080px]:w-[60px]" aria-label="Main">
      <div className="drag flex h-12 shrink-0 items-center gap-2.5 px-4 max-[1080px]:justify-center max-[1080px]:px-0">
        <Core state={state === "idle" && off ? "off" : state} level={audioLevel} progress={p && p.total ? p.done / p.total : null} size={22} ambient />
        <span className="leading-none max-[1080px]:hidden">
          <span className="block text-[15px] font-semibold tracking-[0.18em] text-ink">BEV</span>
          <span className="mt-1 block font-mono text-[9px] uppercase tracking-[0.16em] text-ink-4">Personal AI</span>
        </span>
      </div>

      <nav ref={navRef} className="relative mx-2 mt-2 flex flex-1 flex-col gap-0.5">
        <SlidingHighlight rect={rect} ready={ready} />
        {MAIN_NAV.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => clsx(item(isActive, true), "relative")} title={n.label} data-active={loc.pathname.startsWith(n.to) ? "true" : undefined}>
            {({ isActive }) => (
              <>
                <n.icon className={clsx("h-4 w-4 shrink-0", isActive ? "text-accent" : "text-ink-3 group-hover:text-ink-2")} strokeWidth={1.8} aria-hidden />
                <span className="truncate max-[1080px]:hidden">{n.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="space-y-0.5 px-2 pb-3">
        <button
          onClick={toggleMic}
          className={clsx(item(false), "w-full")}
          title={privacyMode ? "Privacy mode is on. Click to turn the microphone back on" : micEnabled ? "Stop listening for the wake word" : "Start listening for the wake word"}
          aria-pressed={!off}
        >
          {privacyMode ? (
            <EyeOff className="h-4 w-4 shrink-0 text-warn" strokeWidth={1.8} aria-hidden />
          ) : off ? (
            <MicOff className="h-4 w-4 shrink-0 text-ink-3" strokeWidth={1.8} aria-hidden />
          ) : (
            <Mic className="h-4 w-4 shrink-0 text-accent" strokeWidth={1.8} aria-hidden />
          )}
          <span className="min-w-0 text-left max-[1080px]:hidden">
            <span className="block truncate">{privacyMode ? "Privacy mode" : off ? "Microphone off" : "Listening"}</span>
            {shortcut && <span className="block truncate text-2xs text-ink-4">Talk: {prettyAccelerator(shortcut)}</span>}
          </span>
        </button>
        <NavLink to="/settings" className={() => item(loc.pathname.startsWith("/settings"))} title="Settings">
          <Settings2 className={clsx("h-4 w-4 shrink-0", loc.pathname.startsWith("/settings") ? "text-accent" : "text-ink-3")} strokeWidth={1.8} aria-hidden />
          <span className="max-[1080px]:hidden">Settings</span>
        </NavLink>
      </div>
    </aside>
  );
}
