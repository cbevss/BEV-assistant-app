import { describe, it, expect } from "vitest";
import { matchGame, normaliseGameName } from "./games";
import type { InstalledGame } from "./native";

const g = (id: string, name: string): InstalledGame => ({ id, name, source: "steam" });
const library = [
  g("252950", "Rocket League"),
  g("730", "Counter-Strike 2"),
  g("292030", "The Witcher 3: Wild Hunt"),
  g("1172470", "Apex Legends™"),
  g("271590", "Grand Theft Auto V"),
  g("1091500", "Cyberpunk 2077"),
  g("105600", "Terraria"),
  g("1086940", "Baldur's Gate 3"),
];
const pick = (q: string) => matchGame(q, library).game?.name ?? null;

describe("matchGame", () => {
  it.each([
    ["rocket league", "Rocket League"],
    ["Rocket League on Steam", "Rocket League"],
    ["open rocket league with steam", "Rocket League"],
    ["rocketleague", "Rocket League"],
    ["counter strike two", "Counter-Strike 2"],
    ["witcher 3", "The Witcher 3: Wild Hunt"],
    ["the witcher three", "The Witcher 3: Wild Hunt"],
    ["apex legends", "Apex Legends™"],
    ["gta five", "Grand Theft Auto V"],
    ["grand theft auto 5", "Grand Theft Auto V"],
    ["baldurs gate 3", "Baldur's Gate 3"],
    ["terraria", "Terraria"],
    ["cs2", "Counter-Strike 2"],
    ["bg3", "Baldur's Gate 3"],
    ["cyberpunk", "Cyberpunk 2077"],
  ])("%s → %s", (q, expected) => {
    expect(pick(q)).toBe(expected);
  });

  it("returns no game, but suggestions, for something not installed", () => {
    const m = matchGame("minecraft", library);
    expect(m.game).toBeNull();
  });

  it("doesn't grab a game on a single loose word", () => {
    expect(pick("league of legends")).toBeNull();
  });

  it("normalises symbols, numbers and roman numerals", () => {
    expect(normaliseGameName("Grand Theft Auto V")).toBe("grand theft auto 5");
    expect(normaliseGameName("Apex Legends™")).toBe("apex legends");
  });
});
