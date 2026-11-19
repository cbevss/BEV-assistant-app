/**
 * Gaming mode: notice when a game is running (Steam's running game, or any
 * full-screen exclusive app) and keep BEV out of the way while it is: short
 * replies, no spoken "Yeah?", no pop-ups. Also the graphics card readings.
 */
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useSettings, type Settings } from "@/state/settings";
import { native } from "./native";

export interface GpuStats {
  name: string | null;
  vram_total_mb: number | null;
  vram_used_mb: number | null;
  usage: number | null;
  temp_c: number | null;
  hotspot_c: number | null;
  mem_temp_c: number | null;
  clock_mhz: number | null;
  mem_clock_mhz: number | null;
  fan_rpm: number | null;
  fan_percent: number | null;
  power_w: number | null;
}

export const gpuApi = {
  stats: () => invoke<GpuStats>("gpu_stats"),
  runningGame: () => invoke<{ id: string; name: string | null } | null>("running_game"),
};

interface GamingState {
  /** The game being played, or null. */
  game: { name: string; since: number } | null;
}
export const useGaming = create<GamingState>(() => ({ game: null }));

/** Pure: should BEV keep it short right now? */
export function quietNow(s: Pick<Settings, "gamingQuietMode" | "autoGamingMode">, gaming: boolean): boolean {
  return s.gamingQuietMode || (s.autoGamingMode && gaming);
}

/** For call sites outside React. */
export const isQuiet = () => quietNow(useSettings.getState().settings, useGaming.getState().game !== null);

/**
 * Pure: the next gaming state from one look. A Steam game counts at once;
 * a full-screen app only after two looks in a row (so a quick full-screen
 * video doesn't flip it). Leaving needs two looks without either.
 */
export function nextGame(
  prev: GamingState["game"],
  look: { steamGame: string | null; exclusive: boolean },
  streak: { on: number; off: number },
  now: number,
): { game: GamingState["game"]; streak: { on: number; off: number } } {
  const seen = look.steamGame !== null || look.exclusive;
  const s = seen ? { on: streak.on + 1, off: 0 } : { on: 0, off: streak.off + 1 };
  if (!prev) {
    if (look.steamGame !== null) return { game: { name: look.steamGame, since: now }, streak: s };
    if (look.exclusive && s.on >= 2) return { game: { name: "a full-screen game", since: now }, streak: s };
    return { game: null, streak: s };
  }
  if (!seen && s.off >= 2) return { game: null, streak: s };
  // A Steam name is better than the generic one.
  if (look.steamGame && prev.name !== look.steamGame) return { game: { ...prev, name: look.steamGame }, streak: s };
  return { game: prev, streak: s };
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startGamingWatch() {
  if (timer) return;
  let streak = { on: 0, off: 0 };
  const look = async () => {
    const [g, fs] = await Promise.all([gpuApi.runningGame().catch(() => null), native.fullscreenState().catch(() => "none" as const)]);
    const r = nextGame(useGaming.getState().game, { steamGame: g ? (g.name ?? `Steam game ${g.id}`) : null, exclusive: fs === "exclusive" }, streak, Date.now());
    streak = r.streak;
    if (r.game !== useGaming.getState().game) useGaming.setState({ game: r.game });
  };
  void look();
  timer = setInterval(look, 10_000);
}

/** Pure: GPU readings as a sentence for the AI. */
export function describeGpu(g: GpuStats): string {
  if (!g.name) return "BEV couldn't find a graphics card to read.";
  const parts: string[] = [];
  if (g.usage != null) parts.push(`${Math.round(g.usage)}% busy`);
  if (g.temp_c != null) parts.push(`${Math.round(g.temp_c)}°C${g.hotspot_c != null ? ` (hotspot ${Math.round(g.hotspot_c)}°C)` : ""}`);
  if (g.mem_temp_c != null) parts.push(`memory ${Math.round(g.mem_temp_c)}°C`);
  if (g.vram_used_mb != null && g.vram_total_mb) parts.push(`${(g.vram_used_mb / 1024).toFixed(1)} of ${(g.vram_total_mb / 1024).toFixed(0)} GB video memory in use`);
  else if (g.vram_total_mb) parts.push(`${(g.vram_total_mb / 1024).toFixed(0)} GB video memory`);
  if (g.clock_mhz != null) parts.push(`core ${g.clock_mhz} MHz`);
  if (g.fan_rpm != null) parts.push(`fan ${g.fan_rpm} RPM${g.fan_percent != null ? ` (${g.fan_percent}%)` : ""}`);
  if (g.power_w != null) parts.push(`${g.power_w} W`);
  const hot = (g.hotspot_c ?? g.temp_c ?? 0) >= 95;
  return `${g.name}: ${parts.join(", ") || "no live readings available"}.${hot ? " That's running hot." : ""}${g.temp_c == null ? " (Temperatures need an AMD card with its driver installed.)" : ""}`;
}
