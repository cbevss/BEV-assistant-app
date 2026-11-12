import { create } from "zustand";
import { load, Store } from "@tauri-apps/plugin-store";
import { emit, listen } from "@tauri-apps/api/event";

/**
 * Persistent, non-secret settings. Survives restarts via tauri-plugin-store
 * (settings.json in the app data dir). Secrets NEVER live here — they go to
 * the OS keyring through native.storeSecret.
 */
export type ProviderId = "anthropic" | "openai" | "ollama";
export type Personality = "professional" | "casual" | "minimal" | "technical" | "custom";
export type OverlayCorner = "top-right" | "top-left" | "bottom-right" | "bottom-left" | "center";

export interface Settings {
  onboarded: boolean;
  // AI
  provider: ProviderId;
  anthropicModel: string;
  openaiModel: string;
  ollamaModel: string;
  ollamaHost: string;
  personality: Personality;
  customPersonality: string;
  responseLength: "short" | "normal" | "detailed";
  // Voice
  micDeviceId: string;
  voiceId: string;
  speakRate: number;
  speakVolume: number;
  wakeSensitivity: number; // 0..1
  conversationTimeoutMs: number;
  pushToTalkShortcut: string;
  interfaceSounds: boolean;
  // Appearance
  accent: string;
  overlayCorner: OverlayCorner;
  overlayScale: number;
  reducedMotion: boolean;
  // General
  startWithWindows: boolean;
  /** Begin listening for the wake word automatically on launch. */
  listenOnStartup: boolean;
  gamingQuietMode: boolean;
  proactiveMonitoring: boolean;
  cpuAlertPercent: number;
  ramAlertPercent: number;
  // Permissions: tool name → allowed
  toolPermissions: Record<string, boolean>;
  /** When true, a spoken/typed request is itself the approval — sensitive tools
   *  run without the Approve/Cancel modal. Off by default. */
  autoApproveActions: boolean;
}

export const defaultSettings: Settings = {
  onboarded: false,
  provider: "anthropic",
  anthropicModel: "claude-sonnet-5-5",
  openaiModel: "gpt-4.1-mini",
  ollamaModel: "llama3.1",
  ollamaHost: "http://localhost:11434",
  personality: "casual",
  customPersonality: "",
  responseLength: "short",
  micDeviceId: "",
  voiceId: "",
  speakRate: 1.02,
  speakVolume: 1,
  wakeSensitivity: 0.6,
  conversationTimeoutMs: 8000,
  pushToTalkShortcut: "CommandOrControl+Alt+B",
  interfaceSounds: true,
  accent: "#22d3ee",
  overlayCorner: "top-right",
  overlayScale: 1,
  reducedMotion: false,
  startWithWindows: false,
  listenOnStartup: true,
  gamingQuietMode: false,
  proactiveMonitoring: false,
  cpuAlertPercent: 90,
  ramAlertPercent: 90,
  toolPermissions: {},
  autoApproveActions: false,
};

interface SettingsStore {
  settings: Settings;
  loaded: boolean;
  init: () => Promise<void>;
  update: (patch: Partial<Settings>) => Promise<void>;
  reset: () => Promise<void>;
}

let store: Store | null = null;
const getStore = async () => (store ??= await load("settings.json", { autoSave: true }));

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: defaultSettings,
  loaded: false,

  init: async () => {
    try {
      const s = await getStore();
      const saved = (await s.get<Partial<Settings>>("settings")) ?? {};
      // Merge onto defaults so new keys added in updates get sane values.
      set({ settings: { ...defaultSettings, ...saved }, loaded: true });
    } catch {
      // Store unavailable (e.g. browser preview) — run on defaults, flagged loaded.
      set({ loaded: true });
    }
  },

  update: async (patch) => {
    const next = { ...get().settings, ...patch };
    set({ settings: next });
    // Each window has its own store instance; broadcast so the overlay follows.
    emit("bev://settings", next).catch(() => {});
    try {
      const s = await getStore();
      await s.set("settings", next);
    } catch {
      /* persisted best-effort; in-memory value still applies */
    }
  },

  reset: async () => {
    set({ settings: defaultSettings });
    try {
      const s = await getStore();
      await s.set("settings", defaultSettings);
    } catch {
      /* ignore */
    }
  },
}));

/** Follow settings changes made in another window (used by the overlay). */
export function followSettingsBroadcasts(): Promise<() => void> {
  return listen<Settings>("bev://settings", (e) => {
    useSettings.setState({ settings: { ...defaultSettings, ...e.payload }, loaded: true });
  });
}

/** Tool permission check: default-allow non-sensitive, honour explicit revokes. */
export function toolAllowed(name: string): boolean {
  const p = useSettings.getState().settings.toolPermissions[name];
  return p !== false;
}

/** When on, the user's request itself counts as approval for sensitive tools. */
export function autoApproveOn(): boolean {
  return useSettings.getState().settings.autoApproveActions === true;
}
