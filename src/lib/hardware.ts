/** PC settings BEV can change directly (see src-tauri/src/hardware.rs). */
import { invoke } from "@tauri-apps/api/core";

export const hardwareApi = {
  powerPlans: () => invoke<Array<{ id: string; name: string; active: boolean }>>("power_plans"),
  setPowerPlan: (name: string) => invoke<string>("set_power_plan", { name }),
  brightness: () => invoke<Array<{ index: number; name: string; percent: number }>>("monitor_brightness"),
  setBrightness: (percent: number, index?: number) => invoke<string>("set_monitor_brightness", { percent, index }),
  setTheme: (dark: boolean) => invoke<string>("set_theme", { dark }),
  mediaKey: (action: "play_pause" | "next" | "previous" | "stop") => invoke<string>("media_key", { action }),
  setWallpaper: (path: string) => invoke<string>("set_wallpaper", { path }),
  emptyRecycleBin: () => invoke<string>("empty_recycle_bin"),
};

const ALIASES: Array<[RegExp, RegExp]> = [
  [/\b(headset|headphones?|earphones?|earbuds?|cans)\b/, /headset|headphone|earphone|earbud|arctis|hyperx|airpods|buds|kraken|cloud|wh-|nova/],
  [/\b(speakers?)\b/, /speaker|realtek|logitech z|soundbar/],
  [/\b(monitor|screen|display|tv|hdmi)\b/, /hdmi|display|nvidia high definition|amd high definition|monitor|tv/],
  [/\b(mic|microphone)\b/, /mic/],
];

/**
 * Pure: the device the user means. Exact or partial name first, then the
 * kind of device ("headset", "speakers"). Null when it's unclear (none, or
 * several equally good).
 */
export function matchDevice<T extends { name: string }>(devices: T[], wanted: string): T | null {
  const w = wanted.trim().toLowerCase();
  if (!w) return null;
  const exact = devices.find((d) => d.name.toLowerCase() === w);
  if (exact) return exact;
  const partial = devices.filter((d) => d.name.toLowerCase().includes(w));
  if (partial.length === 1) return partial[0];
  const words = w.split(/\s+/).filter((x) => x.length > 2 && !["my", "the"].includes(x));
  const byWords = devices.filter((d) => words.some((x) => d.name.toLowerCase().includes(x)));
  if (byWords.length === 1) return byWords[0];
  for (const [said, looks] of ALIASES) {
    if (!said.test(w)) continue;
    const hits = devices.filter((d) => looks.test(d.name.toLowerCase()));
    if (hits.length === 1) return hits[0];
  }
  return null;
}
