import { invoke } from "@tauri-apps/api/core";

export interface SystemStats {
  cpu_usage: number;
  cpu_cores: number;
  mem_used_mb: number;
  mem_total_mb: number;
  mem_percent: number;
  gpu_usage: number | null;
  gpu_name: string | null;
  uptime_secs: number;
  host: string | null;
}

export interface RunningApp {
  pid: number;
  name: string;
  cpu: number;
  mem_mb: number;
}

export interface InstalledGame {
  id: string;
  name: string;
  source: "steam";
}

/** An app holding sound on the default speakers, as the Windows volume mixer shows it. */
export interface AppAudio {
  app: string;
  pid: number;
  volume: number;
  muted: boolean;
}

export interface OutputDevice {
  id: string;
  name: string;
  is_default: boolean;
}

export interface MemoryRow {
  id: number;
  key: string;
  value: string;
  category: string;
  updated_at: number;
}

/**
 * Thin, typed surface over the Rust commands. Every call can reject; callers
 * must surface the error rather than assuming success.
 */
export const native = {
  // System
  getSystemStats: () => invoke<SystemStats>("get_system_stats"),
  getRunningApps: (limit?: number) => invoke<RunningApp[]>("get_running_apps", { limit }),

  // Audio
  getVolume: () => invoke<number>("get_volume"),
  setVolume: (percent: number) => invoke<void>("set_volume", { percent }),
  setMuted: (muted: boolean) => invoke<void>("set_muted", { muted }),
  isMuted: () => invoke<boolean>("is_muted"),
  listOutputDevices: () => invoke<OutputDevice[]>("list_output_devices"),
  /** Makes the device the Windows default, so all sound (BEV included) follows. */
  setOutputDevice: (id: string) => invoke<void>("set_output_device", { id }),
  listAppAudio: () => invoke<AppAudio[]>("list_app_audio"),
  /** One app's own mixer slider; matched by name ("spotify", "discord"). */
  setAppAudio: (app: string, volume?: number, muted?: boolean) =>
    invoke<AppAudio[]>("set_app_audio", { app, volume: volume ?? null, muted: muted ?? null }),

  // Apps
  /** Installed Steam games. Rejects if Steam isn't installed. */
  listGames: () => invoke<InstalledGame[]>("list_games"),
  /** Through Steam: online = the game's first launch option, offline = its second. */
  launchGame: (id: string, mode: "online" | "offline") => invoke<string>("launch_game", { id, mode }),
  /** Open a file (default app) or folder (File Explorer) by full path. */
  openPath: (path: string) => invoke<string>("open_path", { path }),
  listProcesses: () => invoke<{ pid: number; name: string }[]>("list_processes"),

  // Windows
  listWindows: () => invoke<import("./windows").WinEntry[]>("list_windows"),
  focusWindow: (hwnd: number) => invoke<void>("focus_window", { hwnd }),

  // Overlay
  showOverlay: () => invoke<void>("show_overlay"),
  hideOverlay: () => invoke<void>("hide_overlay"),
  // Task journal (crash recovery)
  journalStart: (request: string) => invoke<number>("journal_start", { request }),
  journalStep: (id: number, tool: string, ok: boolean, summary: string) =>
    invoke<void>("journal_step", { id, tool, ok, summary }),
  journalFinish: (id: number, status: "done" | "failed" | "cancelled", result?: string) =>
    invoke<void>("journal_finish", { id, status, result }),
  journalRecent: (limit = 30) => invoke<TaskRun[]>("journal_recent", { limit }),
  journalTakeInterrupted: () => invoke<TaskRun[]>("journal_take_interrupted"),
  fullscreenState: () => invoke<"none" | "borderless" | "exclusive">("fullscreen_state"),
  setOverlayClickthrough: (ignore: boolean) =>
    invoke<void>("set_overlay_clickthrough", { ignore }),
  setOverlayPosition: (x: number, y: number) =>
    invoke<void>("set_overlay_position", { x, y }),
  placeOverlay: (corner: string, sizeLogical: number, monitor?: number) =>
    invoke<void>("place_overlay", { corner, sizeLogical, monitor }),

  // Secrets (OS keyring)
  storeSecret: (name: string, value: string) =>
    invoke<void>("store_secret", { name, value }),
  getSecret: (name: string) => invoke<string | null>("get_secret", { name }),
  deleteSecret: (name: string) => invoke<void>("delete_secret", { name }),

  // Memory + audit log
  memoryList: () => invoke<MemoryRow[]>("memory_list"),
  memoryUpsert: (key: string, value: string, category?: string) =>
    invoke<void>("memory_upsert", { key, value, category }),
  memoryDelete: (id: number) => invoke<void>("memory_delete", { id }),
  logAction: (tool: string, args: string | null, result: string | null, ok: boolean) =>
    invoke<void>("log_action", { tool, args, result, ok }),
  actionLogList: (limit?: number) => invoke<ActionLogRow[]>("action_log_list", { limit }),
  actionLogClear: () => invoke<void>("action_log_clear"),
  dataCounts: () => invoke<{ memories: number; notes: number; conversation_messages: number; activity: number }>("data_counts"),
  memoriesClear: () => invoke<void>("memories_clear"),
  notesClear: () => invoke<void>("notes_clear"),
  activityClear: () => invoke<void>("activity_clear"),

  // System actions
  lockPc: () => invoke<void>("lock_pc"),
  powerAction: (action: "sleep" | "restart" | "shutdown" | "cancel", delaySecs?: number) =>
    invoke<string>("power_action", { action, delaySecs }),
  captureScreen: (target?: "auto" | "current" | "primary" | "all" | `window:${number}`) =>
    invoke<ScreenCapture>("capture_screen", { target }),
  foregroundWindow: () => invoke<ForegroundWindow | null>("foreground_window"),
  // Screen replay: the last few seconds of the display the mouse is on, in RAM only.
  replayConfigure: (enabled: boolean) => invoke<ReplayStatus>("replay_configure", { enabled }),
  replayStatus: () => invoke<ReplayStatus>("replay_status"),
  replayClip: (seconds: number, maxFrames?: number) => invoke<ReplayClip>("replay_clip", { seconds, maxFrames }),
  takeScreenshot: (monitor?: number) => invoke<string>("take_screenshot", { monitor }),
  deleteTempFile: (path: string) => invoke<void>("delete_temp_file", { path }),
  openSettingsPage: (page: string) => invoke<string>("open_settings_page", { page }),
  listMonitors: () => invoke<MonitorInfo[]>("list_monitors"),

  // Vision & control (control/ in Rust)
  uiRead: (hwnd?: number) => invoke<UiSnapshot>("ui_read", { hwnd }),
  uiAct: (id: number, action: string, text?: string) => invoke<ActResult>("ui_act", { id, action, text }),
  screenOcr: (target?: "window" | "screen" | "all" | `window:${number}`) => invoke<OcrResult>("screen_ocr", { target }),
  inputKeys: (keys: string) => invoke<InputTarget>("input_keys", { keys }),
  inputType: (text: string) => invoke<InputTarget>("input_type", { text }),
  inputClick: (x: number, y: number, space: "screen" | "screenshot", button?: "left" | "right", double?: boolean) =>
    invoke<ClickResult>("input_click", { x, y, space, button, double }),
  inputScroll: (direction: "up" | "down" | "left" | "right", amount?: number, x?: number, y?: number, space: "screen" | "screenshot" = "screenshot") =>
    invoke<ClickResult>("input_scroll", { x, y, space, direction, amount }),
  inputHover: (x: number, y: number, space: "screen" | "screenshot") => invoke<ClickResult>("input_hover", { x, y, space }),
  inputDrag: (fromX: number, fromY: number, toX: number, toY: number, space: "screen" | "screenshot" = "screenshot") =>
    invoke<ClickResult>("input_drag", { fromX, fromY, toX, toY, space }),
  // "Watch me" demonstrations.
  recordStart: () => invoke<void>("record_start"),
  recordStop: () => invoke<import("@/ai/demonstration").RecEvent[]>("record_stop"),
  recordStatus: () => invoke<{ recording: boolean; events: number }>("record_status"),
  pointInfo: (x: number, y: number, space: "screen" | "screenshot") => invoke<PointInfo | null>("point_info", { x, y, space }),
  inputTarget: () => invoke<InputTarget | null>("input_target"),

  // Diagnostics (read-only)
  diagSystem: () => invoke<SystemFacts>("diag_system"),
  diagNetwork: () => invoke<NetworkFacts>("diag_network"),
  diagEvents: (minutes?: number) => invoke<EventFacts>("diag_events", { minutes }),
  diagDevices: () => invoke<DeviceFacts>("diag_devices"),

  // Second brain (brain.rs)
  convAdd: (session: string, role: "user" | "assistant", text: string) => invoke<number>("conv_add", { session, role, text }),
  convSearch: (query: string, limit?: number) => invoke<ConvHit[]>("conv_search", { query, limit }),
  convSession: (session: string) => invoke<ConvMessage[]>("conv_session", { session }),
  convSessions: (limit?: number) => invoke<ConvSession[]>("conv_sessions", { limit }),
  convPrune: (keepDays: number) => invoke<number>("conv_prune", { keepDays }),
  convClear: () => invoke<void>("conv_clear"),
  notesList: () => invoke<Note[]>("notes_list"),
  noteGet: (id: number) => invoke<Note | null>("note_get", { id }),
  noteSave: (n: { id?: number; title: string; body: string; source?: string; tags?: string }) => invoke<number>("note_save", n),
  noteDelete: (id: number) => invoke<void>("note_delete", { id }),
  notesSearch: (query: string, limit?: number) => invoke<NoteHit[]>("notes_search", { query, limit }),
  setEmbedding: (kind: "memory" | "note", id: number, vec: string) => invoke<void>("set_embedding", { kind, id, vec }),
  // Connectors (integrations.rs)
  integrationAllowOrigin: (url: string) => invoke<string>("integration_allow_origin", { url }),
  integrationForgetOrigin: (url: string) => invoke<void>("integration_forget_origin", { url }),
  integrationFetch: (url: string, method?: string, headers?: Array<[string, string]>, body?: string) =>
    invoke<{ status: number; headers: Array<[string, string]>; body: string; content_type: string }>("integration_fetch", { url, method, headers, body }),
  oauthListen: (port?: number) => invoke<number>("oauth_listen", { port }),
  oauthWait: (port: number, timeoutSecs?: number) => invoke<string>("oauth_wait", { port, timeoutSecs }),
  mcpSpawn: (id: string, command: string, args: string[], env?: Record<string, string>) => invoke<void>("mcp_spawn", { id, command, args, env }),
  mcpSend: (id: string, message: string, timeoutSecs?: number) => invoke<string | null>("mcp_send", { id, message, timeoutSecs }),
  mcpKill: (id: string) => invoke<void>("mcp_kill", { id }),
  webFetch: (url: string) => invoke<{ status: number; url: string; content_type: string; body: string }>("web_fetch", { url }),
  embeddingsList: (kind: "memory" | "note") => invoke<Array<{ id: number; vec: string }>>("embeddings_list", { kind }),
};

