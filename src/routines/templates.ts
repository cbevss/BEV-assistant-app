import type { Routine } from "./types";

const id = () => crypto.randomUUID();

/**
 * Built-in starting routines. Users edit them freely; they only use tools that
 * genuinely exist, so nothing here pretends to do something it can't.
 */
export function builtInRoutines(): Routine[] {
  return [
    {
      id: "builtin-gaming",
      name: "Gaming Mode",
      description: "Opens Discord and Steam, sets volume to 40% and switches BEV to quiet replies.",
      triggers: ["gaming mode", "game mode"],
      enabled: true,
      builtIn: true,
      steps: [
        { id: id(), tool: "launch_app", args: { name: "discord" }, continueOnError: true },
        { id: id(), tool: "launch_app", args: { name: "steam" }, continueOnError: true },
        { id: id(), tool: "set_volume", args: { percent: 40 } },
        { id: id(), tool: "set_quiet_mode", args: { enabled: true } },
      ],
    },
    {
      id: "builtin-focus",
      name: "Focus Mode",
      description: "Closes distracting apps (with approval) and opens your notes.",
      triggers: ["focus mode"],
      enabled: true,
      builtIn: true,
      steps: [
        {
          id: id(),
          tool: "close_app",
          args: { name: "discord" },
          condition: { type: "process_running", name: "discord" },
          continueOnError: true,
        },
        {
          id: id(),
          tool: "close_app",
          args: { name: "steam" },
          condition: { type: "process_running", name: "steam" },
          continueOnError: true,
        },
        { id: id(), tool: "launch_app", args: { name: "notepad" } },
      ],
    },
    {
      id: "builtin-streaming",
      name: "Streaming Mode",
      description: "Opens OBS and Discord, then reports system headroom.",
      triggers: ["streaming mode", "stream mode"],
      enabled: true,
      builtIn: true,
      steps: [
        { id: id(), tool: "launch_app", args: { name: "obs" }, continueOnError: true },
        { id: id(), tool: "launch_app", args: { name: "discord" }, continueOnError: true },
        { id: id(), tool: "get_system_stats", args: {}, delayMs: 3000 },
      ],
    },
    {
      id: "builtin-shutdown",
      name: "Shutdown Routine",
      description: "Closes Discord and Steam, then asks before shutting Windows down.",
      triggers: ["shutdown routine", "wind down"],
      enabled: true,
      builtIn: true,
      steps: [
        { id: id(), tool: "close_app", args: { name: "discord" }, condition: { type: "process_running", name: "discord" }, continueOnError: true },
        { id: id(), tool: "close_app", args: { name: "steam" }, condition: { type: "process_running", name: "steam" }, continueOnError: true },
        { id: id(), tool: "power_action", args: { action: "shutdown", delay_seconds: 30 }, delayMs: 1000 },
      ],
    },
    {
      id: "builtin-morning",
      name: "Morning Briefing",
      description: "Reads the time, date and how your PC is doing. Weather/calendar join once those integrations are connected.",
      triggers: ["morning briefing", "good morning"],
      enabled: true,
      builtIn: true,
      steps: [
        { id: id(), tool: "get_datetime", args: {} },
        { id: id(), tool: "get_system_stats", args: {} },
      ],
    },
  ];
}
