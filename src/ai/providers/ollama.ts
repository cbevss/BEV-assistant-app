import { fetch } from "@tauri-apps/plugin-http";
import {
  AiProvider,
  AiResponse,
  ChatRequest,
  ProviderError,
  ToolCall,
} from "../types";

/**
 * Local Ollama provider — fully offline once a model is pulled. Uses the
 * /api/chat endpoint with tool support (Llama 3.1+, Qwen2.5, etc.).
 */
export class OllamaProvider implements AiProvider {
  readonly id = "ollama" as const;
  readonly label = "Ollama (local)";
  private host = "http://localhost:11434";
  private model = "llama3.1";

  constructor(opts?: { host?: string; model?: string }) {
    if (opts?.host) this.host = opts.host.replace(/\/$/, "");
    if (opts?.model) this.model = opts.model;
  }

  async isConfigured(): Promise<boolean> {
    try {
      const res = await fetch(`${this.host}/api/tags`, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  async chat(req: ChatRequest): Promise<AiResponse> {
    const messages = [
      { role: "system", content: req.system },
      ...req.messages
        .filter((m) => m.role !== "system")
        .map((m) =>
          m.role === "assistant" && m.toolCalls?.length
            ? {
                role: "assistant",
                content: m.content,
                tool_calls: m.toolCalls.map((c) => ({
                  function: { name: c.name, arguments: c.args },
                })),
              }
            : { role: m.role, content: m.content }
        ),
    ];
    const body = {
      model: this.model,
      stream: false,
      messages,
      tools: req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      options: { temperature: req.temperature ?? 0.4 },
    };

    const res = await fetch(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: req.signal,
    }).catch((e: unknown) => {
      throw new ProviderError(`ollama unreachable: ${String(e)}`, true);
    });
    if (!res.ok) throw new ProviderError(`ollama ${res.status}`, res.status >= 500);

    const data = (await res.json()) as OllamaResponse;
    const toolCalls: ToolCall[] =
      data.message?.tool_calls?.map((tc, i) => ({
        id: `ollama-${i}`,
        name: tc.function.name,
        args: tc.function.arguments ?? {},
      })) ?? [];
    return { text: (data.message?.content ?? "").trim(), toolCalls };
  }
}

interface OllamaResponse {
  message?: {
    content?: string;
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, unknown> };
    }>;
  };
}
