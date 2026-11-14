import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ show: async () => {}, setFocus: async () => {} }),
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: async () => {}, listen: async () => () => {} }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => false,
  requestPermission: async () => "denied",
  sendNotification: () => {},
}));
vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => { throw new Error("no store"); } }));
vi.mock("@/lib/native", () => ({
  native: {
    showOverlay: async () => {},
    hideOverlay: async () => {},
    logAction: async () => {},
    listProcesses: async () => [],
  },
}));

const runs: string[] = [];
vi.mock("./engine", () => ({
  isRoutineRunning: () => false,
  runRoutine: async (r: { id: string; name: string }) => {
    runs.push(r.name);
    return { routineId: r.id, name: r.name, ok: true, cancelled: false, results: [] };
  },
  summariseRun: () => "done",
}));

import { useRoutines } from "./store";
import { startScheduler, stopScheduler, tick } from "./scheduler";

describe("scheduler", () => {
  beforeEach(() => {
    runs.length = 0;
    vi.useFakeTimers();
    useRoutines.setState({
      loaded: true,
      routines: [
        {
          id: "r1",
          name: "morning",
          triggers: [],
          steps: [],
          enabled: true,
          schedule: { time: "08:00", days: [] },
        },
      ],
    });
  });
  afterEach(() => {
    stopScheduler();
    vi.useRealTimers();
  });

  it("still fires when the timer skips over the scheduled minute", async () => {
    vi.setSystemTime(new Date(2026, 10, 14, 7, 59, 50));
    await startScheduler();
    // Simulate a throttled hidden window: no tick lands inside 08:00 at all.
    vi.setSystemTime(new Date(2026, 10, 14, 8, 1, 20));
    await tick();
    expect(runs).toEqual(["morning"]);
  });

  it("fires once per scheduled minute, however often it ticks", async () => {
    vi.setSystemTime(new Date(2026, 10, 15, 7, 59, 30));
    await startScheduler();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(runs).toEqual(["morning"]);
  });
});
