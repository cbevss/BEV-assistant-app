/**
 * Downloading games the user owns, from whichever launcher has them: Steam,
 * Epic Games or GOG Galaxy. BEV reads each launcher's library on this PC,
 * finds where the game is, and asks the user which launcher when it's in more
 * than one (unless they said). The download itself starts in the launcher.
 */
import type { GameLibraries } from "./native";
import { matchGame } from "./games";

export type Launcher = "steam" | "epic" | "gog";
export const LAUNCHER_NAME: Record<Launcher, string> = { steam: "Steam", epic: "Epic Games", gog: "GOG Galaxy" };

export interface Source {
  launcher: Launcher;
  id: string;
  name: string;
  installed: boolean;
  /** Steam only: true when BEV saw it in the library; false = found in the Steam store, may not be owned. */
  owned: boolean;
}

/** Which launcher the user named ("on steam", "epic", "gog galaxy"), if any. Pure; tested. */
export function launcherNamed(text: string | undefined): Launcher | null {
  const t = (text ?? "").toLowerCase();
  if (/\bsteam\b/.test(t)) return "steam";
  if (/\bepic\b/.test(t)) return "epic";
  if (/\bgog\b|galaxy/.test(t)) return "gog";
  return null;
}

/**
 * Where a game can be downloaded from. `steamStore` is the Steam store's search results for the name
 * (owned ones are known from the local library). Pure; tested.
 */
export function findSources(name: string, libs: GameLibraries, steamStore: Array<{ id: string; name: string }>): Source[] {
  const out: Source[] = [];
  if (libs.steam) {
    const inst = matchGame(name, libs.steam_installed.map((g) => ({ ...g, source: "steam" }))).game;
    if (inst) out.push({ launcher: "steam", id: inst.id, name: inst.name, installed: true, owned: true });
    else {
      const owned = new Set(libs.steam_owned);
      const mine = steamStore.filter((g) => owned.has(g.id));
      const hit = matchGame(name, mine.map((g) => ({ ...g, source: "steam" }))).game ?? null;
      if (hit) out.push({ launcher: "steam", id: hit.id, name: hit.name, installed: false, owned: true });
    }
  }
  for (const [launcher, list] of [
    ["epic", libs.epic_games],
    ["gog", libs.gog_games],
  ] as const) {
    if (!list.length) continue;
    const hit = matchGame(name, list.map((g) => ({ id: g.id, name: g.name, source: launcher }))).game;
    if (hit) {
      const g = list.find((x) => x.id === hit.id)!;
      out.push({ launcher, id: g.id, name: g.name, installed: g.installed, owned: true });
    }
  }
  return out;
}
