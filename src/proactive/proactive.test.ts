import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
import { raise, configureNotices, deliverPending, useNotices, noticesForPrompt, _resetNotices } from "./notices";
import { crashNotices, netStep } from "./watchers";
import { briefingDue, briefingGoal } from "./briefing";
import type { NetworkFacts } from "@/lib/native";

describe("notices", () => {
  let clock = 1_000_000;
  let gaming = false;
  const notify = vi.fn();
  beforeEach(() => {
    _resetNotices();
    notify.mockReset();
    gaming = false;
    clock = 1_000_000;
    configureNotices({ notify, holdBack: async () => gaming, now: () => clock });
  });

  it("drops repeats inside the cooldown", async () => {
    expect(await raise("resources", "CPU running hot", "x", { key: "cpu", cooldownMs: 600_000 })).toBe(true);
    expect(await raise("resources", "CPU running hot", "x", { key: "cpu", cooldownMs: 600_000 })).toBe(false);
    clock += 700_000;
    expect(await raise("resources", "CPU running hot", "x", { key: "cpu", cooldownMs: 600_000 })).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("holds notices during a game, then sends one summary", async () => {
    gaming = true;
    await raise("crash", "Game crashed", "a");
    await raise("network", "Internet connection dropped", "b");
    await raise("network", "Internet is back", "c");
    expect(notify).not.toHaveBeenCalled();
    expect(useNotices.getState().items.every((n) => !n.delivered)).toBe(true);
    gaming = false;
    await deliverPending();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe("BEV noticed 3 things");
    expect(useNotices.getState().items.every((n) => n.delivered)).toBe(true);
  });

  it("gives recent notices to the AI", async () => {
    await raise("disk", "C:\\ is almost full", "3 GB free");
    expect(noticesForPrompt(clock)).toContain("C:\\ is almost full: 3 GB free");
    expect(noticesForPrompt(clock + 7 * 3600_000)).toBe("");
  });
});

describe("watchers", () => {
  it("reports each crash once", () => {
    const seen = new Set<string>();
    const facts = {
      app: [
        { t: "2026-11-17T10:00:00Z", kind: "crash" as const, app: "game.exe" },
        { t: "2026-11-17T10:05:00Z", kind: "hang" as const, app: "WINWORD.EXE" },
      ],
      system: [{ t: "2026-11-17T08:00:00Z", id: 41, provider: "Microsoft-Windows-Kernel-Power" }],
    };
    const first = crashNotices(facts, seen);
    expect(first.map((n) => n.title)).toEqual(["game crashed", "WINWORD stopped responding", "The PC shut down unexpectedly"]);
    expect(crashNotices(facts, seen)).toEqual([]);
  });

  const f = (up: boolean, dns = up): NetworkFacts => ({ dns: { ok: dns, ms: 5, error: null }, direct: [["1.1.1.1:443", { ok: up, ms: up ? 10 : null, error: null }]], named: { ok: up, ms: null, error: null } });

  it("needs two misses to call the internet down, and says when it's back", () => {
    let s = { downSince: null as number | null, misses: 0 };
    let r = netStep(s, f(false), 0);
    expect(r.notice).toBeUndefined();
    s = r.next;
    r = netStep(s, f(false), 60_000);
    expect(r.notice?.title).toBe("Internet connection dropped");
    s = r.next;
    r = netStep(s, f(false), 120_000);
    expect(r.notice).toBeUndefined();
    s = r.next;
    r = netStep(s, f(true), 360_000);
    expect(r.notice).toEqual({ title: "Internet is back", body: "It was down for about 6 minutes." });
    expect(netStep(r.next, f(true), 400_000).notice).toBeUndefined();
  });

  it("a blip doesn't alert", () => {
    const r = netStep({ downSince: null, misses: 0 }, f(false), 0);
    expect(netStep(r.next, f(true), 60_000).notice).toBeUndefined();
  });
});

describe("briefing", () => {
  const at = (h: number, m = 0) => {
    const d = new Date(2026, 10, 17, h, m);
    return d;
  };
  it("is due from the set time for three hours, once a day", () => {
    expect(briefingDue("08:30", at(8, 29), null)).toBe(false);
    expect(briefingDue("08:30", at(8, 30), null)).toBe(true);
    expect(briefingDue("08:30", at(11, 0), null)).toBe(true);
    expect(briefingDue("08:30", at(11, 31), null)).toBe(false);
    expect(briefingDue("08:30", at(9, 0), "2026-11-17")).toBe(false);
    expect(briefingDue("", at(9), null)).toBe(false);
    expect(briefingDue("nonsense", at(9), null)).toBe(false);
  });
  it("asks for real sources only", () => {
    expect(briefingGoal()).toMatch(/Don't invent anything/);
  });
});
