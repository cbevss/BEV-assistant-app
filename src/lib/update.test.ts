import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
import { check } from "@tauri-apps/plugin-updater";
import { checkForUpdate, isNewer, useUpdate } from "./update";

describe("updates", () => {
  it("compares versions", () => {
    expect(isNewer("1.40.0", "1.39.0")).toBe(true);
    expect(isNewer("1.39.10", "1.39.9")).toBe(true);
    expect(isNewer("1.39.0", "1.39.0")).toBe(false);
    expect(isNewer("1.38.0", "1.39.0")).toBe(false);
    expect(isNewer("v2.0.0", "1.99.99")).toBe(true);
  });
  it("hides the button once nothing newer is available", async () => {
    vi.mocked(check).mockResolvedValueOnce({ version: "1.41.0", currentVersion: "1.40.0" } as never);
    await checkForUpdate();
    expect(useUpdate.getState().phase).toBe("available");
    vi.mocked(check).mockResolvedValueOnce(null);
    await checkForUpdate();
    expect(useUpdate.getState().phase).toBe("none");
  });
  it("ignores a 'newer' release that's the version already running", async () => {
    vi.mocked(check).mockResolvedValueOnce({ version: "1.40.0", currentVersion: "1.40.0" } as never);
    await checkForUpdate();
    expect(useUpdate.getState().phase).toBe("none");
  });
});
