import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@/lib/native", () => ({ native: { getSecret: vi.fn() } }));

import { toAnthropicMessages } from "./anthropic";
import { toOpenAiMessages } from "./openai";
import type { AiMessage } from "../types";

const history: AiMessage[] = [
  { role: "user", content: "open discord and set volume to 30" },
  {
    role: "assistant",
    content: "On it.",
    toolCalls: [
      { id: "t1", name: "launch_app", args: { name: "discord" } },
      { id: "t2", name: "set_volume", args: { percent: 30 } },
    ],
  },
  { role: "tool", toolCallId: "t1", toolName: "launch_app", content: "launched discord" },
  { role: "tool", toolCallId: "t2", toolName: "set_volume", content: "volume set to 30%" },
  { role: "assistant", content: "Discord's open and volume is at 30%." },
];

describe("anthropic mapping", () => {
  const out = toAnthropicMessages(history);

  it("alternates roles strictly", () => {
    for (let i = 1; i < out.length; i++) expect(out[i].role).not.toBe(out[i - 1].role);
  });

  it("emits tool_use blocks on the assistant turn", () => {
    const uses = out[1].content.filter((b) => b.type === "tool_use");
    expect(uses.map((u) => (u as { id: string }).id)).toEqual(["t1", "t2"]);
  });

  it("merges consecutive tool results into one user turn right after", () => {
    expect(out[2].role).toBe("user");
    const results = out[2].content.filter((b) => b.type === "tool_result");
    expect(results).toHaveLength(2);
  });
});

describe("openai mapping", () => {
  const out = toOpenAiMessages({ system: "sys", messages: history, tools: [] }) as Array<
    Record<string, unknown>
  >;

  it("starts with the system prompt", () => {
    expect(out[0]).toEqual({ role: "system", content: "sys" });
  });

  it("carries tool_calls with real JSON args", () => {
    const a = out[2] as { tool_calls: Array<{ id: string; function: { arguments: string } }> };
    expect(a.tool_calls.map((c) => c.id)).toEqual(["t1", "t2"]);
    expect(JSON.parse(a.tool_calls[1].function.arguments)).toEqual({ percent: 30 });
  });

  it("links tool results by id", () => {
    expect(out[3]).toMatchObject({ role: "tool", tool_call_id: "t1" });
    expect(out[4]).toMatchObject({ role: "tool", tool_call_id: "t2" });
  });
});

import { toOllamaMessages } from "./ollama";

describe("screenshots", () => {
  const img = { mediaType: "image/jpeg" as const, data: "QUJD" };
  const shot: AiMessage[] = [
    { role: "user", content: "what's this error?" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "s1", name: "look_at_screen", args: {} },
        { id: "s2", name: "get_system_stats", args: {} },
      ],
    },
    { role: "tool", toolCallId: "s1", toolName: "look_at_screen", content: "Screenshot attached", images: [img] },
    { role: "tool", toolCallId: "s2", toolName: "get_system_stats", content: "{}" },
  ];

  it("anthropic puts the image inside the tool_result", () => {
    const out = toAnthropicMessages(shot);
    const res = out[2].content[0] as { type: string; content: Array<{ type: string; source?: { data: string } }> };
    expect(res.type).toBe("tool_result");
    expect(res.content.map((b) => b.type)).toEqual(["text", "image"]);
    expect(res.content[1].source?.data).toBe("QUJD");
  });

  it("openai keeps tool results contiguous and sends the image after them", () => {
    const out = toOpenAiMessages({ system: "s", messages: shot, tools: [] }) as Array<{
      role: string;
      content: unknown;
    }>;
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool", "user"]);
    const parts = out[5].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts[1].image_url?.url).toBe("data:image/jpeg;base64,QUJD");
  });

  it("ollama sends images after the results, or a note when the model can't see", () => {
    const withImg = toOllamaMessages({ system: "s", messages: shot, tools: [] }, true) as Array<{
      role: string;
      images?: string[];
      content: string;
    }>;
    expect(withImg.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool", "user"]);
    expect(withImg[5].images).toEqual(["QUJD"]);
    const without = toOllamaMessages({ system: "s", messages: shot, tools: [] }, false) as typeof withImg;
    expect(without[5].images).toBeUndefined();
    expect(without[5].content).toMatch(/vision model/);
  });
});
