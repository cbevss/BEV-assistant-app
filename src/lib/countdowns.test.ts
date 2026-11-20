import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
import { daysUntil, describeCountdown } from "./countdowns";

const NOW = new Date(2026, 10, 20, 18, 0).getTime();

describe("countdowns", () => {
  it("counts whole days, rolling yearly ones over", () => {
    expect(daysUntil({ name: "Christmas", date: "2026-12-25", yearly: true }, NOW)).toBe(35);
    expect(daysUntil({ name: "Birthday", date: "2000-11-01", yearly: true }, NOW)).toBe(346);
    expect(daysUntil({ name: "Today", date: "2026-11-20" }, NOW)).toBe(0);
    expect(daysUntil({ name: "Gone", date: "2026-11-18" }, NOW)).toBe(-2);
  });
  it("reads naturally", () => {
    expect(describeCountdown({ name: "my holiday", date: "2027-03-14" }, NOW)).toMatch(/^114 days until my holiday \(about 16 weeks\), Sun,? 14 Mar 2027$/);
    expect(describeCountdown({ name: "payday", date: "2026-11-21" }, NOW)).toMatch(/^1 day until payday/);
  });
});
