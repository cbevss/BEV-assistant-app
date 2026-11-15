import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));

import { popupAllowed } from "./overlayGate";

describe("popupAllowed", () => {
  it("always shows on the normal desktop", () => {
    for (const m of ["auto", "show", "hide"] as const) expect(popupAllowed(m, "none")).toBe(true);
  });
  it("auto: borderless yes, exclusive fullscreen no", () => {
    expect(popupAllowed("auto", "borderless")).toBe(true);
    expect(popupAllowed("auto", "exclusive")).toBe(false);
  });
  it("hide and show override", () => {
    expect(popupAllowed("hide", "borderless")).toBe(false);
    expect(popupAllowed("hide", "exclusive")).toBe(false);
    expect(popupAllowed("show", "exclusive")).toBe(true);
  });
});
