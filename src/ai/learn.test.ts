import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
import { normaliseRequest, similarity, stepsFromTurn, describeSteps, type TurnStep } from "./learn";

const step = (name: string, args: Record<string, unknown> = {}, ok = true, control?: TurnStep["control"]): TurnStep => ({
  call: { id: name, name, args },
  ok,
  control,
});

describe("normaliseRequest", () => {
  it("drops greetings, politeness and punctuation", () => {
    expect(normaliseRequest("Hey BEV, can you leave the Discord call please?")).toBe("leave the discord call");
    expect(normaliseRequest("leave the discord call for me, thanks")).toBe("leave the discord call");
  });
});

describe("similarity", () => {
  it("is 1 for the same words and 0 for none shared", () => {
    expect(similarity("leave the discord call", "leave the discord call")).toBe(1);
    expect(similarity("leave the discord call", "open spotify")).toBe(0);
  });
  it("scores partial overlap between", () => {
    const s = similarity("leave the discord call", "join the discord call");
    expect(s).toBeGreaterThan(0.3);
    expect(s).toBeLessThan(1);
  });
});

describe("stepsFromTurn", () => {
  const leave: TurnStep[] = [
    step("read_app_controls", { app: "Discord" }),
    step("use_control", { id: 12, action: "click" }, true, { app: "Discord.exe", name: "Disconnect", role: "button" }),
    step("focus_window", { app: "Discord" }),
    step("press_keys", { keys: "ctrl+shift+m" }),
  ];

  it("turns controls into named steps and skips reads", () => {
    const out = stepsFromTurn(leave, false)!;
    expect(out.map((s) => s.tool)).toEqual(["use_named_control", "focus_window", "press_keys"]);
    expect(out[0].args).toEqual({ app: "Discord", name: "Disconnect", role: "button", action: "click" });
    expect(out[0].delayMs).toBeUndefined();
    expect(out[2].delayMs).toBe(1500); // after focusing a window
  });

  it("won't learn a turn that needed approval or had a failure", () => {
    expect(stepsFromTurn(leave, true)).toBeNull();
    expect(stepsFromTurn([...leave.slice(0, 3), step("press_keys", { keys: "x" }, false)], false)).toBeNull();
  });

  it("won't learn clicks by position or tools it can't repeat", () => {
    expect(stepsFromTurn([step("launch_app", { name: "x" }), step("click_on_screen", { x: 10, y: 20 })], false)).toBeNull();
    expect(stepsFromTurn([step("launch_app", { name: "x" }), step("delete_file", { path: "a" })], false)).toBeNull();
  });

  it("needs a hands-on step and at least two steps", () => {
    expect(stepsFromTurn([step("launch_app", { name: "a" }), step("set_volume", { percent: 20 })], false)).toBeNull();
    expect(stepsFromTurn([step("press_keys", { keys: "f5" })], false)).toBeNull();
  });

  it("keeps clicks by visible text", () => {
    const out = stepsFromTurn([step("launch_app", { name: "Steam" }), step("click_on_screen", { text: "Library" })], false)!;
    expect(out[1]).toMatchObject({ tool: "click_on_screen", args: { text: "Library" }, delayMs: 1500 });
  });
});

describe("describeSteps", () => {
  it("writes one readable line per step", () => {
    const lines = describeSteps(stepsFromTurn(
      [step("use_control", { action: "click" }, true, { app: "Discord.exe", name: "Disconnect", role: "button" }), step("press_keys", { keys: "enter" })],
      false,
    )!);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/Disconnect/);
  });
});
