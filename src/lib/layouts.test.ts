import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
import { orderMonitors, monitorOf, snapRect, moveToMonitor, findWindows, planRestore, type WorkArea, type Placement } from "./layouts";

const main: WorkArea = { x: 0, y: 0, w: 2560, h: 1400, primary: true };
const left: WorkArea = { x: -1920, y: 0, w: 1920, h: 1040, primary: false };
const right: WorkArea = { x: 2560, y: 200, w: 1920, h: 1040, primary: false };
const p = (hwnd: number, process: string, title: string, x = 10, y = 10, w = 800, h = 600, state: Placement["state"] = "normal"): Placement => ({ hwnd, process, title, x, y, w, h, state });

describe("window layouts", () => {
  it("numbers monitors main first, then left to right", () => {
    expect(orderMonitors([right, left, main])).toEqual([main, left, right]);
    expect(monitorOf({ x: -1500, y: 100, w: 800, h: 600 }, [main, left, right])).toBe(1);
    expect(monitorOf({ x: 3000, y: 300, w: 800, h: 600 }, [main, left, right])).toBe(2);
  });
  it("snaps within a monitor's usable area", () => {
    expect(snapRect(main, "left")).toEqual({ x: 0, y: 0, w: 1280, h: 1400 });
    expect(snapRect(right, "bottom_right")).toEqual({ x: 3520, y: 720, w: 960, h: 520 });
    expect(snapRect(main, "centre")).toEqual({ x: 512, y: 210, w: 1536, h: 980 });
  });
  it("moves to another monitor keeping the spot, shrinking to fit", () => {
    expect(moveToMonitor({ x: 0, y: 0, w: 800, h: 600 }, main, right)).toEqual({ x: 2560, y: 200, w: 800, h: 600 });
    expect(moveToMonitor({ x: 0, y: 0, w: 2560, h: 1400 }, main, left)).toEqual({ x: -1920, y: 0, w: 1920, h: 1040 });
  });
  it("finds windows by app or title", () => {
    const ps = [p(1, "chrome.exe", "YouTube - Google Chrome"), p(2, "Discord.exe", "#general - Discord")];
    expect(findWindows(ps, "Chrome").map((x) => x.hwnd)).toEqual([1]);
    expect(findWindows(ps, "discord.exe").map((x) => x.hwnd)).toEqual([2]);
    expect(findWindows(ps, "youtube").map((x) => x.hwnd)).toEqual([1]);
    expect(findWindows(ps, "spotify")).toEqual([]);
  });
  it("restores each app to its spot, telling two windows of one app apart", () => {
    const layout = {
      name: "streaming",
      savedAt: 0,
      windows: [
        { process: "chrome.exe", title: "OBS Guide - Chrome", x: 0, y: 0, w: 1280, h: 1400, state: "normal" as const },
        { process: "chrome.exe", title: "YouTube Studio - Chrome", x: 1280, y: 0, w: 1280, h: 1400, state: "normal" as const },
        { process: "obs64.exe", title: "OBS", x: -1920, y: 0, w: 1920, h: 1040, state: "maximized" as const },
      ],
    };
    const r = planRestore(layout, [p(10, "chrome.exe", "YouTube Studio - Chrome"), p(11, "chrome.exe", "OBS Guide - Chrome"), p(12, "Discord.exe", "Discord")]);
    expect(r.moves.map((m) => [m.hwnd, m.to.x])).toEqual([[11, 0], [10, 1280]]);
    expect(r.missing).toEqual(["obs64"]);
  });
});
