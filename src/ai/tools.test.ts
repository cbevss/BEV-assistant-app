import { describe, it, expect, vi } from "vitest";

// Mock the native bridge so tool executors don't touch the OS during tests.
vi.mock("@/lib/native", () => ({
  native: {
    setVolume: vi.fn().mockResolvedValue(undefined),
    launchApp: vi.fn().mockResolvedValue("launched"),
    openPath: vi.fn().mockImplementation(async (p: string) => `opened ${p}`),
    listGames: vi.fn().mockResolvedValue([
      { id: "252950", name: "Rocket League", source: "steam" },
      { id: "730", name: "Counter-Strike 2", source: "steam" },
    ]),
    launchGame: vi.fn().mockImplementation(async (id: string, mode: string) => `launched app ${id} ${mode}`),
    memoryUpsert: vi.fn().mockResolvedValue(undefined),
  },
}));

import { tools, isSensitive, toolSpecs, opensProgram } from "./tools";

describe("tool registry", () => {
  it("exposes specs for every tool", () => {
    const specs = toolSpecs();
    expect(specs.length).toBeGreaterThan(5);
    specs.forEach((s) => expect(s.name).toBeTruthy());
  });

  it("rejects out-of-range volume", async () => {
    await expect(tools.set_volume.run({ percent: 500 })).rejects.toThrow(/0\.\.100/);
    await expect(tools.set_volume.run({ percent: -1 })).rejects.toThrow(/0\.\.100/);
  });

  it("accepts a valid volume and reports it", async () => {
    const out = await tools.set_volume.run({ percent: 30 });
    expect(out).toMatch(/30%/);
  });

  it("rejects empty app name", async () => {
    await expect(tools.launch_app.run({ name: "   " })).rejects.toThrow(/non-empty/);
  });

  it("launches a Steam game from a loose spoken name, in the mode asked for", async () => {
    expect(await tools.launch_game.run({ name: "rocket league with steam", mode: "online" })).toBe("launched app 252950 online");
    expect(await tools.launch_game.run({ name: "cs2", mode: "offline" })).toBe("launched app 730 offline");
  });

  it("asks online or offline before launching when the user didn't say", async () => {
    const { native } = await import("@/lib/native");
    (native.launchGame as ReturnType<typeof vi.fn>).mockClear();
    const out = await tools.launch_game.run({ name: "rocket league" });
    expect(out).toMatch(/did NOT launch.*online mode.*offline mode/s);
    expect(out).toContain('name "Rocket League"');
    expect(native.launchGame).not.toHaveBeenCalled();
  });

  it("says which games are installed when the name doesn't match", async () => {
    await expect(tools.launch_game.run({ name: "minecraft" })).rejects.toThrow(/No installed Steam game matches "minecraft"/);
  });

  it("opens folders and documents without approval, but asks before programs and scripts", () => {
    expect(isSensitive("open_path", { path: "C:\\Users\\me\\Downloads" })).toBe(false);
    expect(isSensitive("open_path", { path: "C:\\Users\\me\\notes.txt" })).toBe(false);
    for (const p of ["C:\\Games\\game.exe", "D:\\run.BAT", "C:\\x\\Shortcut.lnk", "\"C:\\a b\\setup.msi\"", "C:\\s.ps1"]) {
      expect(isSensitive("open_path", { path: p })).toBe(true);
    }
    expect(opensProgram("C:\\photos\\holiday.jpg")).toBe(false);
  });

  it("passes the path to the native opener", async () => {
    expect(await tools.open_path.run({ path: "C:\\Users\\me\\Downloads" })).toBe("opened C:\\Users\\me\\Downloads");
    await expect(tools.open_path.run({ path: "  " })).rejects.toThrow(/non-empty/);
  });

  it("flags close_app as sensitive and get_system_stats as not", () => {
    expect(isSensitive("close_app")).toBe(true);
    expect(isSensitive("get_system_stats")).toBe(false);
  });

  it("coerces numeric strings for volume", async () => {
    const out = await tools.set_volume.run({ percent: "45" });
    expect(out).toMatch(/45%/);
  });
});
