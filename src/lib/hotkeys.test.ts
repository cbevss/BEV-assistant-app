import { describe, it, expect } from "vitest";
import { acceleratorFromEvent, prettyAccelerator } from "./hotkeys";

const k = (code: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) => ({
  code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta,
});

describe("acceleratorFromEvent", () => {
  it("builds Tauri accelerators", () => {
    expect(acceleratorFromEvent(k("KeyM", { ctrl: true, alt: true }))).toBe("CommandOrControl+Alt+M");
    expect(acceleratorFromEvent(k("Digit5", { ctrl: true, shift: true }))).toBe("CommandOrControl+Shift+5");
    expect(acceleratorFromEvent(k("ArrowUp", { alt: true }))).toBe("Alt+Up");
    expect(acceleratorFromEvent(k("Numpad0", { ctrl: true }))).toBe("CommandOrControl+Num0");
  });
  it("allows function and similar keys on their own", () => {
    expect(acceleratorFromEvent(k("F9"))).toBe("F9");
    expect(acceleratorFromEvent(k("Pause"))).toBe("Pause");
    expect(acceleratorFromEvent(k("F13", { shift: true }))).toBe("Shift+F13");
  });
  it("ignores modifiers alone, bare letters and Shift+letter", () => {
    expect(acceleratorFromEvent(k("ControlLeft", { ctrl: true }))).toBeNull();
    expect(acceleratorFromEvent(k("KeyM"))).toBeNull();
    expect(acceleratorFromEvent(k("KeyM", { shift: true }))).toBeNull();
    expect(acceleratorFromEvent(k("Space"))).toBeNull();
  });
});

it("prettyAccelerator", () => {
  expect(prettyAccelerator("CommandOrControl+Alt+M")).toBe("Ctrl + Alt + M");
  expect(prettyAccelerator("")).toBe("");
});
