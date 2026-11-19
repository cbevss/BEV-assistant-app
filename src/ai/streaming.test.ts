import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@/lib/native", () => ({ native: { getSecret: vi.fn(async () => "k") } }));

import { bodyOf, sse } from "./providers/stream";
import { readAnthropicStream } from "./providers/anthropic";
import { readOpenAiStream } from "./providers/openai";
import { readOllamaStream } from "./providers/ollama";
import { FallbackProvider } from "./fallback";
import { ProviderError, type AiProvider } from "./types";
import { SpeechStream, speakable, takeSentences } from "@/voice/speechStream";
import type { SpeechSynthesizer } from "@/voice/types";

const res = (chunks: string[]) => new Response(bodyOf(chunks));

describe("reading streams", () => {
  it("parses server-sent events split across chunks", async () => {
    const out = [];
    for await (const e of sse(bodyOf(["event: a\ndata: {\"x\"", ":1}\n\n: keep-alive\n", "data: two\n\n"]))) out.push(e);
    expect(out).toEqual([
      { event: "a", data: '{"x":1}' },
      { event: "message", data: "two" },
    ]);
  });

  it("assembles Anthropic text and tool calls", async () => {
    const got: string[] = [];
    const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const r = await readAnthropicStream(
      res([
        ev({ type: "message_start" }),
        ev({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
        ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Opening " } }),
        ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Spotify." } }),
        ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "launch_app" } }),
        ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"na' } }),
        ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'me":"spotify"}' } }),
        ev({ type: "message_stop" }),
      ]),
      (d) => got.push(d)
    );
    expect(got).toEqual(["Opening ", "Spotify."]);
    expect(r).toEqual({ text: "Opening Spotify.", toolCalls: [{ id: "t1", name: "launch_app", args: { name: "spotify" } }] });
  });

  it("turns an Anthropic overload mid-stream into a backup-worthy error", async () => {
    await expect(readAnthropicStream(res([`data: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } })}\n\n`]), () => {})).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("assembles OpenAI-style deltas and tool calls by index", async () => {
    const got: string[] = [];
    const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const r = await readOpenAiStream(
      res([
        ev({ choices: [{ delta: { content: "Hi " } }] }),
        ev({ choices: [{ delta: { content: "there." } }] }),
        ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "set_volume", arguments: '{"lev' } }] } }] }),
        ev({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'el":30}' } }] } }] }),
        "data: [DONE]\n\n",
      ]),
      (d) => got.push(d),
      undefined,
      "OpenAI"
    );
    expect(got.join("")).toBe("Hi there.");
    expect(r.toolCalls).toEqual([{ id: "c1", name: "set_volume", args: { level: 30 } }]);
  });

  it("reads Ollama's line-by-line stream", async () => {
    const got: string[] = [];
    const r = await readOllamaStream(
      res(['{"message":{"content":"It\'s "}}\n{"message":{"content":"3pm."}}\n', '{"message":{"content":"","tool_calls":[{"function":{"name":"get_datetime","arguments":{}}}]},"done":true}\n']),
      (d) => got.push(d)
    );
    expect(got).toEqual(["It's ", "3pm."]);
    expect(r.toolCalls[0].name).toBe("get_datetime");
  });
});

describe("speaking while writing", () => {
  it("cuts finished sentences off the front and keeps the rest", () => {
    expect(takeSentences("Sure. Opening Spotify now! And then")).toEqual({ sentences: ["Sure.", "Opening Spotify now!"], rest: "And then" });
    expect(takeSentences("Version 3.5 is out. Next")).toEqual({ sentences: ["Version 3.5 is out."], rest: "Next" });
    expect(takeSentences("Try e.g. Chrome. Done")).toEqual({ sentences: ["Try e.g. Chrome."], rest: "Done" });
    expect(takeSentences("Line one\nLine two")).toEqual({ sentences: ["Line one"], rest: "Line two" });
    const long = "word ".repeat(80);
    expect(takeSentences(long).sentences.length).toBeGreaterThan(0);
  });

  it("strips markdown and links before speaking", () => {
    expect(speakable("**Done.** See [the docs](https://x.y/z) or `npm i`.")).toBe("Done. See the docs or npm i.");
    expect(speakable("- one\n- two")).toBe("one\ntwo");
  });

  function fakeTts() {
    const said: string[] = [];
    let release: (() => void) | null = null;
    const tts: SpeechSynthesizer = {
      id: "fake",
      speak: (t: string) =>
        new Promise<void>((r) => {
          said.push(t);
          release = r;
        }),
      cancel: () => release?.(),
      listVoices: async () => [],
    } as unknown as SpeechSynthesizer;
    return { tts, said, next: () => release?.() };
  }

  it("starts on the first sentence and speaks the rest in order", async () => {
    const { tts, said, next } = fakeTts();
    let first = 0;
    const s = new SpeechStream(tts, { onFirstSpeech: () => first++ });
    s.push("Sure thing");
    expect(said).toEqual([]);
    s.push(". Opening Spotify");
    expect(said).toEqual(["Sure thing."]);
    s.push(" now. Playing your liked songs");
    s.end();
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
      next();
      await new Promise((r) => setTimeout(r, 0));
    }
    await s.done();
    // The first sentence goes out alone; what queued up behind it is spoken together.
    expect(said).toEqual(["Sure thing.", "Opening Spotify now. Playing your liked songs"]);
    expect(first).toBe(1);
  });

  it("stops at once when cancelled", async () => {
    const { tts, said } = fakeTts();
    const s = new SpeechStream(tts);
    s.push("One. Two. Three.");
    s.cancel();
    await s.done();
    expect(said).toEqual(["One."]);
    s.push("Four.");
    expect(said).toEqual(["One."]);
  });
});

describe("no repeats once speech has started", () => {
  it("doesn't switch to a backup after the main AI started streaming", async () => {
    const main: AiProvider = {
      id: "anthropic",
      label: "A",
      isConfigured: async () => true,
      chat: async (r) => {
        r.onText?.("Half a sen");
        throw new ProviderError("dropped", true, "network");
      },
    };
    const backup: AiProvider = { id: "openai", label: "B", isConfigured: async () => true, chat: vi.fn(async () => ({ text: "x", toolCalls: [] })) };
    await expect(new FallbackProvider([{ provider: main }, { provider: backup }]).chat({ system: "", messages: [], tools: [], onText: () => {} })).rejects.toThrow(/dropped/);
    expect(backup.chat).not.toHaveBeenCalled();
  });
});
