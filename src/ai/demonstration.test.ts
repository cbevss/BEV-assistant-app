import { describe, it, expect } from "vitest";
import { charFor, demonstrationToSteps, type RecEvent } from "./demonstration";

const click = (t: number, name: string, role = "button", extra: Partial<{ password: boolean; button: string }> = {}): RecEvent => ({
  kind: "click",
  t,
  x: 0,
  y: 0,
  button: extra.button ?? "left",
  target: { name, role, process: "Discord.exe", password: !!extra.password },
} as RecEvent);
const key = (t: number, vk: number, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; win: boolean }> = {}): RecEvent => ({
  kind: "key",
  t,
  vk,
  ctrl: false,
  alt: false,
  shift: false,
  win: false,
  ...mods,
});
const typed = (t: number, s: string) => [...s].map((c, i) => key(t + i * 10, c === " " ? 0x20 : c.toUpperCase().charCodeAt(0)));

describe("charFor", () => {
  it("maps letters, digits and shifted characters (UK layout)", () => {
    expect(charFor(0x41, false)).toBe("a");
    expect(charFor(0x41, true)).toBe("A");
    expect(charFor(0x32, true)).toBe('"');
    expect(charFor(0x33, true)).toBe("£");
    expect(charFor(0x0d, false)).toBeNull();
  });
});

describe("demonstrationToSteps", () => {
  it("turns clicking a box and typing into one 'type' step", () => {
    const { steps } = demonstrationToSteps([click(0, "Search", "edit"), ...typed(500, "hi there"), key(1500, 0x0d)]);
    expect(steps.map((s) => s.tool)).toEqual(["use_named_control", "press_keys"]);
    expect(steps[0].args).toMatchObject({ app: "Discord", name: "Search", action: "type", text: "hi there" });
    expect(steps[1].args).toEqual({ keys: "enter" });
  });

  it("never keeps password typing", () => {
    const { steps, skipped } = demonstrationToSteps([click(0, "Password", "edit", { password: true }), ...typed(100, "secret"), click(2000, "Log in")]);
    expect(JSON.stringify(steps)).not.toContain("secret");
    expect(steps).toHaveLength(1);
    expect(skipped[0]).toMatch(/password/i);
  });

  it("skips unnamed and right clicks, and handles backspace", () => {
    const { steps, skipped } = demonstrationToSteps([
      click(0, "", "pane"),
      click(100, "Message", "button", { button: "right" }),
      ...typed(200, "abx"),
      key(300, 0x08),
      key(310, 0x43),
    ]);
    expect(skipped).toHaveLength(2);
    expect(steps).toEqual([expect.objectContaining({ tool: "type_text", args: { text: "abc" } })]);
  });

  it("records shortcuts and keeps delays within limits", () => {
    const { steps } = demonstrationToSteps([click(0, "Mute"), key(60_000, 0x53, { ctrl: true, shift: true })]);
    expect(steps[1]).toMatchObject({ tool: "press_keys", args: { keys: "ctrl+shift+s" }, delayMs: 3000 });
  });
});
