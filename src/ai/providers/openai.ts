import { fetch } from "@tauri-apps/plugin-http";
import { native } from "@/lib/native";
import { AiProvider, AiResponse, ChatRequest, ProviderError, ToolCall } from "../types";

/**
 * OpenAI Chat Completions provider with function calling. Key is read from the
 * OS keyring (`openai_api_key`) per call and only sent to api.openai.com.
 */
export class OpenAiProvider implements AiProvider {
  readonly id = "openai" as const;
  readonly label = "OpenAI";
  private model = "gpt-4.1-mini";

  constructor(model?: string) {
    if (model) this.model = model;
  }

  async isConfigured(): Promise<boolean> {
    return !!(await native.getSecret("openai_api_key").catch(() => null));
  }

  async chat(req: ChatRequest): Promise<AiResponse> {
    const key = await native.getSecret("openai_api_key");
    if (!key) throw new ProviderError("OpenAI API key not set");

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: this.model,
        temperature: req.temperature ?? 0.4,
        max_tokens: req.maxTokens ?? 1024,
        messages: toOpenAiMessages(req),
        tools: req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      }),
      signal: req.signal,
    }).catch((e: unknown) => {
      throw new ProviderError(`network: ${String(e)}`, true);
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new ProviderError(`openai ${res.status}: ${txt}`, res.status >= 500 || res.status === 429);
    }

    const data = (await res.json()) as OpenAiResponse;
    const msg = data.choices?.[0]?.message;
    const toolCalls: ToolCall[] =
      msg?.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        args: safeJson(tc.function.arguments),
      })) ?? [];
    return { text: (msg?.content ?? "").trim(), toolCalls };
  }
}

/** Neutral history → OpenAI messages; assistant tool calls carry their args. */
export function toOpenAiMessages(req: ChatRequest): unknown[] {
  const out: unknown[] = [{ role: "system", content: req.system }];
  for (const m of req.messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
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
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
}