export interface ConvHit {
  id: number;
  session: string;
  role: "user" | "assistant";
  snippet: string;
  at: number;
}
export interface ConvMessage {
  role: "user" | "assistant";
  text: string;
  at: number;
}
export interface ConvSession {
  session: string;
  started: number;
  first: string;
  count: number;
}
export interface Note {
  id: number;
  title: string;
  body: string;
  source: string;
  tags: string;
  created_at: number;
  updated_at: number;
  has_embedding: boolean;
}
export interface NoteHit {
  id: number;
  title: string;
  snippet: string;
  source: string;
  updated_at: number;
}

export interface UiElement {
  id: number;
  role: string;
  name: string;
  value?: string;
  actions: string[];
  enabled: boolean;
  state?: string;
  password: boolean;
  /** x, y, width, height in desktop pixels. */
  rect: [number, number, number, number];
}
export interface UiSnapshot {
  title: string;
  process: string;
  hwnd: number;
  elements: UiElement[];
  truncated: boolean;
}
export interface ActResult {
  done: string;
  verified: boolean;
  detail: string;
}
export interface OcrWord {
  text: string;
  rect: [number, number, number, number];
}
export interface OcrLine extends OcrWord {
  words: OcrWord[];
}
export interface OcrResult {
  source: string;
  lines: OcrLine[];
}
export interface InputTarget {
  title: string;
  process: string;
  hwnd: number;
}
export interface PointInfo {
  name: string;
  role: string;
  process: string;
  password: boolean;
}
export interface ClickResult {
  x: number;
  y: number;
  target: PointInfo | null;
}
export interface Probe {
  ok: boolean;
  ms: number | null;
  error: string | null;
}
export interface SystemFacts {
  cpu: number;
  cores: number;
  mem_used_mb: number;
  mem_total_mb: number;
  uptime_secs: number;
  disks: Array<{ mount: string; total_gb: number; free_gb: number }>;
  top_cpu: Array<{ name: string; cpu: number; mem_mb: number }>;
  top_mem: Array<{ name: string; cpu: number; mem_mb: number }>;
  pending_reboot: boolean;
}
export interface NetworkFacts {
  dns: Probe;
  direct: Array<[string, Probe]>;
  named: Probe;
}
export interface EventFacts {
  app: Array<{ t: string; kind: "crash" | "hang"; app: string }>;
  system: Array<{ t: string; id: number; provider: string }>;
}

