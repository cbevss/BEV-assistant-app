import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { preloadKokoro, setKokoroGpu } from "./tts/kokoro";
import { listen } from "@tauri-apps/api/event";
import { VoiceController } from "./controller";
import { useAssistant } from "@/state/assistant";
import { useSettings } from "@/state/settings";
import { watchMics } from "./mic";
import { preloadWhisper } from "./stt/whisper";

let controller: VoiceController | null = null;
let starting: Promise<VoiceController> | null = null;
type ShortcutKind = "pushToTalk" | "mute";
const registered: Record<ShortcutKind, string | null> = { pushToTalk: null, mute: null };

/**
 * Wires the voice vertical slice: creates the VoiceController, binds the
 * push-to-talk shortcut and tray events. Idempotent and safe under React
 * StrictMode's double-invoke (concurrent callers share one start promise).
 */
export function bootstrapVoice(): Promise<VoiceController> {
  if (controller) return Promise.resolve(controller);
  return (starting ??= start());
}

async function start(): Promise<VoiceController> {
  const c = new VoiceController();
  controller = c;

  const st = useSettings.getState().settings;
  await bindShortcut("pushToTalk", st.pushToTalkShortcut);
  await bindShortcut("mute", st.muteShortcut);

  listen("tray://toggle-listen", () => {
    if (useAssistant.getState().micEnabled) c.disableListening();
    else c.enableListening();
  });

  // Tray "Privacy mode" is a toggle.
  listen("tray://privacy-mode", () => setPrivacy(!useAssistant.getState().privacyMode));

  // Mic plugged in or removed: switch to the right one without a restart.
  watchMics(async () => {
    if (c.busy || c.isHeld || !useAssistant.getState().micEnabled) return;
    if (await c.micChanged()) await restartListening();
  });

  // Load the on-PC recogniser early so the first request isn't slow.
  const s0 = useSettings.getState().settings;
  if (s0.sttEngine === "whisper") setTimeout(() => preloadWhisper(s0.whisperSize, s0.kokoroUseGpu), 4000);

  // Warm up the free natural voice in the background (it's cached after the
  // first download), so the first reply doesn't fall back to Windows.
  if (useSettings.getState().settings.ttsEngine === "kokoro") {
    setTimeout(() => {
      setKokoroGpu(useSettings.getState().settings.kokoroUseGpu);
      preloadKokoro().catch(() => {});
    }, 3000);
  }

  // Start listening for "BEV" automatically, so the assistant is actually
  // available on launch. Opt out in Settings, or Privacy mode kills it.
  maybeStartListening();

  return c;
}

/**
 * (Re)bind a global hotkey: push-to-talk or mic mute. Takes effect at once.
 * Returns an error string if Windows wouldn't register it (e.g. in use).
 */
export async function bindShortcut(kind: ShortcutKind, accelerator: string): Promise<string | null> {
  const old = registered[kind];
  if (old) {
    await unregister(old).catch(() => {});
    registered[kind] = null;
  }
  if (!accelerator.trim()) return null;
  const other = registered[kind === "mute" ? "pushToTalk" : "mute"];
  if (other && other.toLowerCase() === accelerator.toLowerCase()) {
    return "That's already the other BEV shortcut.";
  }
  try {
    await register(accelerator, (e) => {
      if (e.state !== "Pressed") return;
      if (kind === "mute") controller?.toggleMute();
      else controller?.onWake();
    });
    registered[kind] = accelerator;
    return null;
  } catch (e) {
    return `Couldn't use ${accelerator}: another app may already have it. (${String(e)})`;
  }
}

/** Kept for older callers: rebinds push-to-talk. */
export const applyShortcut = (accelerator: string) => bindShortcut("pushToTalk", accelerator);

export async function teardownVoice() {
  for (const k of ["pushToTalk", "mute"] as const) {
    const a = registered[k];
    if (a) await unregister(a).catch(() => {});
    registered[k] = null;
  }
  controller?.disableListening();
  controller = null;
  starting = null;
}

export const getController = () => controller;

/**
 * The single switch for privacy mode, used by the tray, the Security page and
 * the sidebar. Turning it on stops the wake-word listener and microphone
 * immediately (flipping the flag alone leaves the mic running). Turning it off
 * only lifts the block; the user re-enables listening deliberately.
 */
export function setPrivacy(on: boolean) {
  if (on) controller?.disableListening();
  useAssistant.getState().setPrivacyMode(on);
}

/**
 * Pause BEV's listening while a microphone test runs; call the returned
 * function when the test ends (it's safe to call more than once).
 */
export function holdListening(): () => void {
  const c = controller;
  if (!c) return () => {};
  c.hold();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    void c.release();
  };
}

/** Restart listening so a changed engine, model or mic takes effect now. */
export async function restartListening() {
  if (controller && !controller.isHeld && useAssistant.getState().micEnabled) {
    controller.disableListening();
    await controller.enableListening();
  }
}

/** Start the wake-word listener if the user wants it on launch. */
export function maybeStartListening() {
  const s = useSettings.getState().settings;
  if (controller && s.onboarded && s.listenOnStartup && !useAssistant.getState().privacyMode) {
    controller.enableListening().catch(() => {});
  }
}
