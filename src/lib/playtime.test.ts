import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn() }));
vi.mock("@/voice/sounds", () => ({ playChime: vi.fn() }));
import { addSession, totalsSince, perDay, periodStart, type Session } from "./playtime";

const at = (d: string) => new Date(d).getTime();
const NOW = at("2026-11-20T22:00:00"); // Friday
const s = (game: string, a: string, b: string): Session => ({ game, start: at(a), end: at(b) });

describe("play time", () => {
  it("joins quick relaunches and drops launcher flashes", () => {
    let l: Session[] = [];
    l = addSession(l, s("Halo", "2026-11-20T18:00", "2026-11-20T19:00"), NOW);
    l = addSession(l, s("Halo", "2026-11-20T19:02", "2026-11-20T20:00"), NOW);
    expect(l).toEqual([s("Halo", "2026-11-20T18:00", "2026-11-20T20:00")]);
    l = addSession(l, { game: "Steam", start: NOW - 30_000, end: NOW }, NOW);
    expect(l).toHaveLength(1);
    // Old sessions fall away after 90 days.
    expect(addSession([s("Old", "2026-07-01T10:00", "2026-07-01T11:00")], s("New", "2026-11-20T10:00", "2026-11-20T11:00"), NOW).map((x) => x.game)).toEqual(["New"]);
  });

  it("totals per game for a period, clipping sessions that cross midnight", () => {
    const l = [s("Halo", "2026-11-19T23:00", "2026-11-20T01:00"), s("Halo", "2026-11-20T18:00", "2026-11-20T19:30"), s("Rocket League", "2026-11-20T20:00", "2026-11-20T20:30")];
    const today = totalsSince(l, periodStart("today", NOW));
    expect(today.map((t) => [t.game, t.ms / 60_000, t.sessions])).toEqual([["Halo", 150, 2], ["Rocket League", 30, 1]]);
    expect(totalsSince(l, 0, "rocket")).toHaveLength(1);
    expect(perDay(l, 2, NOW)).toEqual([60, 180]);
  });

  it("weeks start on Monday", () => {
    expect(new Date(periodStart("week", NOW)).getDay()).toBe(1);
    expect(new Date(periodStart("month", NOW)).getDate()).toBe(1);
  });
});
