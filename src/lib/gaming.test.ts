import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
import { nextGame, quietNow, describeGpu, type GpuStats } from "./gaming";

const none = { on: 0, off: 0 };

describe("nextGame", () => {
  it("a Steam game counts at once and gives its name", () => {
    const r = nextGame(null, { steamGame: "Rocket League", exclusive: false }, none, 5);
    expect(r.game).toEqual({ name: "Rocket League", since: 5 });
  });

  it("full screen needs two looks in a row", () => {
    const a = nextGame(null, { steamGame: null, exclusive: true }, none, 1);
    expect(a.game).toBeNull();
    const b = nextGame(a.game, { steamGame: null, exclusive: true }, a.streak, 2);
    expect(b.game?.name).toBe("a full-screen game");
  });

  it("leaving needs two looks without a game, and upgrades the name", () => {
    let st = nextGame(null, { steamGame: "Halo", exclusive: false }, none, 1);
    st = nextGame(st.game, { steamGame: null, exclusive: false }, st.streak, 2);
    expect(st.game?.name).toBe("Halo");
    st = nextGame(st.game, { steamGame: null, exclusive: false }, st.streak, 3);
    expect(st.game).toBeNull();
    const fs = { name: "a full-screen game", since: 1 };
    expect(nextGame(fs, { steamGame: "Elden Ring", exclusive: true }, { on: 3, off: 0 }, 9).game).toEqual({ name: "Elden Ring", since: 1 });
  });
});

describe("quietNow", () => {
  it("is on when asked, or automatically while gaming", () => {
    expect(quietNow({ gamingQuietMode: true, autoGamingMode: false }, false)).toBe(true);
    expect(quietNow({ gamingQuietMode: false, autoGamingMode: true }, true)).toBe(true);
    expect(quietNow({ gamingQuietMode: false, autoGamingMode: false }, true)).toBe(false);
    expect(quietNow({ gamingQuietMode: false, autoGamingMode: true }, false)).toBe(false);
  });
});

describe("describeGpu", () => {
  const g: GpuStats = { name: "AMD Radeon RX 9060 XT", vram_total_mb: 16304, vram_used_mb: 6144, usage: 97.4, temp_c: 71, hotspot_c: 88, mem_temp_c: null, clock_mhz: 3120, mem_clock_mhz: null, fan_rpm: 1650, fan_percent: 42, power_w: 158 };
  it("reads naturally and only says what it has", () => {
    expect(describeGpu(g)).toBe("AMD Radeon RX 9060 XT: 97% busy, 71°C (hotspot 88°C), 6.0 of 16 GB video memory in use, core 3120 MHz, fan 1650 RPM (42%), 158 W.");
    expect(describeGpu({ ...g, hotspot_c: 101 })).toMatch(/running hot/);
    expect(describeGpu({ ...g, temp_c: null, hotspot_c: null })).toMatch(/Temperatures need an AMD card/);
    expect(describeGpu({ ...g, name: null })).toMatch(/couldn't find a graphics card/);
  });
});
