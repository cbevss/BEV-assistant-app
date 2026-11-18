/** Settings: one place, organised by category, with its own side list. */
import { useRef } from "react";
import { NavLink, Navigate, useParams } from "react-router-dom";
import clsx from "clsx";
import { SETTINGS_NAV } from "../shell/nav";
import { SlidingHighlight, useActiveRect } from "../components/Motion";
import { Settings } from "./Settings";
import { VoiceAudio } from "./VoiceAudio";
import { Integrations } from "./Integrations";
import { Appearance } from "./Appearance";
import { Security } from "./Security";

const SECTIONS: Record<string, () => JSX.Element> = {
  general: () => <Settings part="general" />,
  voice: () => <VoiceAudio />,
  ai: () => <Integrations part="ai" />,
  services: () => <Integrations part="services" />,
  apps: () => <Settings part="apps" />,
  appearance: () => <Appearance />,
  privacy: () => <Security />,
  advanced: () => <Settings part="advanced" />,
};

export function SettingsHub() {
  const { section = "general" } = useParams();
  const Body = SECTIONS[section];
  const listRef = useRef<HTMLDivElement>(null);
  const { rect, ready } = useActiveRect(listRef, section);
  if (!Body) return <Navigate to="/settings/general" replace />;
  return (
    <div className="flex h-full">
      <nav className="w-[208px] shrink-0 overflow-y-auto border-r border-line-subtle px-2 py-4 max-[960px]:w-[56px]" aria-label="Settings categories">
        <div ref={listRef} className="relative">
        <SlidingHighlight rect={rect} ready={ready} />
        {SETTINGS_NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            title={n.label}
            data-active={n.to.endsWith(`/${section}`) ? "true" : undefined}
            className={({ isActive }) =>
              clsx(
                "group relative mb-0.5 flex h-8 items-center gap-2.5 rounded px-2.5 text-sm transition-colors duration-fast",
                isActive ? "text-ink" : "text-ink-2 hover:bg-surface-1 hover:text-ink"
              )
            }
          >
            {({ isActive }) => (
              <>
                <n.icon className={clsx("h-4 w-4 shrink-0", isActive ? "text-accent" : "text-ink-3")} strokeWidth={1.8} aria-hidden />
                <span className="truncate max-[960px]:hidden">{n.label}</span>
              </>
            )}
          </NavLink>
        ))}
        </div>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div key={section} className="mx-auto max-w-[820px] animate-page-in px-8 py-7">
          <Body />
        </div>
      </div>
    </div>
  );
}
