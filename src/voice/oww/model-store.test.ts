import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));

import { phraseFromFile } from "./model-store";

describe("phraseFromFile", () => {
  it.each([
    ["hey_bev.onnx", "hey BEV"],
    ["yo_bev.onnx", "yo BEV"],
    ["bev.onnx", "BEV"],
    ["hey_bev_or_yo_bev.onnx", "hey BEV or yo BEV"],
    ["Hey-Bev (1).onnx", "Hey BEV (1)"],
  ])("%s → %s", (file, phrase) => {
    expect(phraseFromFile(file)).toBe(phrase);
  });
});
