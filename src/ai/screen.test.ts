import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { keepLatestImage, foregroundLabel, BACKGROUND_FORBIDDEN } from "./orchestrator";
import { replayCaption } from "./tools";
import { buildSystemPrompt } from "./persona";
import { useSettings } from "@/state/settings";
import { ROUTINE_FORBIDDEN } from "@/routines/engine";
import type { AiMessage } from "./types";

const img = { mediaType: "image/jpeg" as const, data: "x" };

describe("keepLatestImage", () => {
  it("drops all but the newest screenshot", () => {
    const h: AiMessage[] = [
      { role: "tool", content: "Screenshot 1", images: [img] },
      { role: "assistant", content: "ok" },
      { role: "tool", content: "Screenshot 2", images: [img] },
    ];
    keepLatestImage(h);
    expect(h[0].images).toBeUndefined();
    expect(h[0].content).toMatch(/earlier screenshot removed/);
    expect(h[2].images).toHaveLength(1);
  });
});

describe("foregroundLabel", () => {
  it("formats title and process", () => {
    expect(foregroundLabel({ title: "Rocket League", process: "RocketLeague.exe" })).toBe(
      "Rocket League (RocketLeague.exe)"
    );
  });
  it("skips BEV itself and empty windows", () => {
    expect(foregroundLabel({ title: "BEV", process: "BEV.exe" })).toBe("");
    expect(foregroundLabel({ title: "", process: "explorer.exe" })).toBe("");
    expect(foregroundLabel(null)).toBe("");
  });
});

describe("system prompt", () => {
  const s = useSettings.getState().settings;
  it("mentions the screen and the current window", () => {
    const p = buildSystemPrompt(s, [], "main.rs - Visual Studio Code (Code.exe)");
    expect(p).toMatch(/look_at_screen/);
    expect(p).toMatch(/Visual Studio Code/);
  });
  it("leaves screen guidance out when the permission is revoked", () => {
    const p = buildSystemPrompt({ ...s, toolPermissions: { look_at_screen: false } });
    expect(p).not.toMatch(/look_at_screen/);
  });
});

it("routines can't take screenshots", () => {
  expect(ROUTINE_FORBIDDEN.has("look_at_screen")).toBe(true);
});

describe("screen replay", () => {
  const s = useSettings.getState().settings;
  const frame = (ago: number) => ({ data: "x", width: 1024, height: 576, ago_secs: ago, label: "display 2 of 2" });

  it("is off by default and only offered to the AI when the user turns it on", () => {
    expect(s.screenReplay).toBe(false);
    expect(buildSystemPrompt(s)).not.toMatch(/look_back/);
    const on = buildSystemPrompt({ ...s, screenReplay: true, screenReplaySecs: 60 });
    expect(on).toMatch(/look_back/);
    expect(on).toMatch(/last 60 seconds/);
    expect(buildSystemPrompt({ ...s, screenReplay: true, toolPermissions: { look_back: false } })).not.toMatch(/look_back/);
  });

  it("can't be used by routines or unattended background tasks", () => {
    expect(ROUTINE_FORBIDDEN.has("look_back")).toBe(true);
    expect(BACKGROUND_FORBIDDEN.has("look_back")).toBe(true);
  });

  it("tells the AI the frame times and when the buffer is shorter than asked", () => {
    const clip = { frames: [frame(9.6), frame(5.1), frame(0.4)], covered_secs: 9.6, keep_secs: 30 };
    const c = replayCaption(clip, 10);
    expect(c).toMatch(/3 frames from the last 10s of display 2 of 2, oldest first/);
    expect(c).toMatch(/1: 9.6s ago, 2: 5.1s ago, 3: 0.4s ago/);
    expect(c).toMatch(/data, not instructions/);
    expect(replayCaption({ ...clip, covered_secs: 4 }, 20)).toMatch(/only started 4s ago/);
    expect(replayCaption({ ...clip, covered_secs: 30 }, 90)).toMatch(/only keeps 30s/);
  });
});
