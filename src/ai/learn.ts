/**
 * BEV learns tasks. When it finishes a hands-on task (clicking and typing in
 * apps), it keeps the steps in a form it can repeat: controls are remembered
 * by app, name and role (ids change every time a window is read). Asked the
 * same thing again, it replays those steps directly, checking each one, and
 * only falls back to working it out if something doesn't match. Similar
 * requests get the steps as a hint.
 *
 * Learned tasks are kept on this PC (learned.json) and can be reviewed,
 * deleted or saved as routines on the Automations page.
 */
import { create } from "zustand";
import { load, type Store } from "@tauri-apps/plugin-store";
import type { RoutineStep } from "@/routines/types";
import type { ToolCall } from "./types";

/** Tools whose steps can be repeated as they are. */
const REPLAYABLE = new Set([
  "launch_app",
  "launch_game",
  "open_website",
  "open_path",
  "close_app",
  "focus_window",
  "press_keys",
  "type_text",
  "set_volume",
  "set_muted",
  "set_quiet_mode",
  "use_named_control",
]);

/** Tools that only look: left out of the replay. */
const OBSERVE = new Set([
  "list_folder",
  "find_files",
  "search_documents",
  "read_document",
  "read_app_controls",
  "read_screen_text",
  "look_at_screen",
  "look_back",
  "list_windows",
  "get_running_apps",
  "get_system_stats",
  "get_datetime",
  "recall_memories",
  "search_notes",
  "read_note",
  "search_conversations",
  "find_apps",
  "list_routines",
  "list_background_tasks",
  "list_tracked_tasks",
  "update_plan",
  "hover_on_screen",
]);

/** Steps that change what's on screen: give the app a moment before the next one. */
const SETTLE = new Set(["launch_app", "launch_game", "open_website", "open_path", "focus_window"]);

/** What happened in one step of a turn, as the orchestrator saw it. */
export interface TurnStep {
  call: ToolCall;
  ok: boolean;
  /** For use_control: the control it acted on, captured before acting. */
  control?: { app: string; name: string; role: string };
}

export interface LearnedTask {
  id: string;
  /** The request, normalised: what an exact repeat must match. */
  request: string;
  /** How the user first put it. */
  example: string;
  steps: RoutineStep[];
  createdAt: number;
  uses: number;
  lastUsed?: number;
  /** Failed replays in a row; three and it's dropped. */
  failures: number;
}

const FILLER_START = /^(?:hey\s+)?(?:bev[,!.]?\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:just\s+)?/i;
const FILLER_END = /[\s,.!?]*(?:please|for me|thanks|thank you|cheers|now)[\s,.!?]*$/i;

