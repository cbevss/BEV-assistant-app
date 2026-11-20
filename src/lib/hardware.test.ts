import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { matchDevice } from "./hardware";

const outs = [{ name: "Speakers (Realtek(R) Audio)" }, { name: "Headphones (Arctis Nova 7)" }, { name: "LG ULTRAGEAR (NVIDIA High Definition Audio)" }];

describe("matchDevice", () => {
  it("matches names and kinds of device", () => {
    expect(matchDevice(outs, "arctis")?.name).toMatch(/Arctis/);
    expect(matchDevice(outs, "my headset")?.name).toMatch(/Arctis/);
    expect(matchDevice(outs, "speakers")?.name).toMatch(/Realtek/);
    expect(matchDevice(outs, "the monitor")?.name).toMatch(/ULTRAGEAR/);
    expect(matchDevice(outs, "Speakers (Realtek(R) Audio)")?.name).toMatch(/Realtek/);
  });
  it("won't guess when it's unclear", () => {
    expect(matchDevice(outs, "bluetooth")).toBeNull();
    expect(matchDevice(outs, "")).toBeNull();
    expect(matchDevice([{ name: "Headphones A" }, { name: "Headphones B" }], "headphones")).toBeNull();
  });
});

import { shortcutClash } from "@/routines/hotkeys";
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({ register: vi.fn(), unregister: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));

describe("routine shortcuts", () => {
  const rs = [{ id: "a", name: "Gaming Mode", triggers: [], steps: [], enabled: true, hotkey: "CommandOrControl+Alt+G" }];
  it("won't reuse BEV's shortcuts or another routine's", () => {
    expect(shortcutClash("CommandOrControl+Alt+B", "x", rs, ["CommandOrControl+Alt+B"])).toMatch(/BEV's own/);
    expect(shortcutClash("commandorcontrol+alt+g", "x", rs, [])).toMatch(/Gaming Mode/);
    expect(shortcutClash("CommandOrControl+Alt+G", "a", rs, [])).toBeNull();
    expect(shortcutClash("", "x", rs, [])).toBeNull();
  });
});
