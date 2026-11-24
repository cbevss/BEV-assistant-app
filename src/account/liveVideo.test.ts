import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { sourceFor, LIVE_FPS } from "./liveVideo";

describe("live video", () => {
  it("streams one screen with the fast capture, every screen with BEV's own frames", () => {
    expect(sourceFor("current")).toBe("screen");
    expect(sourceFor("primary")).toBe("screen");
    expect(sourceFor("all")).toBe("frames");
    expect(LIVE_FPS).toBe(60);
  });
});
