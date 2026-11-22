import { describe, expect, it, vi } from "vitest";
vi.mock("./apps", () => ({ appsApi: { refresh: vi.fn() } }));
vi.mock("./files", () => ({ filesApi: { list: vi.fn() } }));
vi.mock("@/state/settings", () => ({ useSettings: { getState: () => ({ settings: {} }) } }));
import { newDownloads } from "./appScan";

describe("download detection", () => {
  it("spots finished new files and ignores partial ones", () => {
    const before = new Set(["old.zip"]);
    expect(newDownloads(before, ["old.zip", "SteamSetup.exe", "game.crdownload", "x.part"])).toEqual(["SteamSetup.exe"]);
  });
  it("is case-insensitive about what it's seen", () => {
    expect(newDownloads(new Set(["setup.exe"]), ["Setup.EXE"])).toEqual([]);
  });
});
