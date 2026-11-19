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
    const hasImages = req.messages.some((m) => m.images?.length);
    try {
      return await this.post(req, toOllamaMessages(req, true));
    } catch (e) {
      // Text-only local models reject images: retry once without them.
      if (!hasImages || req.signal?.aborted || !(e instanceof ProviderError) || e.retriable) throw e;
      return await this.post(req, toOllamaMessages(req, false));
    }
  }

  private async post(req: ChatRequest, messages: unknown[]): Promise<AiResponse> {
    const body = {
      model: req.model || this.model,
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
      if (req.signal?.aborted) throw e;
      throw new ProviderError(`Ollama isn't running or can't be reached (${String(e)})`, true, "network");
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      // A model that can't take images answers 4xx/5xx with a message saying so.
      const noVision = /image|vision|multimodal/i.test(txt);
      // A model that isn't pulled answers 404: treat as unavailable so a backup can step in.
      throw new ProviderError(`Ollama ${res.status}: ${txt.slice(0, 200)}`, res.status >= 500 && !noVision, res.status === 404 ? "unavailable" : res.status >= 500 && !noVision ? "unavailable" : "request");
    }

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

/**
 * Neutral history → Ollama messages. Images from tool results follow the run
 * of results as a user message; with `withImages` false they are replaced by a
 * note so the model knows it couldn't see them.
 */
export function toOllamaMessages(req: ChatRequest, withImages: boolean): unknown[] {
  const out: unknown[] = [{ role: "system", content: req.system }];
  let pending: string[] = [];
  const flush = () => {
    if (!pending.length) return;
    out.push(
      withImages
        ? { role: "user", content: "Image(s) returned by the tool call above:", images: pending }
        : { role: "user", content: "(A screenshot was taken, but the current local model can't view images. Tell the user they need a vision model, such as llama3.2-vision or qwen2.5vl, for BEV to see the screen.)" }
    );
    pending = [];
  };
  for (const m of req.messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      out.push({ role: "tool", content: m.content });
      if (m.images?.length) pending.push(...m.images.map((i) => i.data));
      continue;
    }
    flush();
    if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })),
      });
    } else if (m.role === "user" && m.images?.length && withImages) {
      out.push({ role: "user", content: m.content, images: m.images.map((i) => i.data) });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  flush();
  return out;
}

interface OllamaResponse {
  message?: {
    content?: string;
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, unknown> };
    }>;
  };
}
