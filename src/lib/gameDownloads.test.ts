import { describe, it, expect } from "vitest";
import { findSources, launcherNamed } from "./gameDownloads";
import type { GameLibraries } from "./native";

const libs: GameLibraries = {
  steam: true,
  epic: true,
  gog: true,
  steam_owned: ["252950", "1091500"],
  steam_installed: [{ id: "730", name: "Counter-Strike 2", installed: true }],
  epic_games: [
    { id: "rl:9773aa1a:Sugar", name: "Rocket League", installed: false },
    { id: "cp:abc:Ginger", name: "Cyberpunk 2077", installed: false },
  ],
  gog_games: [{ id: "gog_1423049311", name: "Cyberpunk 2077", installed: true }],
  others: [],
};
const store = [
  { id: "252950", name: "Rocket League" },
  { id: "1091500", name: "Cyberpunk 2077" },
  { id: "999", name: "Cyberpunk 2077: Phantom Liberty" },
];

describe("downloading games", () => {
  it("finds every launcher that has the game", () => {
    const s = findSources("rocket league", libs, store);
    expect(s.map((x) => x.launcher)).toEqual(["steam", "epic"]);
    expect(s[0]).toMatchObject({ id: "252950", owned: true, installed: false });
  });
  it("knows where it's already installed", () => {
    expect(findSources("cs2", libs, [])[0]).toMatchObject({ launcher: "steam", installed: true });
    const cp = findSources("cyberpunk", libs, store);
    expect(cp.map((x) => `${x.launcher}:${x.installed}`)).toEqual(["steam:false", "epic:false", "gog:true"]);
  });
  it("doesn't offer Steam store games the user doesn't own", () => {
    expect(findSources("phantom liberty", { ...libs, epic_games: [], gog_games: [] }, store)).toEqual([]);
  });
  it("hears which launcher the user named", () => {
    expect(launcherNamed("get it on Steam")).toBe("steam");
    expect(launcherNamed("from epic games")).toBe("epic");
    expect(launcherNamed("GOG Galaxy")).toBe("gog");
    expect(launcherNamed("download rocket league")).toBeNull();
  });
});
