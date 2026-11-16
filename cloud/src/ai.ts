/**
 * Minimal Claude / OpenAI client with a tool loop. Kept separate from the
 * desktop app's providers, which depend on Tauri.
 */
import { DEFAULT_MODEL, type Env } from "./env";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type Msg =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
}

export type Chat = (req: { system: string; messages: Msg[]; tools: ToolSpec[]; maxTokens?: number }) => Promise<ChatResult>;

export function chatFor(env: Env, fetcher: typeof fetch = fetch): Chat {
  const provider = env.AI_PROVIDER ?? "anthropic";
  const model = env.AI_MODEL || DEFAULT_MODEL[provider];
  return provider === "openai" ? openai(env.AI_API_KEY, model, fetcher) : anthropic(env.AI_API_KEY, model, fetcher);
}

async function failed(res: Response, who: string): Promise<never> {
  const body = (await res.text().catch(() => "")).slice(0, 300);
  throw new Error(`${who} ${res.status}: ${body}`);
}

function anthropic(key: string, model: string, fetcher: typeof fetch): Chat {
  return async ({ system, messages, tools, maxTokens }) => {
    // Neutral history → Anthropic blocks; consecutive tool results merge into one user turn.
    const out: { role: "user" | "assistant"; content: unknown[] }[] = [];
    const push = (role: "user" | "assistant", block: unknown) => {
      const last = out[out.length - 1];
      if (last && last.role === role) last.content.push(block);
      else out.push({ role, content: [block] });
    };
    for (const m of messages) {
      if (m.role === "tool") push("user", { type: "tool_result", tool_use_id: m.toolCallId, content: m.content });
      else if (m.role === "assistant") {
        if (m.content) push("assistant", { type: "text", text: m.content });
        for (const c of m.toolCalls ?? []) push("assistant", { type: "tool_use", id: c.id, name: c.name, input: c.args });
      } else push("user", { type: "text", text: m.content });
    }
    const res = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens ?? 1024,
        system,
        messages: out,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      }),
    });
    if (!res.ok) await failed(res, "anthropic");
    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
    };
    return {
      text: data.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
      toolCalls: data.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id!, name: b.name!, args: b.input ?? {} })),
    };
  };
}

function openai(key: string, model: string, fetcher: typeof fetch): Chat {
  return async ({ system, messages, tools, maxTokens }) => {
    const out: unknown[] = [{ role: "system", content: system }];
    for (const m of messages) {
      if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
      else if (m.role === "assistant" && m.toolCalls?.length)
        out.push({
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        });
      else out.push({ role: m.role, content: m.content });
    }
    const res = await fetcher("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_completion_tokens: maxTokens ?? 1024,
        messages: out,
        tools: tools.map((t) => ({ type: "function", function: t })),
      }),
    });
    if (!res.ok) await failed(res, "openai");
    const data = (await res.json()) as {
      choices: Array<{
        message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
      }>;
    };
    const msg = data.choices[0]?.message;
    return {
      text: msg?.content ?? "",
      toolCalls: (msg?.tool_calls ?? []).map((c) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(c.function.arguments || "{}");
        } catch {
          /* leave empty */
        }
        return { id: c.id, name: c.function.name, args };
      }),
    };
  };
}

export type ToolRunner = (name: string, args: Record<string, unknown>) => Promise<string>;

/**
 * Ask, run any tools the model calls, feed results back, repeat. Returns the
 * final text. `messages` is extended in place with the whole exchange.
 */
export async function runAgent(
  chat: Chat,
  system: string,
  messages: Msg[],
  tools: ToolSpec[],
  run: ToolRunner,
  maxSteps = 6
): Promise<string> {
  for (let step = 0; step < maxSteps; step++) {
    const r = await chat({ system, messages, tools });
    messages.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls.length ? r.toolCalls : undefined });
    if (!r.toolCalls.length) return r.text.trim();
    for (const c of r.toolCalls) {
      let result: string;
      try {
        result = await run(c.name, c.args);
      } catch (e) {
        result = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
      messages.push({ role: "tool", toolCallId: c.id, name: c.name, content: result });
    }
  }
  return "I got stuck partway through that. Try asking again in a simpler way.";
}