export interface TaskRun {
  id: number;
  request: string;
  status: "running" | "done" | "failed" | "cancelled" | "interrupted";
  steps: Array<{ tool: string; ok: boolean; summary: string }>;
  result: string | null;
  started_at: number;
  ended_at: number | null;
}

export interface ReplayStatus {
  enabled: boolean;
  keep_secs: number;
  /** How far back the buffer currently reaches. */
  buffered_secs: number;
}

export interface ReplayFrame {
  /** Base64 JPEG. */
  data: string;
  width: number;
  height: number;
  /** Seconds before the request this frame was taken. */
  ago_secs: number;
  label: string;
}

export interface ReplayClip {
  frames: ReplayFrame[];
  covered_secs: number;
  keep_secs: number;
}

export interface ScreenCapture {
  /** Base64 JPEG. */
  data: string;
  width: number;
  height: number;
  label: string;
}

export interface ForegroundWindow {
  title: string;
  process: string;
}

export interface ActionLogRow {
  id: number;
  tool: string;
  args: string | null;
  result: string | null;
  ok: boolean;
  at: number;
}

export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  scale: number;
  primary: boolean;
}

export interface DeviceFacts {
  problems: Array<{ name: string; class: string; status: string; code: number }>;
  stopped: Array<{ name: string; display: string }>;
  drivers: Array<{ device: string; class: string; version: string; date: string }>;
}
