/**
 * Live model lists for the AI & models dropdowns. Each provider's own
 * "list models" endpoint, filtered to chat models that can use tools; cached
 * for the session.
 */
import { fetch } from "@tauri-apps/plugin-http";
import { native } from "@/lib/native";
import { providerInfo, type ProviderId } from "./catalog";

export interface ModelOption {
  id: string;
  /** Friendlier name where the provider gives one. */
  name?: string;
}

/** Models that aren't for chatting (images, speech, embeddings, moderation…). */
const NOT_CHAT = /(embed|embedding|whisper|tts|transcri|audio|realtime|speech|image|imagen|dall-e|sora|veo|video|moderation|guard|ocr|rerank|search-preview|computer-use|aqa|live|native-audio|instruct$|babbage|davinci)/i;

/** Pure: keep the chat models from a provider's raw list, newest first where known. */
export function filterModels(id: ProviderId, raw: unknown): ModelOption[] {
  const list: Array<Record<string, unknown>> = Array.isArray(raw)
    ? (raw as Array<Record<string, unknown>>)
    : Array.isArray((raw as { data?: unknown })?.data)
      ? ((raw as { data: Array<Record<string, unknown>> }).data)
      : Array.isArray((raw as { models?: unknown })?.models)
        ? ((raw as { models: Array<Record<string, unknown>> }).models)
        : [];

  const out: Array<ModelOption & { created: number }> = [];
  for (const m of list) {
    let id0 = String(m.id ?? m.name ?? m.model ?? "");
    if (!id0) continue;
    if (id === "gemini") id0 = id0.replace(/^models\//, "");
    if (id === "ollama") {
      out.push({ id: id0, created: Date.parse(String(m.modified_at ?? "")) || 0 });
      continue;
    }
    if (id === "openrouter") {
      // OpenRouter says what each model supports: BEV needs tool calling.
      const params = m.supported_parameters as string[] | undefined;
      if (Array.isArray(params) && !params.includes("tools")) continue;
      out.push({ id: id0, name: typeof m.name === "string" ? m.name : undefined, created: Number(m.created) || 0 });
      continue;
    }
    if (id === "mistral") {
      const caps = m.capabilities as { completion_chat?: boolean; function_calling?: boolean } | undefined;
      if (caps && (caps.completion_chat === false || caps.function_calling === false)) continue;
    }
    if (NOT_CHAT.test(id0)) continue;
    if (id === "openai" && !/^(gpt-|o\d|chatgpt|chat-latest)/i.test(id0)) continue;
    if (id === "gemini" && !/gemini|gemma/i.test(id0)) continue;
    if (id === "anthropic" && !/^claude/i.test(id0)) continue;
    const name = typeof m.display_name === "string" ? m.display_name : typeof m.displayName === "string" ? m.displayName : undefined;
    const created = Number(m.created) || Date.parse(String(m.created_at ?? "")) / 1000 || 0;
    out.push({ id: id0, name, created });
  }
  // Newest first when the provider tells us; otherwise keep its order.
  const dated = out.some((m) => m.created > 0);
  const seen = new Set<string>();
  return (dated ? [...out].sort((a, b) => b.created - a.created) : out)
    .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    .map(({ id: mid, name }) => ({ id: mid, ...(name && name !== mid ? { name } : {}) }));
}

const cache = new Map<string, { at: number; models: ModelOption[] }>();
const TTL = 30 * 60_000;

/** Every chat model this provider offers to this user. Throws with a readable reason. */
export async function listModels(id: ProviderId, opts: { ollamaHost?: string; refresh?: boolean } = {}): Promise<ModelOption[]> {
  const key = `${id}|${opts.ollamaHost ?? ""}`;
  const hit = cache.get(key);
  if (hit && !opts.refresh && Date.now() - hit.at < TTL) return hit.models;

  const info = providerInfo(id);
  let res: Response;
  try {
    if (info.kind === "ollama") {
      res = await fetch(`${(opts.ollamaHost || "http://localhost:11434").replace(/\/+$/, "")}/api/tags`);
    } else {
      const secret = info.secret ? await native.getSecret(info.secret).catch(() => null) : null;
      // OpenRouter's list is public; everyone else needs the key.
      if (!secret && id !== "openrouter") throw new Error("Add your API key to see every model.");
      if (info.kind === "anthropic") {
        res = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
          headers: { "x-api-key": secret ?? "", "anthropic-version": "2023-06-01" },
        });
      } else {
        res = await fetch(`${info.baseUrl}/models`, { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Add your")) throw e;
    throw new Error(info.kind === "ollama" ? "Ollama isn't running on this PC." : `Couldn't reach ${info.label}.`);
  }
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? "That API key wasn't accepted." : `${info.label} answered ${res.status}.`);
  const models = filterModels(id, await res.json());
  cache.set(key, { at: Date.now(), models });
  return models;
}
