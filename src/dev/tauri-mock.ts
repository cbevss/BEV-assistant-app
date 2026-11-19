/**
 * Development-only stand-in for the Tauri runtime so the real UI can be
 * rendered in a normal browser for visual review (`npm run ui:preview`).
 * Never bundled into the app: only ui-preview.html imports it.
 */
const store = new Map<string, unknown>();
const params = new URLSearchParams(location.search);
store.set("settings.json:settings", { onboarded: params.get("onboarding") !== "1", userName: "Charlie", provider: "anthropic", models: { anthropic: { model: "claude-sonnet-5-5", fast: "claude-haiku-5-5" } }, fallbacks: ["openai", "gemini"] });

const now = Math.floor(Date.now() / 1000);
const data: Record<string, unknown> = {
  get_system_stats: { host: "CHARLIE-PC", cpu_usage: 23.4, cpu_cores: 12, mem_used_mb: 11234, mem_total_mb: 32768, mem_percent: 34.3, uptime_secs: 93600, gpu: null },
  get_running_apps: [
    { name: "chrome.exe", pid: 1, cpu: 6.1, mem_mb: 2310 },
    { name: "Discord.exe", pid: 2, cpu: 1.2, mem_mb: 640 },
    { name: "Spotify.exe", pid: 3, cpu: 0.8, mem_mb: 310 },
  ],
  get_volume: 0.42,
  is_muted: false,
  list_output_devices: [
    { id: "a", name: "Speakers (Realtek(R) Audio)", is_default: true },
    { id: "b", name: "Headphones (Arctis Nova 7)", is_default: false },
  ],
  list_input_devices: [{ id: "m", name: "Microphone (Blue Yeti)", is_default: true, muted: false, volume: 0.72 }],
  list_monitors: [{ index: 0, name: "Display 1", width: 2560, height: 1440, primary: true }],
  memory_list: [
    { id: 1, key: "main browser", value: "Chrome", category: "preferences", created_at: now, updated_at: now },
    { id: 2, key: "gaming headset", value: "Arctis Nova 7", category: "devices", created_at: now, updated_at: now },
    { id: 3, key: "favourite game", value: "Rocket League", category: "general", created_at: now, updated_at: now },
  ],
  journal_recent: [
    { id: 3, request: "open spotify and play my liked songs", status: "done", started_at: Date.now() - 300_000, finished_at: Date.now() - 290_000, steps: [], result: "Playing your Liked Songs." },
    { id: 2, request: "why is my pc slow", status: "done", started_at: Date.now() - 4_000_000, finished_at: Date.now() - 3_980_000, steps: [], result: "Chrome was using 2.3 GB." },
  ],
  journal_take_interrupted: [],
  conv_sessions: [{ session: "a", started: now - 7200, first: "what's the weather like for the match tonight", count: 6 }],
  notes_list: [],
  fullscreen_state: "none",
  action_log_list: [],
  foreground_window: { title: "Visual Studio Code", process: "Code.exe" },
  replay_configure: { enabled: false, keep_secs: 900, buffered_secs: 0 },
  data_counts: { memories: 42, notes: 7, conversation_messages: 1318, activity: 256 },
  replay_status: { enabled: false, keep_secs: 900, buffered_secs: 0 }, 
  input_target: null,
  embeddings_list: [],
  apps_status: { count: 214, scanned_at: Date.now() - 600_000, scanning: false, last_error: null },
  apps_list: [
    { name: "Spotify", kind: "packaged", source: "Start menu", exe_name: "Spotify.exe", aliases: [] },
    { name: "Discord", kind: "win32", source: "Start menu", exe_name: "Discord.exe", aliases: [] },
    { name: "Steam", kind: "win32", source: "Start menu", exe_name: "steam.exe", aliases: [] },
  ],
  list_games: [],
  list_processes: [],
  list_windows: [],
};

let cb = 1;
const w = window as unknown as Record<string, unknown>;
w.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  transformCallback: () => cb++,
  unregisterCallback: () => {},
  convertFileSrc: (p: string) => p,
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "plugin:store|load" || cmd === "plugin:store|get_store") return 1;
    if (cmd === "plugin:store|get") {
      const k = `${["settings.json", "routines.json"][0]}:${args.key}`;
      const v = store.get(k);
      return [v ?? null, v !== undefined];
    }
    if (cmd === "plugin:store|set") return null;
    if (cmd.startsWith("plugin:event|")) return cb++;
    if (cmd === "plugin:app|version") return "1.1.17";
    if (cmd === "get_secret") return ["anthropic_api_key", "openai_api_key", "gemini_api_key"].includes(String(args.name)) ? "sk-preview" : null;
    if (cmd in data) return structuredClone(data[cmd]);
    return null;
  },
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
