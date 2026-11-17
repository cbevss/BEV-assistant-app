import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { normaliseLabel, matchEndpoint, effectiveMic, micErrorProblem, endpointProblems, type WinInput } from "./mic";

const eps: WinInput[] = [
  { id: "{a}", name: "Microphone (Realtek(R) Audio)", is_default: true, muted: false, volume: 0.8 },
  { id: "{b}", name: "Headset Microphone (HyperX Cloud II Wireless)", is_default: false, muted: false, volume: 0.2 },
  { id: "{c}", name: "Microphone (C920 Webcam)", is_default: false, muted: true, volume: 1 },
];

describe("labels", () => {
  it("normalises webview labels", () => {
    expect(normaliseLabel("Default - Microphone (Realtek(R) Audio) (0bda:0567)")).toBe("microphone (realtek(r) audio)");
    expect(normaliseLabel("Communications - Headset Microphone (HyperX)")).toBe("headset microphone (hyperx)");
  });
  it("matches webview mics to Windows endpoints", () => {
    expect(matchEndpoint("Headset Microphone (HyperX Cloud II Wireless) (0951:1718)", eps)?.id).toBe("{b}");
    expect(matchEndpoint("Default - Microphone (Realtek(R) Audio)", eps)?.id).toBe("{a}");
    expect(matchEndpoint("", eps)).toBeUndefined();
  });
});

describe("effectiveMic", () => {
  const devs = [
    { deviceId: "default", label: "Default - Microphone (Realtek(R) Audio)" },
    { deviceId: "r1", label: "Microphone (Realtek(R) Audio)" },
    { deviceId: "h1", label: "Headset Microphone (HyperX Cloud II Wireless)" },
  ];
  it("uses the chosen mic when connected", () => {
    expect(effectiveMic("h1", devs)).toEqual({ deviceId: "h1", label: "Headset Microphone (HyperX Cloud II Wireless)", fallback: false });
  });
  it("falls back to the default when the chosen mic is unplugged", () => {
    expect(effectiveMic("gone", devs)).toEqual({ deviceId: "", label: "microphone (realtek(r) audio)", fallback: true });
    expect(effectiveMic("", devs).fallback).toBe(false);
  });
});

describe("problems", () => {
  it("explains getUserMedia errors", () => {
    expect(micErrorProblem(new DOMException("x", "NotAllowedError")).message).toMatch(/Privacy & security → Microphone/);
    expect(micErrorProblem(new DOMException("x", "NotReadableError")).kind).toBe("busy");
    expect(micErrorProblem(new DOMException("x", "NotFoundError")).kind).toBe("missing");
  });
  it("spots muted, quiet and not-default mics", () => {
    const hs = endpointProblems("Headset Microphone (HyperX Cloud II Wireless)", eps, true).map((p) => p.kind);
    expect(hs).toEqual(["low_level", "not_default"]);
    expect(endpointProblems("Microphone (C920 Webcam)", eps, false).map((p) => p.kind)).toEqual(["muted"]);
    expect(endpointProblems("Microphone (Realtek(R) Audio)", eps, true)).toEqual([]);
  });
});
