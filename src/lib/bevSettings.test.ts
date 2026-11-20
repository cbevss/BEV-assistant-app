import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
import { nextRate, nextVolume, BEV_SETTINGS } from "./bevSettings";
import type { Settings } from "@/state/settings";

describe("BEV settings by voice", () => {
  it("adjusts speed and volume within limits", () => {
    expect(nextRate(1.02, "slower")).toBe(0.87);
    expect(nextRate(1.75, "faster")).toBe(1.8);
    expect(nextRate(1.3, "normal")).toBe(1.02);
    expect(nextRate(1, "1.25x")).toBe(1.25);
    expect(() => nextRate(1, "zippy")).toThrow();
    expect(nextVolume(1, "quieter")).toBe(0.85);
    expect(nextVolume(0.5, "60%")).toBe(0.6);
    expect(nextVolume(0.2, "quieter")).toBe(0.1);
  });
  it("applies names and switches, and keeps security settings out", () => {
    const s = { addressAs: "sir", screenTime: true } as Settings;
    expect(BEV_SETTINGS.call_me.apply(s, "Charlie")).toEqual({ addressAs: "Charlie" });
    expect(BEV_SETTINGS.call_me.apply(s, "nothing")).toEqual({ addressAs: "" });
    expect(BEV_SETTINGS.screen_time.apply(s, "off")).toEqual({ screenTime: false });
    expect(() => BEV_SETTINGS.screen_time.apply(s, "maybe")).toThrow();
    expect(Object.keys(BEV_SETTINGS).some((k) => /phone|account|approve|secret|key/.test(k))).toBe(false);
  });
});
