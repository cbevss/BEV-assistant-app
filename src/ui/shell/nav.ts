/** Where everything lives: the rail, the settings categories and their routes. */
import { Activity, AppWindow, Brain, Cpu, MessagesSquare, Mic, Palette, Plug, ShieldCheck, SlidersHorizontal, Workflow, Wrench, type LucideIcon } from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Words the command palette also matches. */
  keywords?: string;
}

export const MAIN_NAV: NavItem[] = [
  { to: "/assistant", label: "Assistant", icon: MessagesSquare, keywords: "chat conversation talk ask" },
  { to: "/activity", label: "Activity", icon: Activity, keywords: "dashboard system tasks cpu ram background noticed" },
  { to: "/memory", label: "Memory", icon: Brain, keywords: "facts notes history remember" },
  { to: "/automations", label: "Automations", icon: Workflow, keywords: "routines schedule triggers" },
];

export const SETTINGS_NAV: NavItem[] = [
  { to: "/settings/general", label: "General", icon: SlidersHorizontal, keywords: "startup tray personality briefing proactive monitoring alerts" },
  { to: "/settings/voice", label: "Voice & microphone", icon: Mic, keywords: "audio mic wake word speech whisper voice output speaker" },
  { to: "/settings/ai", label: "AI & models", icon: Cpu, keywords: "provider anthropic claude openai ollama api key model routing" },
  { to: "/settings/services", label: "Connected services", icon: Plug, keywords: "integrations home assistant spotify gmail calendar github discord mcp web search cloud telegram phone" },
  { to: "/settings/apps", label: "Apps", icon: AppWindow, keywords: "installed applications index rescan" },
  { to: "/settings/appearance", label: "Appearance", icon: Palette, keywords: "accent colour theme overlay motion" },
  { to: "/settings/privacy", label: "Privacy & security", icon: ShieldCheck, keywords: "permissions approvals tools privacy" },
  { to: "/settings/advanced", label: "Advanced", icon: Wrench, keywords: "diagnostics version reset" },
];

export const pageTitle = (path: string): string => {
  const s = SETTINGS_NAV.find((n) => path.startsWith(n.to));
  if (s) return `Settings`;
  return MAIN_NAV.find((n) => path.startsWith(n.to))?.label ?? "BEV";
};
