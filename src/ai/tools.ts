import { native } from "@/lib/native";
import { looksSensitive } from "@/lib/sensitive";
import { useSettings } from "@/state/settings";
import { useAssistant } from "@/state/assistant";
import { useRoutines, findRoutineByName } from "@/routines/store";
import { runRoutine, summariseRun, ROUTINE_FORBIDDEN } from "@/routines/engine";
import type { Routine, RoutineStep } from "@/routines/types";
import { ToolSpec } from "./types";

/**
 * The BEV tool registry. Each tool has a JSON-schema spec the model sees, a
 * permission flag, and a validated executor that calls a native command.
 *
 * Security model: the AI never runs shell strings. It selects a tool by name
 * and supplies arguments that are validated here before any native call. Tools
 * marked `sensitive` must be approved by the user (see Orchestrator).
 */

export interface RegisteredTool {
  spec: ToolSpec;
  run: (args: Record<string, unknown>) => Promise<string>;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || v.trim() === "")
    throw new Error(`argument "${name}" must be a non-empty string`);
  return v.trim();
};
const num = (v: unknown, name: string): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || Number.isNaN(n)) throw new Error(`argument "${name}" must be a number`);
  return n;
};

/** Accepts real booleans and the strings "true"/"false" some models send. */
const bool = (v: unknown, name: string): boolean => {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`argument "${name}" must be true or false`);
};

export const tools: Record<string, RegisteredTool> = {
  get_system_stats: {
    spec: {
      name: "get_system_stats",
      description:
        "Get live CPU usage %, RAM used/total, core count and uptime. Use for any question about system performance. Returns real sensor data.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    run: async () => {
      const s = await native.getSystemStats();
      return JSON.stringify(s);
    },
  },

  get_running_apps: {
    spec: {
      name: "get_running_apps",
      description: "List the top running applications by memory use (name, pid, cpu%, memMB).",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "max rows, default 12" } },
        required: [],
      },
    },
    run: async (a) => JSON.stringify(await native.getRunningApps(a.limit ? num(a.limit, "limit") : undefined)),
  },

  set_volume: {
    spec: {
      name: "set_volume",
      description: "Set the Windows master output volume to a percentage (0-100).",
      parameters: {
        type: "object",
        properties: { percent: { type: "number", description: "0 to 100" } },
        required: ["percent"],
      },
    },
    run: async (a) => {
      const p = num(a.percent, "percent");
      if (p < 0 || p > 100) throw new Error("percent must be 0..100");
      await native.setVolume(p);
      return `volume set to ${Math.round(p)}%`;
    },
  },

  set_muted: {
    spec: {
      name: "set_muted",
      description: "Mute or unmute the Windows master output.",
      parameters: {
        type: "object",
        properties: { muted: { type: "boolean" } },
        required: ["muted"],
      },
    },
    run: async (a) => {
      const muted = bool(a.muted, "muted");
      await native.setMuted(muted);
      return muted ? "muted" : "unmuted";
    },
  },

  launch_app: {
    spec: {
      name: "launch_app",
      description:
        "Open an installed application or Windows setting by friendly name, e.g. 'Spotify', 'Discord', 'Chrome', 'Notepad', 'Settings'.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    run: async (a) => native.launchApp(str(a.name, "name")),
  },

  close_app: {
    spec: {
      name: "close_app",
      description: "Close a running application by name. This terminates its process.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      sensitive: true,
    },
    run: async (a) => native.closeApp(str(a.name, "name")),
  },

  focus_window: {
    spec: {
      name: "focus_window",
      description:
        "Bring a window to the foreground. First call list_windows to get the hwnd, then pass it here.",
      parameters: {
        type: "object",
        properties: { hwnd: { type: "number" } },
        required: ["hwnd"],
      },
    },
    run: async (a) => {
      await native.focusWindow(num(a.hwnd, "hwnd"));
      return "window focused";
    },
  },

  list_windows: {
    spec: {
      name: "list_windows",
      description: "List visible top-level windows with their titles and hwnd handles.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    run: async () => JSON.stringify(await native.listWindows()),
  },

  remember: {
    spec: {
      name: "remember",
      description:
        "Save a user preference or fact to persistent memory, e.g. key='gaming mode apps' value='Discord, Spotify'. Never store passwords or secrets.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: { type: "string" },
          category: { type: "string" },
        },
        required: ["key", "value"],
      },
    },
    run: async (a) => {
      const key = str(a.key, "key");
      const value = str(a.value, "value");
      if (looksSensitive(key, value)) {
        throw new Error("refused: that looks like a password, key or other sensitive data — BEV doesn't store those");
      }
      await native.memoryUpsert(key, value, typeof a.category === "string" ? a.category : undefined);
      return `remembered "${key}"`;
    },
  },

  recall_memories: {
    spec: {
      name: "recall_memories",
      description: "List everything BEV currently remembers (keys, values, categories).",
      parameters: { type: "object", properties: {}, required: [] },
    },
    run: async () => JSON.stringify(await native.memoryList()),
  },

  open_website: {
    spec: {
      name: "open_website",
      description:
        "Open a URL or web search in the default browser. For a search, pass the query and it opens a web search.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "full URL, optional" },
          search: { type: "string", description: "search query, optional" },
        },
        required: [],
      },
    },
    run: async (a) => {
      const { open } = await import("@tauri-apps/plugin-shell");
      let target = typeof a.url === "string" ? a.url : "";
      if (!target && typeof a.search === "string") {
        target = `https://duckduckgo.com/?q=${encodeURIComponent(a.search)}`;
      }
      if (!target) throw new Error("provide a url or a search query");
      if (!/^https?:\/\//.test(target)) target = `https://${target}`;
      await open(target);
      return `opened ${target}`;
    },
  },
};

