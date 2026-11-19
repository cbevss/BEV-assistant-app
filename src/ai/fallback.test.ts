import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@/lib/native", () => ({ native: { getSecret: vi.fn(async () => "k") } }));

import { FallbackProvider, shouldFallBack, useAiStatus } from "./fallback";
import { ProviderError, httpError, type AiProvider, type ChatRequest } from "./types";
import { chainOrder, modelsFor } from "./factory";
import { filterModels } from "./models";
import { PROVIDERS } from "./catalog";
import { defaultSettings, migrateAi, type Settings } from "@/state/settings";
import type { ProviderId } from "./catalog";

const req = (model?: string): ChatRequest => ({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [], model });

function fake(id: ProviderId, behave: (model?: string) => string | Error, configured = true) {
  const calls: Array<string | undefined> = [];
  const p: AiProvider = {
    id,
    label: id,
    isConfigured: async () => configured,
    chat: async (r) => {
      calls.push(r.model);
      const out = behave(r.model);
      if (out instanceof Error) throw out;
      return { text: out, toolCalls: [] };
    },
  };
  return { p, calls };
}

describe("why a provider failed", () => {
  it("classifies HTTP errors so BEV knows when to try a backup", () => {
    expect(httpError("X", 401, "invalid key").kind).toBe("auth");
    expect(httpError("X", 429, "slow down").kind).toBe("quota");
    expect(httpError("X", 402, "").kind).toBe("quota");
    expect(httpError("X", 400, "Your credit balance is too low").kind).toBe("quota");
    expect(httpError("X", 403, "You exceeded your current quota").kind).toBe("quota");
    expect(httpError("X", 404, "model not found").kind).toBe("unavailable");
    expect(httpError("X", 529, "overloaded").kind).toBe("unavailable");
    expect(httpError("X", 400, "messages: invalid").kind).toBe("request");
    expect(shouldFallBack(httpError("X", 400, "bad"))).toBe(false);
    expect(shouldFallBack(new ProviderError("down", true, "network"))).toBe(true);
    expect(shouldFallBack(new Error("other"))).toBe(false);
  });
});

describe("main AI with backups", () => {
  it("uses the main AI when it works", async () => {
    const main = fake("anthropic", () => "from main");
    const backup = fake("openai", () => "from backup");
    const r = await new FallbackProvider([{ provider: main.p }, { provider: backup.p }]).chat(req());
    expect(r.text).toBe("from main");
    expect(backup.calls).toEqual([]);
    expect(useAiStatus.getState().answeredBy).toBe("anthropic");
  });

  it("moves to the next AI when the main one is out of credit, offline or down", async () => {
    for (const err of [httpError("A", 429, "rate limit"), new ProviderError("offline", true, "network"), httpError("A", 401, "bad key"), httpError("A", 503, "down")]) {
      const main = fake("anthropic", () => err);
      const backup = fake("openai", () => "from backup");
      const r = await new FallbackProvider([{ provider: main.p }, { provider: backup.p }]).chat(req());
      expect(r.text).toBe("from backup");
    }
    expect(useAiStatus.getState().backupReason).toMatch(/Anthropic/);
  });

  it("skips backups that aren't set up, and stops on a problem with the request itself", async () => {
    const main = fake("anthropic", () => httpError("A", 429, "rate"));
    const noKey = fake("gemini", () => "never", false);
    const third = fake("openai", () => "third");
    expect((await new FallbackProvider([{ provider: main.p }, { provider: noKey.p }, { provider: third.p }]).chat(req())).text).toBe("third");
    expect(noKey.calls).toEqual([]);

    const bad = fake("anthropic", () => httpError("A", 400, "invalid request"));
    const unused = fake("openai", () => "x");
    await expect(new FallbackProvider([{ provider: bad.p }, { provider: unused.p }]).chat(req())).rejects.toThrow(/invalid request/);
    expect(unused.calls).toEqual([]);
  });

  it("gives backups their own quick-reply model, and tries a provider's main model if its fast one is wrong", async () => {
    const main = fake("anthropic", (m) => (m === "haiku-x" ? httpError("A", 404, "no such model") : httpError("A", 429, "rate")));
    const backup = fake("openai", () => "ok");
    await new FallbackProvider([{ provider: main.p, fast: "haiku-x" }, { provider: backup.p, fast: "gpt-fast" }]).chat(req("haiku-x"));
    expect(main.calls).toEqual(["haiku-x", undefined]); // fast failed → main model → rate-limited
    expect(backup.calls).toEqual(["gpt-fast"]);
  });

  it("reports the main AI's error when every AI fails", async () => {
    const a = fake("anthropic", () => httpError("Anthropic", 429, "rate limit"));
    const b = fake("openai", () => new ProviderError("OpenAI offline", true, "network"));
    await expect(new FallbackProvider([{ provider: a.p }, { provider: b.p }]).chat(req())).rejects.toThrow(/Anthropic 429/);
  });
});

