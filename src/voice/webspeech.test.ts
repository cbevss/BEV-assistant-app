import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSpeechRecognizer, SttError } from "./webspeech";

type R = { transcript: string; isFinal: boolean };

class FakeRec {
  static last: FakeRec;
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  results: R[] = [];
  stopped = 0;
  constructor() {
    FakeRec.last = this;
  }
  start() {}
  stop() {
    this.stopped++;
    // The real recogniser finalises what it has, then ends.
    this.results = this.results.map((r) => ({ ...r, isFinal: true }));
    queueMicrotask(() => this.onend?.());
  }
  abort() {
    queueMicrotask(() => this.onend?.());
  }
  say(...rs: R[]) {
    this.results = rs;
    this.onresult?.({ results: rs.map((r) => Object.assign([{ transcript: r.transcript }], { isFinal: r.isFinal })) });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { window?: unknown }).window = { SpeechRecognition: FakeRec };
});
afterEach(() => {
  vi.useRealTimers();
});

describe("WebSpeechRecognizer", () => {
  it("keeps listening through a short pause and joins the sentence", async () => {
    const p = new WebSpeechRecognizer("en-GB", 1300).listenOnce({});
    const rec = FakeRec.last;
    expect(rec.continuous).toBe(true);
    rec.say({ transcript: "open rocket league", isFinal: true });
    await vi.advanceTimersByTimeAsync(800); // pause, but shorter than the end-of-speech gap
    expect(rec.stopped).toBe(0);
    rec.say({ transcript: "open rocket league", isFinal: true }, { transcript: " in offline mode", isFinal: false });
    await vi.advanceTimersByTimeAsync(1300);
    expect(rec.stopped).toBe(1);
    await expect(p).resolves.toBe("open rocket league in offline mode");
  });

  it("doesn't repeat earlier phrases", async () => {
    const parts: string[] = [];
    const p = new WebSpeechRecognizer("en-GB", 1000).listenOnce({ onPartial: (t) => parts.push(t) });
    const rec = FakeRec.last;
    rec.say({ transcript: "hello", isFinal: true });
    rec.say({ transcript: "hello", isFinal: true }, { transcript: " there", isFinal: true });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe("hello there");
    expect(parts.at(-1)).toBe("hello there");
  });

  it("resolves empty on silence and rejects real errors", async () => {
    const silent = new WebSpeechRecognizer().listenOnce({});
    FakeRec.last.onerror?.({ error: "no-speech" });
    FakeRec.last.onend?.();
    await expect(silent).resolves.toBe("");

    const net = new WebSpeechRecognizer().listenOnce({});
    FakeRec.last.onerror?.({ error: "network" });
    FakeRec.last.onend?.();
    await expect(net).rejects.toBeInstanceOf(SttError);
  });

  it("rejects with AbortError when aborted", async () => {
    const ctl = new AbortController();
    const p = new WebSpeechRecognizer().listenOnce({ signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});
