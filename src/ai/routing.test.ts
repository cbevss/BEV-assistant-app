import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
import { classify, modelFor, maxTokensFor } from "./routing";
import { parsePlan, unfinished, progress, formatPlan } from "./plan";
import { defaultSettings } from "@/state/settings";
import type { AiMessage } from "./types";

describe("classify", () => {
  it("quick for short simple asks", () => {
    expect(classify("what time is it", [])).toBe("quick");
    expect(classify("set volume to 30", [])).toBe("quick");
  });
  it("complex for multi-step, reasoning or long requests", () => {
    expect(classify("open spotify and then play my liked songs", [])).toBe("complex");
    expect(classify("why is my pc so slow", [])).toBe("complex");
    expect(classify("research the best budget 1440p monitors", [])).toBe("complex");
    expect(classify("word ".repeat(30), [])).toBe("complex");
    expect(classify("hi", [], { hasPlan: true })).toBe("complex");
    expect(classify("hi", [], { background: true })).toBe("complex");
  });
  it("escalates when the turn grows or a tool failed", () => {
    const rounds: AiMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "a", args: {} }] },
      { role: "assistant", content: "", toolCalls: [{ id: "2", name: "b", args: {} }] },
    ];
    expect(classify("do it", rounds)).toBe("complex");
    expect(classify("do it", [{ role: "tool", content: "error: nope" }])).toBe("complex");
  });
  it("vision whenever a screenshot is in the turn", () => {
    expect(classify("what's this", [{ role: "tool", content: "shot", images: [{ mediaType: "image/jpeg", data: "x" }] }])).toBe("vision");
  });
});

describe("modelFor", () => {
  it("fast model only for quick turns, only when routing is on", () => {
    const s = { ...defaultSettings, provider: "anthropic" as const, modelRouting: true, models: { anthropic: { model: "", fast: "claude-haiku-5-5" } } };
    expect(modelFor(s, "quick")).toBe("claude-haiku-5-5");
    expect(modelFor(s, "complex")).toBeUndefined();
    expect(modelFor(s, "vision")).toBeUndefined();
    expect(modelFor({ ...s, modelRouting: false }, "quick")).toBeUndefined();
    expect(modelFor({ ...s, provider: "ollama" }, "quick")).toBeUndefined();
    expect(modelFor({ ...s, models: { anthropic: { model: "", fast: "" } } }, "quick")).toBeUndefined();
    expect(maxTokensFor("complex")).toBeGreaterThan(maxTokensFor("quick"));
  });
});

describe("plans", () => {
  it("validates and summarises", () => {
    const p = parsePlan([{ text: "Find the file", status: "done", note: "found it" }, { text: "Open it", status: "in_progress" }, "Check it opened"]);
    expect(p[2].status).toBe("pending");
    expect(unfinished(p)).toHaveLength(2);
    expect(progress(p)).toEqual({ done: 1, total: 3 });
    expect(formatPlan(p)).toContain("[x] 1. Find the file (found it)");
  });
  it("rejects bad plans with useful messages", () => {
    expect(() => parsePlan([])).toThrow(/non-empty/);
    expect(() => parsePlan([{ status: "done" }])).toThrow(/step 1 needs text/);
    expect(() => parsePlan(Array(16).fill("x"))).toThrow(/15/);
  });
});
