/**
 * Ctrl+K: jump anywhere in BEV or run a common action without hunting
 * through menus. Keyboard-first: type, arrows, Enter, Esc.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { CornerDownLeft, EyeOff, Gamepad2, Mic, MicOff, Plus, Search, Stethoscope, type LucideIcon } from "lucide-react";
import { useAssistant } from "@/state/assistant";
import { useSettings } from "@/state/settings";
import { getController, setPrivacy } from "@/voice/bootstrap";
import { MAIN_NAV, SETTINGS_NAV } from "./nav";
import { newConversation, sendChat } from "../assistant/chat";

interface Command {
  id: string;
  label: string;
  group: "Go to" | "Settings" | "Actions";
  icon: LucideIcon;
  keywords?: string;
  run: () => void;
}

/** Simple ranked match: every word must appear; earlier and label matches rank higher. Exported for tests. */
export function matchScore(query: string, label: string, keywords = ""): number {
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  const l = label.toLowerCase();
  const hay = `${l} ${keywords.toLowerCase()}`;
  const words = q.split(/\s+/);
  if (!words.every((w) => hay.includes(w))) return 0;
  if (l.startsWith(q)) return 3;
  if (words.every((w) => l.includes(w))) return 2;
  return 1;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const { micEnabled, privacyMode } = useAssistant();
  const { settings, update } = useSettings();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => nav(to);
    return [
      ...MAIN_NAV.map((n) => ({ id: n.to, label: n.label, group: "Go to" as const, icon: n.icon, keywords: n.keywords, run: go(n.to) })),
      ...SETTINGS_NAV.map((n) => ({ id: n.to, label: n.label, group: "Settings" as const, icon: n.icon, keywords: n.keywords, run: go(n.to) })),
      { id: "new", label: "New conversation", group: "Actions", icon: Plus, keywords: "clear reset chat", run: () => (newConversation(), nav("/assistant")) },
      {
        id: "mic",
        label: micEnabled && !privacyMode ? "Stop listening" : "Start listening",
        group: "Actions",
        icon: micEnabled && !privacyMode ? MicOff : Mic,
        keywords: "microphone wake word mute",
        run: () => {
          const c = getController();
          if (!c) return;
          if (privacyMode) setPrivacy(false);
          if (micEnabled && !privacyMode) c.disableListening();
          else c.enableListening();
        },
      },
      { id: "talk", label: "Talk to BEV now", group: "Actions", icon: Mic, keywords: "push to talk speak voice", run: () => getController()?.onWake() },
      { id: "privacy", label: privacyMode ? "Turn privacy mode off" : "Turn privacy mode on", group: "Actions", icon: EyeOff, keywords: "privacy microphone off", run: () => setPrivacy(!privacyMode) },
      { id: "quiet", label: settings.gamingQuietMode ? "Turn quiet mode off" : "Turn quiet mode on", group: "Actions", icon: Gamepad2, keywords: "gaming quiet notifications", run: () => update({ gamingQuietMode: !settings.gamingQuietMode }) },
      { id: "diag", label: "Check my PC's health", group: "Actions", icon: Stethoscope, keywords: "diagnose slow problem troubleshoot", run: () => (nav("/assistant"), sendChat("Check my PC's health and tell me if anything needs attention.")) },
    ];
  }, [nav, micEnabled, privacyMode, settings.gamingQuietMode, update]);

  const results = useMemo(() => {
    const scored = commands.map((c) => ({ c, s: matchScore(q, c.label, c.keywords) })).filter((x) => x.s > 0);
    if (q.trim()) scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => x.c);
  }, [commands, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;
  const run = (c?: Command) => {
    if (!c) return;
    onClose();
    c.run();
  };

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh] animate-fade-in" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        className="w-[560px] max-w-[calc(100vw-48px)] overflow-hidden rounded-xl bg-surface-1 shadow-pop animate-scale-in"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line-subtle px-4">
          <Search className="h-4 w-4 text-ink-3" aria-hidden />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(s + 1, results.length - 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
              else if (e.key === "Enter") (e.preventDefault(), run(results[sel]));
              else if (e.key === "Escape") onClose();
            }}
            placeholder="Go to a page, change a setting or run an action"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmd-list"
            className="h-12 flex-1 bg-transparent text-base text-ink placeholder:text-ink-4 focus:outline-none"
          />
        </div>
        <ul ref={list} id="cmd-list" role="listbox" className="max-h-[360px] overflow-y-auto py-1.5">
          {results.length === 0 && <li className="px-4 py-6 text-center text-sm text-ink-3">No matches</li>}
          {results.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <li key={c.id} role="none">
                {header && <div className="px-4 pb-1 pt-2 text-2xs text-ink-4">{header}</div>}
                <button
                  data-i={i}
                  role="option"
                  aria-selected={i === sel}
                  onMouseMove={() => setSel(i)}
                  onClick={() => run(c)}
                  className={clsx("mx-1.5 flex h-9 w-[calc(100%-12px)] items-center gap-3 rounded px-2.5 text-left text-sm", i === sel ? "bg-surface-3 text-ink" : "text-ink-2")}
                >
                  <c.icon className={clsx("h-4 w-4 shrink-0", i === sel ? "text-accent" : "text-ink-3")} strokeWidth={1.8} aria-hidden />
                  <span className="flex-1 truncate">{c.label}</span>
                  {i === sel && <CornerDownLeft className="h-3.5 w-3.5 text-ink-4" aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
