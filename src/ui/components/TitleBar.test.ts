import { describe, it, expect } from "vitest";
import capabilityJson from "../../../src-tauri/capabilities/default.json";

/**
 * Tauri v2 denies any window command that isn't allow-listed in the capability
 * file, and the rejection is silent unless the caller handles it. `core:default`
 * only grants read-only window queries, so every mutating call the title bar
 * makes must be listed explicitly or the button does nothing.
 */
const capability = capabilityJson as {
  windows: string[];
  permissions: (string | { identifier: string })[];
};

const granted = new Set(
  capability.permissions.map((p) => (typeof p === "string" ? p : p.identifier))
);

describe("title bar window controls are permitted", () => {
  it("applies to the main window", () => {
    expect(capability.windows).toContain("main");
  });

  it.each([
    ["minimise button → window.minimize()", "core:window:allow-minimize"],
    ["maximise button → window.toggleMaximize()", "core:window:allow-toggle-maximize"],
    ["close / minimise to tray → window.hide()", "core:window:allow-hide"],
    ["tray restore → window.show()", "core:window:allow-show"],
  ])("%s", (_what, permission) => {
    expect(granted.has(permission)).toBe(true);
  });

  it("close button can quit the app via the process plugin", () => {
    expect(granted.has("process:default") || granted.has("process:allow-exit")).toBe(true);
  });
});
