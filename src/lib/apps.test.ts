import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { describeOpen, describeClose, AppActionError } from "./apps";

describe("describeOpen", () => {
  it("only claims success with evidence", () => {
    expect(describeOpen({ status: "opened", app: "Antimicro", window: "Antimicro" })).toMatch(/^Opened Antimicro/);
    expect(describeOpen({ status: "starting", app: "Steam", detail: "no window yet" })).toMatch(/Don't say it's open/);
    expect(describeOpen({ status: "unverified", app: "X", detail: "no window" })).toMatch(/couldn't confirm/);
    expect(() => describeOpen({ status: "failed", app: "Spotify", error: "activation failed" })).toThrow(AppActionError);
  });
  it("asks on ambiguity and offers the Store when not installed", () => {
    expect(describeOpen({ status: "ambiguous", options: ["Microsoft Teams", "Teams Machine-Wide Installer"] })).toMatch(/Ask the user which/);
    const ni = describeOpen({ status: "not_installed", query: "antimicro", suggestions: [], store_url: "https://apps.microsoft.com/detail/9N1FCFQ6P5LW" });
    expect(ni).toMatch(/Microsoft Store: https:\/\/apps\.microsoft\.com\/detail\/9N1FCFQ6P5LW/);
    expect(ni).toMatch(/don't install anything without asking/);
  });
  it("is honest when it couldn't focus", () => {
    expect(describeOpen({ status: "already_running", app: "Discord", window: "Discord", focused: false })).toMatch(/flashing in the taskbar/);
  });
});

describe("describeClose", () => {
  it("warns before data loss", () => {
    expect(describeClose({ status: "still_open", app: "Notepad", window: "Save changes?" })).toMatch(/unsaved work would be lost/);
    expect(describeClose({ status: "closed", app: "Spotify" })).toBe("Closed Spotify.");
  });
});
