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

import { latestHelloOnly } from "./liveVideo";
describe("live video set-up", () => {
  it("answers only the newest hello in a batch, with its own messages", () => {
    const out = latestHelloOnly([
      { type: "hello", sid: "a" },
      { type: "answer", sid: "a" },
      { type: "hello", sid: "b" },
      { type: "ice", sid: "b" },
    ]);
    expect(out).toEqual([{ type: "hello", sid: "b" }, { type: "ice", sid: "b" }]);
  });
  it("passes messages through when there's no hello", () => {
    const sig = [{ type: "answer", sid: "a" }, { type: "ice", sid: "a" }];
    expect(latestHelloOnly(sig)).toEqual(sig);
  });
});