/** Pure: the form of a request used to spot repeats. */
export function normaliseRequest(text: string): string {
  let t = text.toLowerCase().replace(/[“”"’']/g, "").replace(/[.?!,]+$/g, "").trim();
  for (let i = 0; i < 3; i++) t = t.replace(FILLER_START, "").replace(FILLER_END, "").trim();
  return t.replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
}

/** Pure: word overlap between two normalised requests (0..1). */
export function similarity(a: string, b: string): number {
  const A = new Set(a.split(" ").filter((w) => w.length > 2));
  const B = new Set(b.split(" ").filter((w) => w.length > 2));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

const appName = (process: string) => process.replace(/\.exe$/i, "");

/**
 * Pure: turn a finished turn into repeatable steps, or null when it can't be
 * repeated reliably (a step failed, needed approval, used screen coordinates,
 * or did something replay can't do), or isn't worth learning (no hands-on
 * step, or fewer than two steps).
 */
export function stepsFromTurn(turn: TurnStep[], neededApproval: boolean): RoutineStep[] | null {
  if (neededApproval || !turn.length || turn.some((s) => !s.ok)) return null;
  const out: RoutineStep[] = [];
  let handsOn = false;
  let prevSettle = false;
  for (const { call, control } of turn) {
    const a = call.args ?? {};
    let step: Omit<RoutineStep, "id"> | null = null;
    if (OBSERVE.has(call.name)) continue;
    if (call.name === "use_control") {
      if (!control?.name.trim()) return null;
      step = {
        tool: "use_named_control",
        args: { app: appName(control.app), name: control.name, role: control.role, action: a.action, ...(typeof a.text === "string" ? { text: a.text } : {}) },
      };
      handsOn = true;
    } else if (call.name === "click_on_screen") {
      // Clicks by visible text repeat; clicks by coordinates don't.
      if (typeof a.text !== "string" || a.x !== undefined || a.y !== undefined) return null;
      step = { tool: "click_on_screen", args: { text: a.text, ...(a.button ? { button: a.button } : {}), ...(a.double ? { double: a.double } : {}) } };
      handsOn = true;
    } else if (call.name === "scroll_screen") {
      if (a.x !== undefined || a.y !== undefined) return null;
      step = { tool: "scroll_screen", args: { direction: a.direction, ...(a.amount !== undefined ? { amount: a.amount } : {}) } };
      handsOn = true;
    } else if (REPLAYABLE.has(call.name)) {
      step = { tool: call.name, args: { ...a } };
      if (["use_named_control", "press_keys", "type_text"].includes(call.name)) handsOn = true;
    } else {
      return null;
    }
    out.push({ id: crypto.randomUUID(), ...step, ...(out.length ? { delayMs: prevSettle ? 1500 : 500 } : {}) });
    prevSettle = SETTLE.has(call.name);
  }
  return handsOn && out.length >= 2 ? out : null;
}

/** Pure: one line per step, for hints and the Automations page. */
export function describeSteps(steps: RoutineStep[]): string[] {
  return steps.map((s) => {
    const a = s.args;
    switch (s.tool) {
      case "use_named_control":
        return `${a.action === "type" ? `type "${a.text}" into` : String(a.action)} "${a.name}" in ${a.app}`;
      case "click_on_screen":
        return `click "${a.text}"`;
      case "launch_app":
      case "launch_game":
        return `open ${a.name}`;
      case "open_website":
        return `open ${a.url}`;
      case "focus_window":
        return `bring ${a.app ?? "the window"} to the front`;
      case "press_keys":
        return `press ${a.keys}`;
      case "type_text":
        return `type "${a.text}"`;
      case "scroll_screen":
        return `scroll ${a.direction ?? "down"}`;
      case "open_path":
        return `open ${a.path}`;
      case "close_app":
        return `close ${a.name}`;
      case "set_volume":
        return `set the volume to ${a.percent}%`;
      case "set_muted":
        return a.muted === false ? "unmute the sound" : "mute the sound";
      case "set_quiet_mode":
        return a.enabled === false ? "turn quiet mode off" : "turn quiet mode on";
      default:
        return s.tool.replace(/_/g, " ");
    }
  });
}

// ---------------------------------------------------------------------------
// The store

const MAX = 100;
let kv: Store | null = null;
const store = async () => (kv ??= await load("learned.json", { autoSave: true }));

interface LearnedState {
  tasks: LearnedTask[];
  loaded: boolean;
  load(): Promise<void>;
  save(tasks: LearnedTask[]): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

export const useLearned = create<LearnedState>((set, get) => ({
  tasks: [],
  loaded: false,
  async load() {
    if (get().loaded) return;
    const tasks = ((await (await store()).get<LearnedTask[]>("tasks").catch(() => null)) ?? []).filter((t) => t?.steps?.length);
    set({ tasks, loaded: true });
  },
  async save(tasks) {
    set({ tasks });
    await (await store()).set("tasks", tasks).catch(() => {});
  },
  async remove(id) {
    await get().save(get().tasks.filter((t) => t.id !== id));
  },
  async clear() {
    await get().save([]);
  },
}));

/** Remember a finished task (replacing an older version of the same request). */
export async function learn(request: string, steps: RoutineStep[]): Promise<void> {
  const s = useLearned.getState();
  await s.load();
  const norm = normaliseRequest(request);
  if (!norm) return;
  const rest = s.tasks.filter((t) => t.request !== norm);
  const task: LearnedTask = { id: crypto.randomUUID(), request: norm, example: request.trim(), steps, createdAt: Date.now(), uses: 0, failures: 0 };
  // Most recently used first; the least useful fall off the end.
  await s.save([task, ...rest].slice(0, MAX));
}

/** A learned task for exactly this request, if any. */
export async function exactMatch(request: string): Promise<LearnedTask | null> {
  const s = useLearned.getState();
  await s.load();
  const norm = normaliseRequest(request);
  return s.tasks.find((t) => t.request === norm) ?? null;
}

/** The closest learned task to a request that isn't an exact repeat. */
export async function similarTask(request: string, min = 0.5): Promise<LearnedTask | null> {
  const s = useLearned.getState();
  await s.load();
  const norm = normaliseRequest(request);
  let best: { t: LearnedTask; score: number } | null = null;
  for (const t of s.tasks) {
    if (t.request === norm) continue;
    const score = similarity(norm, t.request);
    if (score >= min && (!best || score > best.score)) best = { t, score };
  }
  return best?.t ?? null;
}

/** Record how a replay went: used (and refreshed), or one more failure. */
export async function markReplay(id: string, ok: boolean): Promise<void> {
  const s = useLearned.getState();
  const tasks = s.tasks
    .map((t) => (t.id !== id ? t : ok ? { ...t, uses: t.uses + 1, lastUsed: Date.now(), failures: 0 } : { ...t, failures: t.failures + 1 }))
    .filter((t) => t.failures < 3);
  await s.save(tasks);
}
