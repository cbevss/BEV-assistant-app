import { fetch } from "@tauri-apps/plugin-http";
import { native } from "@/lib/native";
import {
  AiImage,
  AiProvider,
  AiResponse,
  ChatRequest,
  ProviderError,
  httpError,
  ToolCall,
} from "../types";

/**
 * Anthropic Claude provider. The API key is read from the OS keyring at call
 * time and sent only to api.anthropic.com via the Tauri HTTP plugin (which
 * bypasses CORS and is allowlisted by the CSP connect-src in tauri.conf.json).
 */
export class AnthropicProvider implements AiProvider {
  readonly id = "anthropic" as const;
  readonly label = "Anthropic Claude";
  private model = "claude-sonnet-5-5";

  constructor(model?: string) {
    if (model) this.model = model;
  }

  async isConfigured(): Promise<boolean> {
    const key = await native.getSecret("anthropic_api_key").catch(() => null);
    return !!key;
  }

  async chat(req: ChatRequest): Promise<AiResponse> {
    const key = await native.getSecret("anthropic_api_key");
    if (!key) throw new ProviderError("Anthropic API key not set", false, "auth");

    const body = {
      model: req.model || this.model,
      max_tokens: req.maxTokens ?? 1024,
      // Only send temperature when explicitly set — newer Claude models reject it.
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      system: req.system,
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
      messages: toAnthropicMessages(req.messages),
    };

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        // The request carries a browser Origin; Anthropic requires this to allow it.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal: req.signal,
    } as RequestInit).catch((e: unknown) => {
      if (req.signal?.aborted) throw e;
      throw new ProviderError(`Anthropic: couldn't connect (${String(e)})`, true, "network");
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      // 529 = overloaded: worth trying a backup.
      throw httpError("Anthropic", res.status, txt);
    }

    const data = (await res.json()) as AnthropicResponse;
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of data.content ?? []) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
      }
    }
    return { text: text.trim(), toolCalls };
  }
}

interface AnthropicResponse {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
}

type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: AiImage["mediaType"]; data: string };
};

type Block =
  | { type: "text"; text: string }
  | ImageBlock
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | Array<{ type: "text"; text: string } | ImageBlock> };

const imageBlock = (i: AiImage): ImageBlock => ({
  type: "image",
  source: { type: "base64", media_type: i.mediaType, data: i.data },
});

/**
 * Map neutral history to Anthropic's format: assistant tool calls become
 * `tool_use` blocks, and each run of tool results is merged into ONE user turn
 * of `tool_result` blocks (the API requires them immediately after the call).
 * Consecutive same-role turns are merged since roles must alternate.
 */
export function toAnthropicMessages(messages: ChatRequest["messages"]) {
  const out: { role: "user" | "assistant"; content: Block[] }[] = [];
  const push = (role: "user" | "assistant", blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const content = m.images?.length
        ? [{ type: "text" as const, text: m.content }, ...m.images.map(imageBlock)]
        : m.content;
      push("user", [{ type: "tool_result", tool_use_id: m.toolCallId ?? "", content }]);
    } else if (m.role === "assistant") {
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      }
      push("assistant", blocks);
    } else if (m.content || m.images?.length) {
      const blocks: Block[] = (m.images ?? []).map(imageBlock);
      if (m.content) blocks.push({ type: "text", text: m.content });
      push("user", blocks);
    }
  }
  return out;
}
