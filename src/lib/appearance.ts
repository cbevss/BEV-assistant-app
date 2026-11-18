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
    // The old default cyan was retuned for the new surfaces.
    const rgb = hexToRgb(s.accent.toLowerCase() === "#22d3ee" ? "#4ecdde" : s.accent);
    if (rgb) {
      const root = document.documentElement.style;
      root.setProperty("--accent", rgb.join(" "));
      root.setProperty("--accent-strong", rgb.map((c) => Math.round(c + (255 - c) * 0.4)).join(" "));
      // Dark text on light accents, light text on dark ones.
      const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
      root.setProperty("--accent-ink", lum > 0.5 ? "4 20 23" : "240 248 250");
    }
    document.documentElement.dataset.reducedMotion = s.reducedMotion ? "true" : "false";
  } catch {
    /* no DOM (shouldn't happen in the webview) */
  }
  native.placeOverlay(s.overlayCorner, OVERLAY_BASE * s.overlayScale).catch(() => {});
}

/** "#4ecdde" → [78, 205, 222]; null for anything else. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
