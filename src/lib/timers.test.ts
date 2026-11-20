import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn() }));
vi.mock("@/voice/sounds", () => ({ playChime: vi.fn() }));
import { nextClock, dueFrom, nextRepeat, formatDuration, clockDown, matchTimers, dueNow, salute, type Timer } from "./timers";

const at = (d: string) => new Date(d).getTime();
const NOW = at("2026-11-20T14:00:00");

describe("times", () => {
  it("reads clock times as the next time they come round", () => {
    expect(nextClock("15:30", NOW)).toBe(at("2026-11-20T15:30:00"));
    expect(nextClock("9:05", NOW)).toBe(at("2026-11-21T09:05:00"));
    expect(nextClock("6pm", NOW)).toBe(at("2026-11-20T18:00:00"));
    expect(nextClock("12am", NOW)).toBe(at("2026-11-21T00:00:00"));
    expect(nextClock("25:00", NOW)).toBeNull();
    expect(nextClock("soon", NOW)).toBeNull();
  });
  it("takes a date and time, or a delay within limits", () => {
    expect(dueFrom({ at: "2026-11-22T08:15" }, NOW)).toBe(at("2026-11-22T08:15:00"));
    expect(dueFrom({ at: "2026-11-19T08:15" }, NOW)).toBeNull();
    expect(dueFrom({ minutes: 10 }, NOW)).toBe(NOW + 600_000);
    expect(dueFrom({ hours: 1, minutes: 30, seconds: 5 }, NOW)).toBe(NOW + 5_405_000);
    expect(dueFrom({ minutes: -5 }, NOW)).toBeNull();
    expect(dueFrom({ hours: 24 * 8 }, NOW)).toBeNull();
    expect(dueFrom({}, NOW)).toBeNull();
  });
  it("repeats on the right days", () => {
    const fri = at("2026-11-20T07:30:00"); // a Friday
    expect(new Date(nextRepeat(fri, "weekdays")).getDay()).toBe(1);
    expect(new Date(nextRepeat(fri, "weekends")).getDay()).toBe(6);
    expect(nextRepeat(fri, "daily")).toBe(at("2026-11-21T07:30:00"));
  });
  it("formats durations and countdowns", () => {
    expect(formatDuration(45_000)).toBe("45 s");
    expect(formatDuration(250_000)).toBe("4 min 10 s");
    expect(formatDuration(1_500_000)).toBe("25 min");
    expect(formatDuration(3_900_000)).toBe("1 h 5 min");
    expect(clockDown(299_100)).toBe("05:00");
    expect(clockDown(3_725_000)).toBe("1:02:05");
    expect(salute("sir")).toBe("Sir, ");
    expect(salute(" ")).toBe("");
  });
});

describe("running timers", () => {
  const t = (id: string, kind: Timer["kind"], label: string, due: number, repeat?: Timer["repeat"]): Timer => ({ id, kind, label, due, created: 0, repeat });
  it("finds timers by id, label, kind or all", () => {
    const ts = [t("a1", "timer", "pasta", 1), t("b2", "alarm", "", 2), t("c3", "reminder", "call Mum", 3)];
    expect(matchTimers(ts, "the pasta timer").map((x) => x.id)).toEqual(["a1"]);
    expect(matchTimers(ts, "b2").map((x) => x.id)).toEqual(["b2"]);
    expect(matchTimers(ts, "alarms").map((x) => x.id)).toEqual(["b2"]);
    expect(matchTimers(ts, "all")).toHaveLength(3);
    expect(matchTimers(ts, "laundry")).toHaveLength(0);
  });
  it("fires due ones and moves repeating alarms on", () => {
    const r = dueNow([t("a", "timer", "", NOW - 1), t("b", "alarm", "", at("2026-11-20T07:30:00"), "daily"), t("c", "reminder", "x", NOW + 60_000)], NOW);
    expect(r.fire.map((x) => x.id)).toEqual(["a", "b"]);
    expect(r.keep.map((x) => x.id)).toEqual(["c", "b"]);
    expect(r.keep[1].due).toBe(at("2026-11-21T07:30:00"));
  });
});
