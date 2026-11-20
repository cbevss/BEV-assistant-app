import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn() }));
vi.mock("@/voice/sounds", () => ({ playChime: vi.fn() }));
import { step, holds, needs, describeWatch, happened, type Watch, type Sample } from "./watches";

const w = (kind: Watch["kind"], extra: Partial<Watch> = {}): Watch => ({ id: kind, kind, created: 0, expires: 1e15, ...extra });
const run = (watch: Watch, samples: Sample[]) => {
  const bases = new Map<string, Sample>();
  const streaks = new Map<string, number>();
  return samples.map((s) => step([watch], s, bases, streaks).length > 0);
};

describe("watches", () => {
  it("an app closing", () => {
    expect(run(w("app_closes", { app: "Blender" }), [{ apps: ["blender.exe", "steam.exe"] }, { apps: ["blender.exe"] }, { apps: ["steam.exe"] }])).toEqual([false, false, true]);
    // Already closed when set: waits for it to open, then close.
    expect(run(w("app_closes", { app: "steam" }), [{ apps: [] }, { apps: [] }, { apps: ["Steam.exe"] }, { apps: [] }])).toEqual([false, false, false, true]);
  });

  it("downloads finishing, including ones that start after asking", () => {
    expect(run(w("download_done"), [{ downloadsInProgress: 2 }, { downloadsInProgress: 1 }, { downloadsInProgress: 0 }])).toEqual([false, false, true]);
    expect(run(w("download_done"), [{ downloadsInProgress: 0 }, { downloadsInProgress: 0 }, { downloadsInProgress: 1 }, { downloadsInProgress: 0 }])).toEqual([false, false, false, true]);
  });

  it("thresholds must hold, so blips don't count", () => {
    const cpu = w("cpu_below", { value: 20 });
    expect(run(cpu, [{ cpu: 95 }, { cpu: 10 }, { cpu: 80 }, { cpu: 10 }, { cpu: 9 }, { cpu: 8 }, { cpu: 7 }])).toEqual([false, false, false, false, false, false, true]);
    expect(run(w("gpu_temp_above", { value: 90 }), [{ gpuTemp: 91 }, { gpuTemp: 92 }])).toEqual([false, true]);
    expect(holds(w("gpu_temp_above"), { gpuTemp: null }, undefined)).toBeUndefined();
  });

  it("games ending only after one was running", () => {
    expect(run(w("game_ends"), [{ game: null }, { game: "Halo" }, { game: null }])).toEqual([false, false, true]);
    expect(run(w("game_starts"), [{ game: null }, { game: "Halo" }])).toEqual([false, true]);
  });

  it("only fetches what's needed, and reads naturally", () => {
    expect(needs([w("app_opens", { app: "x" }), w("gpu_temp_above")])).toMatchObject({ apps: true, gpu: true, stats: false, net: false, downloads: false });
    expect(describeWatch(w("gpu_temp_above", { value: 88 }))).toBe("when the GPU goes over 88°C");
    expect(happened(w("disk_free_below"), { minDiskFreeGb: { mount: "C:\\", free: 4.25 } })).toBe("C:\\ has 4.3 GB free.");
  });
});
