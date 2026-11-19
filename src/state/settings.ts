import { create } from "zustand";
import { load, Store } from "@tauri-apps/plugin-store";
import { emit, listen } from "@tauri-apps/api/event";

/**
 * Persistent, non-secret settings. Survives restarts via tauri-plugin-store
 * (settings.json in the app data dir). Secrets NEVER live here — they go to
 * the OS keyring through native.storeSecret.
 */
import type { ProviderId } from "@/ai/catalog";
export type { ProviderId };

/** The model a provider uses for real work, and for quick replies ("" = the same). */
export interface ProviderModels {
  model: string;
  fast: string;
}
export type Personality = "professional" | "casual" | "minimal" | "technical" | "custom";
export type WakeEngine = "speech" | "on-device";
export type GamePopup = "auto" | "show" | "hide";
export type OverlayCorner = "top-right" | "top-left" | "bottom-right" | "bottom-left" | "center";

export interface McpServerConfig {
  id: string;
  name: string;
  /** "stdio" runs a program on this PC; "http" talks to a URL. */
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  /** Ask before each of its actions (default). Off only for servers you trust. */
  confirmActions: boolean;
}

export interface IntegrationSettings {
  homeassistant: { enabled: boolean; url: string };
  github: { enabled: boolean };
  discord?: { enabled: boolean };
  spotify: { enabled: boolean; clientId: string };
  google: { enabled: boolean; clientId: string };
  mcp: McpServerConfig[];
}

export interface Settings {
  onboarded: boolean;
  // AI
  /** The main AI: tried first for everything. */
  provider: ProviderId;
  /** Chosen models per provider (missing = the provider's defaults). */
  models: Partial<Record<ProviderId, ProviderModels>>;
  /** Backups, in order, tried when the main AI can't answer (offline, out of credit, down). */
  fallbacks: ProviderId[];
  /** Send quick, simple requests to a faster, cheaper model. */
  modelRouting: boolean;
  /** Show and speak replies while they're being written. */
  streamReplies: boolean;
  /** Remember the steps of hands-on tasks and repeat them next time. */
  learnTasks: boolean;
  /** "Ask about your documents": folders BEV reads, and when it last read them. */
  documents: { folders: string[]; lastIndexed?: number };
  ollamaHost: string;
  personality: Personality;
  customPersonality: string;
  /** What BEV calls the user now and then ("sir", a name). Empty: nothing. */
  addressAs: string;
  responseLength: "short" | "normal" | "detailed";
  // Voice
  micDeviceId: string;
  /** Speech recognition: Windows (online, default mic only) or Whisper (on this PC, BEV's chosen mic). */
  sttEngine: "windows" | "whisper";
  whisperSize: "base" | "small";
  /** Windows/Chromium noise suppression on BEV's mic (helps noisy rooms; can hurt clean mics). */
  noiseSuppression: boolean;
  /** Talk over BEV to interrupt it. */
  bargeIn: boolean;
  /** Keep a searchable history of conversations on this PC. */
  keepHistory: boolean;
  /** Days of history to keep. */
  historyDays: number;
  /** Search memories and notes by meaning (small model on this PC). */
  semanticSearch: boolean;
  /** Connector settings (tokens live in the OS keyring, never here). */
  integrations: IntegrationSettings;
  /** Which voice engine speaks: Windows (built-in), Kokoro (free, local) or ElevenLabs. */
  ttsEngine: "windows" | "kokoro" | "elevenlabs";
  /** Windows voice (when ttsEngine is "windows"). */
  voiceId: string;
  kokoroVoice: string;
  /** Run Kokoro on the graphics card (WebGPU) when available. */
  kokoroUseGpu: boolean;
  elevenVoiceId: string;
  elevenVoiceName: string;
  speakRate: number;
  speakVolume: number;
  /** "speech" = WebView2 speech recognition; "on-device" = openWakeWord model. */
  wakeEngine: WakeEngine;
  wakeSensitivity: number; // 0..1
  conversationTimeoutMs: number;
  /** After a reply: "smart" listens properly only when BEV asked something and
   *  ignores talk meant for other people; "always" keeps listening; "off" stops. */
  followUpMode: "smart" | "always" | "off";
  pushToTalkShortcut: string;
  /** BEV Cloud (Telegram, task tracking, calls) address; "" = not connected. Key is in the keyring. */
  bevCloudUrl: string;
  /** Global hotkey that mutes / unmutes BEV's microphone ("" = none). */
  muteShortcut: string;
  interfaceSounds: boolean;
  /** Use the "hey BEV" model that ships with BEV (on-device engine). */
  builtInWakeModel: boolean;
  /**
   * The orb while a fullscreen game or app is in front. auto = show it over
   * borderless/windowed fullscreen (it never takes focus), hide it over
   * exclusive fullscreen where any window on top can knock the game out of
   * fullscreen. BEV still listens and talks either way.
   */
  gamePopup: GamePopup;
  // Appearance
  accent: string;
  overlayCorner: OverlayCorner;
  overlayScale: number;
  reducedMotion: boolean;
  // General
  startWithWindows: boolean;
  closeToTray: boolean; // X hides to tray instead of quitting
  minimizeToTray: boolean; // – hides to tray instead of minimising
  /** Begin listening for the wake word automatically on launch. */
  listenOnStartup: boolean;
  gamingQuietMode: boolean;
  /** Go quiet by itself while a game is running. */
  autoGamingMode: boolean;
  proactiveMonitoring: boolean;
  /** What BEV keeps an eye on while proactive monitoring is on. */
  watch: { crashes: boolean; network: boolean; disk: boolean };
  /** Daily briefing time "HH:MM", or "" for none. */
  briefingTime: string;
  /** Speak the briefing (if BEV isn't busy), as well as notifying. */
  briefingSpoken: boolean;
  cpuAlertPercent: number;
  ramAlertPercent: number;
  /** Keep the recent past (up to 15 minutes) of the screen the mouse is on,
   *  in memory only, so the user can ask BEV to look back. Off until the user
   *  turns it on. */
  screenReplay: boolean;
  // Permissions: tool name → allowed
  toolPermissions: Record<string, boolean>;
  /** When true, a spoken/typed request is itself the approval — sensitive tools
   *  run without the Approve/Cancel modal. Off by default. */
  autoApproveActions: boolean;
}

