import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn() }));
vi.mock("@/voice/sounds", () => ({ playChime: vi.fn() }));
import { weights, weightedPick } from "./suggestGame";

describe("suggest a game", () => {
  it("favours games not played lately", () => {
    const now = 100 * 86_400_000;
    const last = new Map([["halo", now - 3600_000], ["elden ring", now - 10 * 86_400_000]]);
    expect(weights(["Halo", "Elden Ring", "Celeste"], last, now)).toEqual([1, 4, 6]);
  });
  it("picks by weight", () => {
    const items = ["a", "b", "c"];
    expect(weightedPick(items, [1, 4, 6], () => 0)).toBe("a");
    expect(weightedPick(items, [1, 4, 6], () => 4)).toBe("b");
    expect(weightedPick(items, [1, 4, 6], () => 10)).toBe("c");
  });
});
