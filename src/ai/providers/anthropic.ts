import { fetch } from "@tauri-apps/plugin-http";
import { sse } from "./stream";
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
  readonly model: string = "claude-sonnet-5-5";

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
      ...(req.onText ? { stream: true } : {}),
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

    if (req.onText) {
      const r = await readAnthropicStream(res, req.onText, req.signal);
      return r.usage ? { ...r, usage: { ...r.usage, model: body.model } } : r;
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
    const u = data.usage;
    return { text: text.trim(), toolCalls, ...(u ? { usage: { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens ?? 0, model: body.model } } : {}) };
  }
}

/** Anthropic's event stream: text deltas and tool-use blocks built from JSON pieces. */
export async function readAnthropicStream(res: Response, onText: (d: string) => void, signal?: AbortSignal): Promise<AiResponse> {
  let text = "";
  let input = -1;
  let output = 0;
  const blocks = new Map<number, { id: string; name: string; json: string }>();
  for await (const ev of sse(res.body, signal)) {
    if (!ev.data || ev.data === "[DONE]") continue;
    let d: {
      type?: string;
      index?: number;
      content_block?: { type: string; id?: string; name?: string };
      delta?: { type?: string; text?: string; partial_json?: string };
      error?: { type?: string; message?: string };
      message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
      usage?: { output_tokens?: number };
    };
    try {
      d = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (d.type === "error") {
      const kind = d.error?.type === "overloaded_error" ? 529 : d.error?.type === "rate_limit_error" ? 429 : 500;
      throw httpError("Anthropic", kind, d.error?.message ?? "stream error");
    }
    if (d.type === "message_start" && d.message?.usage) {
      const u = d.message.usage;
      input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      output = u.output_tokens ?? 0;
    } else if (d.type === "message_delta" && d.usage?.output_tokens !== undefined) {
      output = d.usage.output_tokens;
    }
    if (d.type === "content_block_start" && d.content_block?.type === "tool_use") {
      blocks.set(d.index ?? 0, { id: d.content_block.id ?? "", name: d.content_block.name ?? "", json: "" });
    } else if (d.type === "content_block_delta") {
      if (d.delta?.type === "text_delta" && d.delta.text) {
        text += d.delta.text;
        onText(d.delta.text);
      } else if (d.delta?.type === "input_json_delta") {
        const b = blocks.get(d.index ?? 0);
        if (b) b.json += d.delta.partial_json ?? "";
      }
    }
  }
  const toolCalls: ToolCall[] = [...blocks.values()].map((b) => ({ id: b.id, name: b.name, args: parseArgs(b.json) }));
  return { text: text.trim(), toolCalls, ...(input >= 0 ? { usage: { input, output } } : {}) };
}

function parseArgs(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

interface AnthropicResponse {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
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
