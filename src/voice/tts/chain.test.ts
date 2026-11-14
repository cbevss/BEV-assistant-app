import { describe, it, expect, vi, beforeEach } from "vitest";

const spoken: string[] = [];
const kokoro = { state: "ready" as string, preload: vi.fn(async () => {}) };
let elevenBehaviour: (text: string) => Promise<void> = async () => {};

vi.mock("../webspeech", () => ({
  WebSpeechSynthesizer: class {
    id = "webspeech";
    async speak(t: string) { spoken.push(`windows: ${t}`); }
    cancel() {}
    async listVoices() { return []; }
  },
}));
vi.mock("./kokoro", () => ({
  KokoroSynthesizer: class {
    id = "kokoro";
    async speak(t: string) { spoken.push(`kokoro: ${t}`); }
    cancel() {}
  },
  kokoroStatus: () => ({ state: kokoro.state }),
  preloadKokoro: () => kokoro.preload(),
  setKokoroGpu: () => {},
}));
vi.mock("./elevenlabs", async () => {
  const real = await vi.importActual<typeof import("./elevenlabs")>("./elevenlabs");
  return {
    ElevenLabsUnavailable: real.ElevenLabsUnavailable,
    ElevenLabsSynthesizer: class {
      id = "elevenlabs";
      async speak(t: string) { await elevenBehaviour(t); spoken.push(`eleven: ${t}`); }
      cancel() {}
    },
  };
});

import { ChainSynthesizer, resetVoiceFallbacks, type VoiceNote } from "./index";
import { ElevenLabsUnavailable } from "./elevenlabs";
import { SpeakError } from "./player";
import { defaultSettings } from "@/state/settings";

const make = (engine: "windows" | "kokoro" | "elevenlabs", notes: VoiceNote[] = []) =>
  new ChainSynthesizer({ ...defaultSettings, ttsEngine: engine, elevenVoiceId: "v1" }, async () => "key", (n) => notes.push(n));

describe("voice fallback chain", () => {
  beforeEach(() => {
    spoken.length = 0;
    kokoro.state = "ready";
    kokoro.preload.mockClear();
    elevenBehaviour = async () => {};
    resetVoiceFallbacks();
  });

  it("uses the chosen engine when it works", async () => {
    await make("elevenlabs").speak("Hello there.");
    expect(spoken).toEqual(["eleven: Hello there."]);
  });

  it("switches to the free voice when ElevenLabs credits run out, and says so once", async () => {
    elevenBehaviour = async () => { throw new ElevenLabsUnavailable("quota", "used up"); };
    const notes: VoiceNote[] = [];
    await make("elevenlabs", notes).speak("Hello there.");
    expect(spoken).toEqual(["kokoro: Hello there."]);
    expect(notes).toHaveLength(1);
    expect(notes[0].important).toBe(true);
    expect(notes[0].text).toMatch(/credits are used up/);

    // Next reply skips ElevenLabs entirely instead of failing again.
    elevenBehaviour = async () => { throw new Error("should not be called"); };
    await make("elevenlabs", notes).speak("Again.");
    expect(spoken.at(-1)).toBe("kokoro: Again.");
    expect(notes).toHaveLength(1);
  });

  it("continues from where a failed engine stopped", async () => {
    elevenBehaviour = async () => {
      throw new SpeakError(new ElevenLabsUnavailable("network", "offline"), "Second sentence.");
    };
    await make("elevenlabs").speak("First sentence. Second sentence.");
    expect(spoken).toEqual(["kokoro: Second sentence."]);
  });

  it("uses Windows while the free voice downloads, and starts the download", async () => {
    kokoro.state = "idle";
    const notes: VoiceNote[] = [];
    await make("kokoro", notes).speak("Hi.");
    expect(spoken).toEqual(["windows: Hi."]);
    expect(kokoro.preload).toHaveBeenCalledTimes(1);
    expect(notes[0].text).toMatch(/Downloading the free natural voice/);
  });

  it("Windows only means Windows only", async () => {
    await make("windows").speak("Hi.");
    expect(spoken).toEqual(["windows: Hi."]);
    expect(kokoro.preload).not.toHaveBeenCalled();
  });
});
