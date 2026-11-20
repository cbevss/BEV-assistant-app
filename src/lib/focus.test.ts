import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn() }));
vi.mock("@/voice/sounds", () => ({ playChime: vi.fn() }));
import { startFocus, nextPhase, stopFocus, focusing } from "./focus";
import { isQuiet } from "./gaming";

describe("focus sessions", () => {
  it("runs pomodoro rounds with breaks, then ends", () => {
    let s = startFocus({ minutes: 25, rounds: 2, breakMinutes: 5 }, 0);
    expect(focusing()).toBe(true);
    expect(isQuiet()).toBe(true);
    let r = nextPhase(s, s.endsAt);
    expect(r.next).toMatchObject({ phase: "break", round: 1 });
    expect(r.say).toMatch(/5 minute break/);
    s = r.next!;
    r = nextPhase(s, s.endsAt);
    expect(r.next).toMatchObject({ phase: "focus", round: 2 });
    r = nextPhase(r.next!, r.next!.endsAt);
    expect(r.next).toBeNull();
    expect(r.say).toMatch(/50 min of focus/);
    stopFocus();
    expect(focusing()).toBe(false);
  });
  it("keeps settings within sense", () => {
    const s = startFocus({ minutes: 9999, rounds: 0, breakMinutes: -3 }, 0);
    expect([s.focusMin, s.rounds, s.breakMin]).toEqual([240, 1, 1]);
    stopFocus();
  });
});
