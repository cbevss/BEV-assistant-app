import { describe, expect, it } from "vitest";
import { freshStats, learn, learnedWindow, MIN_SAMPLES, type FollowUpStats } from "./followUpLearn";

const repeat = (s: FollowUpStats, kind: "question" | "statement", after: number | null, times: number) => {
  for (let i = 0; i < times; i++) s = learn(s, kind, after);
  return s;
};

describe("follow-up learning", () => {
  it("changes nothing until it has enough samples", () => {
    const s = repeat(freshStats(), "statement", null, MIN_SAMPLES - 1);
    expect(learnedWindow(s, "statement", 8000)).toBe(8000);
  });
  it("stops waiting after statements the user never follows up", () => {
    const s = repeat(freshStats(), "statement", null, 15);
    expect(learnedWindow(s, "statement", 8000)).toBe(0);
  });
  it("keeps a short window when they sometimes follow up", () => {
    let s = freshStats();
    for (let i = 0; i < 20; i++) s = learn(s, "statement", i % 4 === 0 ? 1000 : null);
    const w = learnedWindow(s, "statement", 8000);
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThanOrEqual(3500);
  });
  it("fits the window to how fast they answer questions, never below 4s or above the setting", () => {
    const fast = repeat(freshStats(), "question", 800, 20);
    expect(learnedWindow(fast, "question", 10000)).toBe(4000);
    const slow = repeat(freshStats(), "question", 6000, 20);
    expect(learnedWindow(slow, "question", 10000)).toBe(10000);
  });
  it("always listens after a question, even if they rarely answer", () => {
    const s = repeat(freshStats(), "question", null, 30);
    expect(learnedWindow(s, "question", 8000)).toBeGreaterThan(0);
  });
  it("recovers when the user starts following up again", () => {
    let s = repeat(freshStats(), "statement", null, 15);
    s = repeat(s, "statement", 1200, 8);
    expect(learnedWindow(s, "statement", 8000)).toBeGreaterThan(0);
  });
});
