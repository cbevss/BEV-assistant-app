import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { keepLatestImage, foregroundLabel } from "./orchestrator";
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
