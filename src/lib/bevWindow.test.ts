import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn(), PhysicalPosition: class {}, PhysicalSize: class {} }));
import { isBevItself } from "./bevWindow";

describe("BEV's own window", () => {
  it("knows when the user means BEV", () => {
    for (const s of ["BEV", "bev", "yourself", "your window", "this app", "BEV's window", "you"]) expect(isBevItself(s)).toBe(true);
    for (const s of ["Discord", "Chrome", "bevy game", "Steam"]) expect(isBevItself(s)).toBe(false);
  });
});