describe("settings", () => {
  it("carries model choices from before 1.6 into the new layout", () => {
    const saved = { provider: "openai", openaiModel: "gpt-4.1-mini", openaiFastModel: "gpt-4.1-nano", anthropicModel: "claude-x" };
    const s = migrateAi({ ...defaultSettings, ...(saved as Partial<Settings>) }, saved);
    expect(s.models.openai).toEqual({ model: "gpt-4.1-mini", fast: "gpt-4.1-nano" });
    expect(s.models.anthropic).toEqual({ model: "claude-x", fast: "" });
    expect("openaiModel" in s).toBe(false);
    // Already migrated: left alone.
    expect(migrateAi(s, { models: {} })).toBe(s);
  });

  it("fills in defaults and builds the backup order without repeats", () => {
    const s = { ...defaultSettings, provider: "gemini" as const, fallbacks: ["anthropic", "gemini", "anthropic", "openai"] as ProviderId[] };
    expect(chainOrder(s)).toEqual(["gemini", "anthropic", "openai"]);
    expect(modelsFor(s, "gemini").model).toBe(PROVIDERS.find((p) => p.id === "gemini")!.defaultModel);
    expect(modelsFor({ ...s, models: { gemini: { model: "gemini-x", fast: "" } } }, "gemini")).toEqual({ model: "gemini-x", fast: "" });
  });

  it("every provider has a key name (except local Ollama) and a default model", () => {
    for (const p of PROVIDERS) {
      expect(p.defaultModel).toBeTruthy();
      expect(p.kind === "ollama" ? p.secret : p.secret).toEqual(p.kind === "ollama" ? null : expect.stringMatching(/_api_key$/));
      if (p.kind === "openai-compatible") expect(p.baseUrl).toMatch(/^https:\/\//);
    }
  });
});

describe("model lists", () => {
  it("keeps chat models and drops images, speech and embeddings", () => {
    const openai = filterModels("openai", {
      data: [
        { id: "gpt-5.6-sol", created: 300 },
        { id: "gpt-image-2", created: 400 },
        { id: "text-embedding-3-large", created: 100 },
        { id: "gpt-realtime-2.1-mini", created: 350 },
        { id: "whisper-1", created: 50 },
        { id: "gpt-5.6-luna", created: 200 },
      ],
    });
    expect(openai.map((m) => m.id)).toEqual(["gpt-5.6-sol", "gpt-5.6-luna"]);

    const gemini = filterModels("gemini", { data: [{ id: "models/gemini-3.5-flash" }, { id: "models/text-embedding-004" }, { id: "models/imagen-4.0" }] });
    expect(gemini.map((m) => m.id)).toEqual(["gemini-3.5-flash"]);
  });

  it("uses what providers say about tool support", () => {
    const or = filterModels("openrouter", {
      data: [
        { id: "a/tools", name: "Has tools", supported_parameters: ["tools", "temperature"], created: 2 },
        { id: "b/no-tools", supported_parameters: ["temperature"], created: 3 },
      ],
    });
    expect(or).toEqual([{ id: "a/tools", name: "Has tools" }]);
    const mistral = filterModels("mistral", { data: [{ id: "mistral-large-latest", capabilities: { completion_chat: true, function_calling: true } }, { id: "codestral-embed", capabilities: { completion_chat: false } }] });
    expect(mistral.map((m) => m.id)).toEqual(["mistral-large-latest"]);
  });

  it("reads Ollama's and Anthropic's formats", () => {
    expect(filterModels("ollama", { models: [{ name: "llama3.1:latest", modified_at: "2026-01-01" }, { name: "qwen3:8b", modified_at: "2026-06-01" }] }).map((m) => m.id)).toEqual(["qwen3:8b", "llama3.1:latest"]);
    expect(filterModels("anthropic", { data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", created_at: "2026-05-01T00:00:00Z" }] })).toEqual([{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }]);
  });
});