export const defaultSettings: Settings = {
  onboarded: false,
  provider: "anthropic",
  models: {},
  fallbacks: [],
  modelRouting: true,
  streamReplies: true,
  learnTasks: true,
  documents: { folders: [] },
  ollamaHost: "http://localhost:11434",
  personality: "casual",
  addressAs: "sir",
  customPersonality: "",
  responseLength: "short",
  micDeviceId: "",
  sttEngine: "windows",
  whisperSize: "base",
  noiseSuppression: false,
  bargeIn: true,
  keepHistory: true,
  historyDays: 90,
  semanticSearch: true,
  integrations: { homeassistant: { enabled: false, url: "" }, github: { enabled: false }, spotify: { enabled: false, clientId: "" }, google: { enabled: false, clientId: "" }, mcp: [] },
  ttsEngine: "windows",
  voiceId: "",
  kokoroVoice: "bm_george",
  kokoroUseGpu: true,
  elevenVoiceId: "",
  elevenVoiceName: "",
  speakRate: 1.02,
  speakVolume: 1,
  wakeEngine: "on-device",
  wakeSensitivity: 0.6,
  conversationTimeoutMs: 8000,
  followUpMode: "smart",
  pushToTalkShortcut: "CommandOrControl+Alt+B",
  muteShortcut: "",
  bevCloudUrl: "",
  interfaceSounds: true,
  builtInWakeModel: true,
  gamePopup: "auto",
  accent: "#4ecdde",
  overlayCorner: "top-right",
  overlayScale: 1,
  reducedMotion: false,
  startWithWindows: false,
  closeToTray: true,
  minimizeToTray: false,
  listenOnStartup: true,
  gamingQuietMode: false,
  autoGamingMode: true,
  proactiveMonitoring: false,
  watch: { crashes: true, network: true, disk: true },
  briefingTime: "",
  briefingSpoken: true,
  cpuAlertPercent: 90,
  ramAlertPercent: 90,
  screenReplay: false,
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
      const merged = migrateAi({ ...defaultSettings, ...saved }, saved as Record<string, unknown>);
      // 1.1.5 ships a built-in "hey BEV" model: move existing installs that
      // were on speech recognition (the old default) onto it, once.
      if (Object.keys(saved).length && !("builtInWakeModel" in saved)) merged.wakeEngine = "on-device";
      set({ settings: merged, loaded: true });
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
    // Resetting preferences shouldn't send the user back through first-run setup.
    const next = { ...defaultSettings, onboarded: get().settings.onboarded };
    set({ settings: next });
    emit("bev://settings", next).catch(() => {});
    try {
      const s = await getStore();
      await s.set("settings", next);
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

/**
 * Before 1.6 each provider had its own model fields (anthropicModel,
 * openaiFastModel…). Carry those choices into `models`, once.
 */
export function migrateAi(s: Settings, saved: Record<string, unknown>): Settings {
  if (saved.models) return s;
  const models: Partial<Record<ProviderId, ProviderModels>> = {};
  const str = (k: string) => (typeof saved[k] === "string" ? (saved[k] as string) : undefined);
  for (const p of ["anthropic", "openai", "ollama"] as const) {
    const model = str(`${p}Model`);
    const fast = str(`${p}FastModel`);
    if (model !== undefined || fast !== undefined) models[p] = { model: model ?? "", fast: fast ?? "" };
  }
  const out = { ...s, models } as Settings & Record<string, unknown>;
  for (const k of ["anthropicModel", "openaiModel", "ollamaModel", "anthropicFastModel", "openaiFastModel", "ollamaFastModel"]) delete out[k];
  return out;
}
