import { describe, it, expect, vi } from "vitest";

// Mock the native bridge so tool executors don't touch the OS during tests.
vi.mock("@/lib/native", () => ({
  native: {
    setVolume: vi.fn().mockResolvedValue(undefined),
    launchApp: vi.fn().mockResolvedValue("launched"),
    memoryUpsert: vi.fn().mockResolvedValue(undefined),
  },
}));

import { tools, isSensitive, toolSpecs } from "./tools";

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

  it("flags close_app as sensitive and get_system_stats as not", () => {
    expect(isSensitive("close_app")).toBe(true);
    expect(isSensitive("get_system_stats")).toBe(false);
  });

  it("coerces numeric strings for volume", async () => {
    const out = await tools.set_volume.run({ percent: "45" });
    expect(out).toMatch(/45%/);
  });
});
