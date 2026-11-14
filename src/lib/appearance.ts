import { native } from "@/lib/native";
import type { Settings } from "@/state/settings";
import { OVERLAY_BASE } from "./overlayPlacement";

/**
 * Apply visual settings. Accent becomes a CSS variable the UI reads; overlay
 * corner/size move the real overlay window via the native command (works
 * regardless of the overlay webview, since Rust owns the window).
 */
export function applyAppearance(s: Settings) {
  try {
    document.documentElement.style.setProperty("--bev-accent", s.accent);
    document.documentElement.dataset.reducedMotion = s.reducedMotion ? "true" : "false";
  } catch {
    /* no DOM (shouldn't happen in the webview) */
  }
  native.placeOverlay(s.overlayCorner, OVERLAY_BASE * s.overlayScale).catch(() => {});
}
