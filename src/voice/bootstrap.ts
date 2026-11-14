import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { listen } from "@tauri-apps/api/event";
import { VoiceController } from "./controller";
import { useAssistant } from "@/state/assistant";
import { useSettings } from "@/state/settings";

let controller: VoiceController | null = null;
let starting: Promise<VoiceController> | null = null;
let registeredShortcut: string | null = null;

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

  await applyShortcut(useSettings.getState().settings.pushToTalkShortcut);

  listen("tray://toggle-listen", () => {
    if (useAssistant.getState().micEnabled) c.disableListening();
    else c.enableListening();
  });

  // Tray "Privacy mode" is a toggle.
  listen("tray://privacy-mode", () => setPrivacy(!useAssistant.getState().privacyMode));

  // Start listening for "BEV" automatically, so the assistant is actually
  // available on launch. Opt out in Settings, or Privacy mode kills it.
  maybeStartListening();

  return c;
}

/** (Re)bind the push-to-talk shortcut. Returns an error string on failure. */
export async function applyShortcut(accelerator: string): Promise<string | null> {
  if (registeredShortcut) {
    await unregister(registeredShortcut).catch(() => {});
    registeredShortcut = null;
  }
  if (!accelerator.trim()) return null;
  try {
    await register(accelerator, (e) => {
      if (e.state === "Pressed") controller?.onWake();
    });
    registeredShortcut = accelerator;
    return null;
  } catch (e) {
    return `Shortcut "${accelerator}" could not be registered (it may be in use): ${String(e)}`;
  }
}

export async function teardownVoice() {
  if (registeredShortcut) await unregister(registeredShortcut).catch(() => {});
  registeredShortcut = null;
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

/** Restart listening so a changed engine, model or mic takes effect now. */
export async function restartListening() {
  if (controller && useAssistant.getState().micEnabled) {
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
