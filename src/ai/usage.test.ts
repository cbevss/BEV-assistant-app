import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn(async () => {}) }));
import { addUsage, totals, limitState, priceFor, costOf, estimateUsage, prune, dayKey, formatUsd, type UsageDays } from "./usage";

const NOW = new Date(2026, 10, 19, 12).getTime();
const today = dayKey(NOW);

describe("prices", () => {
  it("uses custom, then built-in prices; local AI is free; unknown is null", () => {
    expect(priceFor("anthropic", "claude-sonnet-5-5", {})).toEqual({ input: 2, output: 10 });
    expect(priceFor("anthropic", "claude-sonnet-5-5", { "claude-sonnet-5-5": { input: 1, output: 1 } })).toEqual({ input: 1, output: 1 });
    expect(priceFor("ollama", "llama3.1", {})).toEqual({ input: 0, output: 0 });
    expect(priceFor("mistral", "mistral-large-latest", {})).toBeNull();
    expect(costOf({ input: 1_000_000, output: 500_000 }, { input: 2, output: 10 })).toBe(7);
  });
});

describe("recording and totals", () => {
  it("adds up per model and day, and unknown prices stay unknown", () => {
    let d: UsageDays = {};
    d = addUsage(d, today, "anthropic", "claude-sonnet-5-5", { input: 100_000, output: 10_000 }, { input: 2, output: 10 }, false);
    d = addUsage(d, today, "anthropic", "claude-sonnet-5-5", { input: 100_000, output: 10_000 }, { input: 2, output: 10 }, true);
    d = addUsage(d, today, "mistral", "mistral-large-latest", { input: 5, output: 5 }, null, false);
    const r = d[today]["anthropic/claude-sonnet-5-5"];
    expect(r).toMatchObject({ requests: 2, input: 200_000, output: 20_000, estimated: true });
    expect(r.cost).toBeCloseTo(0.6);
    const t = totals(d, today, today);
    expect(t.requests).toBe(3);
    expect(t.unpriced).toBe(1);
    expect(t.cost).toBeCloseTo(0.6);
  });

  it("checks limits by day and month, with an 80% warning", () => {
    let d: UsageDays = {};
    d = addUsage(d, today, "anthropic", "claude-opus-5-5", { input: 0, output: 200_000 }, { input: 4, output: 20 }, false); // $4
    expect(limitState(d, { dailyUsd: 5, monthlyUsd: null }, NOW)).toMatchObject({ reached: null, near: "daily" });
    expect(limitState(d, { dailyUsd: 4, monthlyUsd: null }, NOW).reached).toBe("daily");
    d = addUsage(d, dayKey(NOW - 5 * 86_400_000), "anthropic", "claude-opus-5-5", { input: 0, output: 500_000 }, { input: 4, output: 20 }, false); // $10
    expect(limitState(d, { dailyUsd: 100, monthlyUsd: 12 }, NOW).reached).toBe("monthly");
    expect(limitState(d, { dailyUsd: null, monthlyUsd: null }, NOW)).toMatchObject({ reached: null, near: null });
    expect(limitState(d, { dailyUsd: 0, monthlyUsd: null }, NOW).reached).toBeNull();
  });

  it("estimates about four characters a token and prunes old days", () => {
    expect(estimateUsage({ system: "x".repeat(400), messages: [], tools: [] }, { text: "y".repeat(40), toolCalls: [] })).toEqual({ input: 101, output: 11 });
    const old = dayKey(NOW - 200 * 86_400_000);
    expect(Object.keys(prune({ [old]: {}, [today]: {} }, NOW))).toEqual([today]);
  });

  it("formats money", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(3.456)).toBe("$3.46");
    expect(formatUsd(42.4)).toBe("$42");
  });
});