Object.assign(tools, {
  get_datetime: {
    spec: {
      name: "get_datetime",
      description: "Get the current local date, time and day of the week.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    run: async () => {
      const d = new Date();
      return d.toLocaleString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    },
  },

  set_quiet_mode: {
    spec: {
      name: "set_quiet_mode",
      description:
        "Turn BEV's quiet/gaming mode on or off. When on, BEV replies in as few words as possible. Use when the user says they're gaming or wants BEV to keep it quiet.",
      parameters: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] },
    },
    run: async (a: Record<string, unknown>) => {
      const enabled = bool(a.enabled, "enabled");
      await useSettings.getState().update({ gamingQuietMode: enabled });
      return enabled ? "quiet mode on" : "quiet mode off";
    },
  },

  lock_pc: {
    spec: {
      name: "lock_pc",
      description: "Lock the Windows session (same as Win+L).",
      parameters: { type: "object", properties: {}, required: [] },
    },
    run: async () => {
      await native.lockPc();
      return "PC locked";
    },
  },

  power_action: {
    spec: {
      name: "power_action",
      description:
        "Sleep, restart or shut down the PC, or cancel a pending restart/shutdown. Restart/shutdown happen after a short countdown.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["sleep", "restart", "shutdown", "cancel"] },
          delay_seconds: { type: "number", description: "countdown for restart/shutdown, default 15" },
        },
        required: ["action"],
      },
      sensitive: true,
    },
    run: async (a: Record<string, unknown>) => {
      const action = str(a.action, "action");
      if (!["sleep", "restart", "shutdown", "cancel"].includes(action)) throw new Error(`unknown action ${action}`);
      const delay = a.delay_seconds !== undefined ? num(a.delay_seconds, "delay_seconds") : undefined;
      return native.powerAction(action as "sleep" | "restart" | "shutdown" | "cancel", delay);
    },
  },

  open_settings_page: {
    spec: {
      name: "open_settings_page",
      description:
        "Open a Windows Settings page. Examples: display, sound, bluetooth, network-wifi, notifications, quiethours (Do Not Disturb / Focus), windowsupdate, apps-volume, privacy-microphone, batterysaver. Empty string opens Settings home.",
      parameters: { type: "object", properties: { page: { type: "string" } }, required: ["page"] },
    },
    run: async (a: Record<string, unknown>) =>
      native.openSettingsPage(typeof a.page === "string" ? a.page : ""),
  },

  list_routines: {
    spec: {
      name: "list_routines",
      description: "List the user's saved routines with their trigger phrases.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    run: async () =>
      JSON.stringify(
        useRoutines.getState().routines.map((r) => ({ name: r.name, triggers: r.triggers, steps: r.steps.length }))
      ),
  },

  run_routine: {
    spec: {
      name: "run_routine",
      description:
        "Run a saved routine by name or trigger phrase, e.g. 'gaming mode'. Use this when the user asks to activate/start/run a named routine.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    run: async (a: Record<string, unknown>) => {
      const name = str(a.name, "name");
      const routine = findRoutineByName(name, useRoutines.getState().routines);
      if (!routine) throw new Error(`no routine matching "${name}"`);
      const report = await runRoutine(routine, {
        requestApproval: (d) => useAssistant.getState().requestApproval?.(d) ?? Promise.resolve(false),
      });
      useRoutines.getState().markRun(routine.id);
      return summariseRun(report);
    },
  },

  create_routine: {
    spec: {
      name: "create_routine",
      description:
        "Create and save a new routine from spoken instructions. steps is an ordered list of { tool, args } using existing tools (launch_app, close_app, set_volume, set_muted, set_quiet_mode, power_action, get_system_stats, open_settings_page, open_website, get_datetime). Example: name='gaming mode', triggers=['gaming mode'], steps=[{tool:'launch_app',args:{name:'Discord'}},{tool:'set_volume',args:{percent:40}}].",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          triggers: { type: "array", items: { type: "string" } },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: { tool: { type: "string" }, args: { type: "object" } },
              required: ["tool"],
            },
          },
        },
        required: ["name", "steps"],
      },
    },
    run: async (a: Record<string, unknown>) => {
      const name = str(a.name, "name");
      const rawSteps = Array.isArray(a.steps) ? a.steps : [];
      if (rawSteps.length === 0) throw new Error("a routine needs at least one step");
      const steps: RoutineStep[] = [];
      for (const s of rawSteps as Array<Record<string, unknown>>) {
        const toolName = str(s.tool, "tool");
        if (!tools[toolName]) throw new Error(`unknown tool in step: "${toolName}"`);
        if (ROUTINE_FORBIDDEN.has(toolName)) throw new Error(`"${toolName}" can't be used in a routine`);
        steps.push({
          id: crypto.randomUUID(),
          tool: toolName,
          args: (s.args as Record<string, unknown>) ?? {},
        });
      }
      const triggers = Array.isArray(a.triggers)
        ? (a.triggers as unknown[]).filter((t): t is string => typeof t === "string")
        : [name];
      const routine: Routine = {
        id: crypto.randomUUID(),
        name,
        triggers: triggers.length ? triggers : [name],
        steps,
        enabled: true,
      };
      await useRoutines.getState().save(routine);
      return `created routine "${name}" with ${steps.length} step${steps.length === 1 ? "" : "s"}. Say "${routine.triggers[0]}" to run it.`;
    },
  },
} satisfies Record<string, RegisteredTool>);

export const toolSpecs = (): ToolSpec[] => Object.values(tools).map((t) => t.spec);
export const isSensitive = (name: string): boolean => !!tools[name]?.spec.sensitive;
