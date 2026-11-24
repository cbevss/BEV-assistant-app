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

import { percentRect, rectToSpot, spotToRect, findSpot, type AppSpot } from "./layouts";
describe("exact spots and apps' usual spots", () => {
  const main = { x: 0, y: 0, w: 1920, h: 1040, primary: true };
  const side = { x: 1920, y: 0, w: 2560, h: 1400, primary: false };
  it("puts a window anywhere by percent, kept on the monitor", () => {
    expect(percentRect(side, { x: 66.7, y: 0, width: 33.3, height: 100 })).toEqual({ x: 1920 + 1708, y: 0, w: 852, h: 1400 });
    const r = percentRect(main, { x: 90, y: 90, width: 50, height: 50 });
    expect(r.x + r.w).toBeLessThanOrEqual(1920);
    expect(r.y + r.h).toBeLessThanOrEqual(1040);
  });
  it("remembers a spot relative to its monitor and puts it back there", () => {
    const s = rectToSpot({ x: 1920 + 640, y: 350, w: 1280, h: 700 }, "normal", [main, side]);
    expect(s).toMatchObject({ monitor: 2, rx: 0.25, ry: 0.25, rw: 0.5, rh: 0.5 });
    expect(spotToRect(s, [main, side])).toEqual({ x: 2560, y: 350, w: 1280, h: 700 });
    // Second monitor unplugged: falls back to the main one, same proportions.
    expect(spotToRect(s, [main])).toEqual({ x: 480, y: 260, w: 960, h: 520 });
  });
  it("finds the spot for whatever the app is called", () => {
    const spots = [{ app: "discord", label: "Discord", monitor: 2, rx: 0, ry: 0, rw: 1, rh: 1, state: "normal", savedAt: 0 }] as AppSpot[];
    expect(findSpot(spots, "Discord.exe")?.app).toBe("discord");
    expect(findSpot(spots, "discord")?.label).toBe("Discord");
    expect(findSpot(spots, "spotify")).toBeUndefined();
  });
});
