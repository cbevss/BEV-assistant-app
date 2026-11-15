import { native } from "./native";
import { useSettings, type GamePopup } from "@/state/settings";

export type FullscreenState = "none" | "borderless" | "exclusive";

/** Should the orb appear, given the setting and what's in front? */
export function popupAllowed(mode: GamePopup, fs: FullscreenState): boolean {
  if (fs === "none" || mode === "show") return true;
  if (mode === "hide") return false;
  // auto: the orb never takes focus, so it's fine over borderless games;
  // exclusive fullscreen can drop out of fullscreen if anything draws on top.
  return fs === "borderless";
}

/**
 * Show the orb unless a fullscreen game says otherwise. Returns whether it was
 * shown. BEV still listens and speaks when it isn't.
 */
export async function showOverlayUnlessGaming(): Promise<boolean> {
  let fs: FullscreenState = "none";
  try {
    fs = await native.fullscreenState();
  } catch {
    /* can't tell: treat as the normal desktop */
  }
  if (!popupAllowed(useSettings.getState().settings.gamePopup, fs)) return false;
  await native.showOverlay().catch(() => {});
  return true;
}
