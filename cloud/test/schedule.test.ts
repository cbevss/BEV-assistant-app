import { describe, it, expect } from "vitest";
import { parseRepeat, nextRun, parseWhen, zonedToUtc, localParts } from "../src/schedule";

const TZ = "Europe/London";
const at = (s: string) => parseWhen(s, TZ)!;
const local = (ms: number) => {
  const p = localParts(ms, TZ);
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")} ${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
};

describe("parseRepeat", () => {
  it("reads the supported rules", () => {
    expect(parseRepeat("every 30m")).toEqual({ type: "every", ms: 1_800_000 });
    expect(parseRepeat("Every 2 hours")).toEqual({ type: "every", ms: 7_200_000 });
    expect(parseRepeat("daily 08:00")).toEqual({ type: "daily", h: 8, m: 0, days: undefined });
    expect(parseRepeat("weekdays 7:30")).toMatchObject({ days: [1, 2, 3, 4, 5] });
    expect(parseRepeat("weekly mon,thu 18:30")).toMatchObject({ days: [1, 4], h: 18, m: 30 });
    expect(parseRepeat("monthly 1 09:00")).toEqual({ type: "monthly", day: 1, h: 9, m: 0 });
  });
  it("rejects nonsense and too-frequent checks", () => {
    for (const s of ["", "sometimes", "every 1m", "daily 25:00", "weekly funday 09:00", "monthly 31 09:00"])
      expect(parseRepeat(s)).toBeNull();
  });
});

describe("times in Europe/London", () => {
  it("handles GMT and BST", () => {
    expect(new Date(zonedToUtc(2026, 1, 15, 9, 0, TZ)).toISOString()).toBe("2026-01-15T09:00:00.000Z");
    expect(new Date(zonedToUtc(2026, 7, 15, 9, 0, TZ)).toISOString()).toBe("2026-07-15T08:00:00.000Z");
  });
  it("parses local and offset times", () => {
    expect(new Date(at("2026-11-16T18:00")).toISOString()).toBe("2026-11-16T18:00:00.000Z");
    expect(new Date(at("2026-06-16T18:00")).toISOString()).toBe("2026-06-16T17:00:00.000Z");
    expect(new Date(at("2026-06-16T18:00:00Z")).toISOString()).toBe("2026-06-16T18:00:00.000Z");
    expect(parseWhen("tomorrow", TZ)).toBeNull();
  });
});

describe("nextRun", () => {
  it("daily: later today, else tomorrow", () => {
    const r = parseRepeat("daily 08:00")!;
    expect(local(nextRun(r, at("2026-11-16T07:00"), TZ))).toBe("2026-11-16 08:00");
    expect(local(nextRun(r, at("2026-11-16T08:00"), TZ))).toBe("2026-11-17 08:00");
  });
  it("stays at 08:00 local across the clocks going back", () => {
    const r = parseRepeat("daily 08:00")!;
    // UK clocks go back on Sun 25 Oct 2026.
    expect(local(nextRun(r, at("2026-10-24T09:00"), TZ))).toBe("2026-10-25 08:00");
    expect(local(nextRun(r, at("2026-10-25T09:00"), TZ))).toBe("2026-10-26 08:00");
  });
  it("weekdays and weekly", () => {
    // Fri 20 Nov 2026 after 08:00 → Mon 23 Nov.
    expect(local(nextRun(parseRepeat("weekdays 08:00")!, at("2026-11-20T09:00"), TZ))).toBe("2026-11-23 08:00");
    expect(local(nextRun(parseRepeat("weekly thu 18:30")!, at("2026-11-16T12:00"), TZ))).toBe("2026-11-19 18:30");
  });
  it("monthly and every", () => {
    expect(local(nextRun(parseRepeat("monthly 1 09:00")!, at("2026-11-16T12:00"), TZ))).toBe("2026-12-01 09:00");
    expect(nextRun(parseRepeat("every 30m")!, 1000, TZ)).toBe(1000 + 1_800_000);
  });
});
