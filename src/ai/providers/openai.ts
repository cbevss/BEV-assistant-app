import { fetch } from "@tauri-apps/plugin-http";
import { sse } from "./stream";
import { native } from "@/lib/native";
import { AiImage, AiProvider, AiResponse, AiUsage, ChatRequest, ProviderError, ToolCall, httpError } from "../types";
import { providerInfo, type ProviderId, type ProviderInfo } from "../catalog";

/**
 * Chat Completions provider with function calling, for OpenAI and every API
 * that speaks the same dialect (Gemini, Grok, Groq, Mistral, DeepSeek,
 * OpenRouter). The key is read from the OS keyring per call and only sent to
 * that provider's own address.
 */
export class OpenAiProvider implements AiProvider {
  readonly id: ProviderId;
  readonly label: string;
  private info: ProviderInfo;
  readonly model: string;

  constructor(model?: string, id: ProviderId = "openai") {
    this.info = providerInfo(id);
    this.id = id;
    this.label = this.info.label;
    this.model = model || this.info.defaultModel;
  }

  async isConfigured(): Promise<boolean> {
    return !!this.info.secret && !!(await native.getSecret(this.info.secret).catch(() => null));
  }

  async chat(req: ChatRequest): Promise<AiResponse> {
    const key = this.info.secret ? await native.getSecret(this.info.secret) : null;
    if (!key) throw new ProviderError(`${this.label} API key not set`, false, "auth");

    const tokenField = this.info.tokenParam ?? "max_tokens";
    const model = req.model || this.model;
    // Providers known to accept stream_options report token use at the end of a stream.
    const streamUsage = req.onText && STREAM_USAGE.has(this.id) ? { stream_options: { include_usage: true } } : {};
    const res = await fetch(`${this.info.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        // OpenRouter shows where requests come from on its dashboard.
        ...(this.id === "openrouter" ? { "HTTP-Referer": "https://github.com/cbevss/BEV-assistant-app", "X-Title": "BEV" } : {}),
      },
      body: JSON.stringify({
        model,
        // OpenAI's newer models only take max_completion_tokens; the others
        // take max_tokens. Temperature only when asked (reasoning models refuse it).
        [tokenField]: req.maxTokens ?? 1024,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        messages: toOpenAiMessages(req),
        ...(req.tools.length
          ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) }
          : {}),
        ...(req.onText ? { stream: true, ...streamUsage } : {}),
      }),
      signal: req.signal,
    }).catch((e: unknown) => {
      if (req.signal?.aborted) throw e;
      throw new ProviderError(`${this.label}: couldn't connect (${String(e)})`, true, "network");
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw httpError(this.label, res.status, txt);
    }

    if (req.onText) {
      const r = await readOpenAiStream(res, req.onText, req.signal, this.label);
      return r.usage ? { ...r, usage: { ...r.usage, model } } : r;
    }

    const data = (await res.json()) as OpenAiResponse;
    const msg = data.choices?.[0]?.message;
    const toolCalls: ToolCall[] =
      msg?.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        args: safeJson(tc.function.arguments),
      })) ?? [];
    const u = data.usage;
    return { text: (msg?.content ?? "").trim(), toolCalls, ...(u ? { usage: { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, model } } : {}) };
  }
}

const STREAM_USAGE = new Set<ProviderId>(["openai", "openrouter", "groq", "deepseek", "xai"]);

/** Neutral history → OpenAI messages; assistant tool calls carry their args. */
export function toOpenAiMessages(req: ChatRequest): unknown[] {
  const out: unknown[] = [{ role: "system", content: req.system }];
  const imagePart = (i: AiImage) => ({
    type: "image_url",
    image_url: { url: `data:${i.mediaType};base64,${i.data}`, detail: "high" },
  });
  // Tool messages can only hold text, so images from tool results follow the
  // whole run of results as one user message (results must stay contiguous).
  let pending: AiImage[] = [];
  const flush = () => {
    if (!pending.length) return;
    out.push({
      role: "user",
      content: [{ type: "text", text: "Image(s) returned by the tool call above:" }, ...pending.map(imagePart)],
    });
    pending = [];
  };
  for (const m of req.messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
      if (m.images?.length) pending.push(...m.images);
      continue;
    }
    flush();
    if (m.role === "user" && m.images?.length) {
      out.push({ role: "user", content: [{ type: "text", text: m.content }, ...m.images.map(imagePart)] });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  flush();
  return out;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

interface OpenAiResponse {
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
}

/** Chat Completions stream: content deltas, and tool calls assembled by index. */
export async function readOpenAiStream(res: Response, onText: (d: string) => void, signal: AbortSignal | undefined, label: string): Promise<AiResponse> {
  let text = "";
  let usage: AiUsage | undefined;
  const calls = new Map<number, { id: string; name: string; args: string }>();
  for await (const ev of sse(res.body, signal)) {
    if (!ev.data || ev.data === "[DONE]") continue;
    let d: {
      choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>;
      error?: { message?: string; code?: number | string };
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    };
    try {
      d = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (d.error) throw httpError(label, Number(d.error.code) || 500, d.error.message ?? "stream error");
    if (d.usage) usage = { input: d.usage.prompt_tokens ?? 0, output: d.usage.completion_tokens ?? 0 };
    const delta = d.choices?.[0]?.delta;
    if (delta?.content) {
      text += delta.content;
      onText(delta.content);
    }
    for (const tc of delta?.tool_calls ?? []) {
      const i = tc.index ?? 0;
      const c = calls.get(i) ?? { id: "", name: "", args: "" };
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
      calls.set(i, c);
    }
  }
  const toolCalls: ToolCall[] = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, args: safeJson(c.args) }));
  return { text: text.trim(), toolCalls, ...(usage ? { usage } : {}) };
}
