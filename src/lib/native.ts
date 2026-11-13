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

  // Apps
  launchApp: (name: string) => invoke<string>("launch_app", { name }),
  closeApp: (name: string) => invoke<string>("close_app", { name }),
  listProcesses: () => invoke<{ pid: number; name: string }[]>("list_processes"),

  // Windows
  listWindows: () => invoke<{ hwnd: number; title: string }[]>("list_windows"),
  focusWindow: (hwnd: number) => invoke<void>("focus_window", { hwnd }),

  // Overlay
  showOverlay: () => invoke<void>("show_overlay"),
  hideOverlay: () => invoke<void>("hide_overlay"),
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

  // System actions
  lockPc: () => invoke<void>("lock_pc"),
  powerAction: (action: "sleep" | "restart" | "shutdown" | "cancel", delaySecs?: number) =>
    invoke<string>("power_action", { action, delaySecs }),
  takeScreenshot: (monitor?: number) => invoke<string>("take_screenshot", { monitor }),
  deleteTempFile: (path: string) => invoke<void>("delete_temp_file", { path }),
  openSettingsPage: (page: string) => invoke<string>("open_settings_page", { page }),
  listMonitors: () => invoke<MonitorInfo[]>("list_monitors"),
};

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
