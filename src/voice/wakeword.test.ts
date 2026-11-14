import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSpeechWakeWord } from "./wakeword";

/** Minimal stand-in for the WebView2 SpeechRecognition object. */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  live = false;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    this.live = true;
  }
  abort() {
    this.end();
  }
  /** The real API always fires onend after an error or abort. */
  fail(error: string) {
    this.onerror?.({ error });
    this.end();
  }
  end() {
    if (!this.live) return;
    this.live = false;
    this.onend?.();
  }
}

const live = () => FakeRecognition.instances.filter((r) => r.live).length;

describe("WebSpeechWakeWord restarts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeRecognition.instances = [];
    vi.stubGlobal("window", { webkitSpeechRecognition: FakeRecognition });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps exactly one recogniser running across repeated errors", async () => {
    const w = new WebSpeechWakeWord();
    await w.start(() => {});
    expect(live()).toBe(1);

    for (let i = 0; i < 5; i++) {
      FakeRecognition.instances.find((r) => r.live)!.fail("no-speech");
      await vi.advanceTimersByTimeAsync(1000);
      expect(live()).toBe(1);
    }
    w.stop();
    expect(live()).toBe(0);
  });

  it("stops and reports when the microphone is blocked", async () => {
    const w = new WebSpeechWakeWord();
    const onFatal = vi.fn();
    w.onFatal = onFatal;
    await w.start(() => {});

    FakeRecognition.instances[0].fail("not-allowed");
    await vi.advanceTimersByTimeAsync(5000);

    expect(onFatal).toHaveBeenCalledWith("not-allowed");
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it("does not restart while paused, and resumes with one recogniser", async () => {
    const w = new WebSpeechWakeWord();
    await w.start(() => {});
    w.pauseListening();
    await vi.advanceTimersByTimeAsync(2000);
    expect(live()).toBe(0);

    w.resumeListening();
    await vi.advanceTimersByTimeAsync(2000);
    expect(live()).toBe(1);
    w.stop();
  });
});
