import { describe, it, expect, vi } from "vitest";
import { toLayer, bubbleSpot } from "./types";
import { digestDropped } from "@/ai/orchestrator";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (cmd: string, args: { points?: Array<[number, number]> }) => (cmd === "shot_points_to_screen" ? args.points!.map(([x, y]) => [x * 2 + 100, y * 2]) : null)) }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: vi.fn(async () => {}) }));

describe("teaching layer", () => {
  it("maps desktop pixels onto the layer, across monitors and scaling", () => {
    expect(toLayer({ x: 300, y: 200 }, { x: -1920, y: 0 }, 1)).toEqual({ x: 2220, y: 200 });
    expect(toLayer({ x: 300, y: 200 }, { x: 0, y: 0 }, 1.5)).toEqual({ x: 200, y: 200 / 1.5 });
  });
  it("keeps the speech bubble on screen", () => {
    const view = { w: 1000, h: 800 };
    expect(bubbleSpot({ x: 100, y: 100 }, { w: 200, h: 50 }, view)).toEqual({ x: 128, y: 150 });
    const corner = bubbleSpot({ x: 980, y: 790 }, { w: 200, h: 50 }, view);
    expect(corner.x + 200).toBeLessThanOrEqual(1000);
    expect(corner.y + 50).toBeLessThanOrEqual(800);
  });
  it("builds boxes from screenshot points, and arrows that point at the target", async () => {
    const { buildMark } = await import("./teach");
    const box = await buildMark({ kind: "box", x: 10, y: 20, w: 30, h: 40, label: "Here", step: 1 });
    expect(box).toMatchObject({ kind: "box", rect: { x: 120, y: 40, w: 60, h: 80 }, label: "Here", step: 1 });
    const arrow = await buildMark({ kind: "arrow", x: 50, y: 50 });
    expect(arrow.kind).toBe("arrow");
    if (arrow.kind === "arrow") expect(arrow.to).toEqual({ x: 200, y: 100 });
    await expect(buildMark({ kind: "box" })).rejects.toThrow(/say where/);
  });
});

describe("long conversations", () => {
  it("keeps a digest of dropped turns, newest kept when it gets long", () => {
    const d = digestDropped("", [
      { role: "user", content: "teach me photoshop layers" },
      { role: "tool", content: "screenshot" },
      { role: "assistant", content: "Sure, first open Layers." },
    ]);
    expect(d).toBe("User: teach me photoshop layers\nBEV: Sure, first open Layers.");
    let long = d;
    for (let i = 0; i < 100; i++) long = digestDropped(long, [{ role: "user", content: `step ${i} ` + "x".repeat(100) }]);
    expect(long.length).toBeLessThanOrEqual(3501);
    expect(long).toContain("step 99");
    expect(long.startsWith("…")).toBe(true);
  });
});
