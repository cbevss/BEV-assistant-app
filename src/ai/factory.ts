import type { Settings } from "@/state/settings";
import type { AiProvider } from "./types";
import { PROVIDERS, providerInfo, type ProviderId } from "./catalog";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAiProvider } from "./providers/openai";
import { OllamaProvider } from "./providers/ollama";
import { FallbackProvider } from "./fallback";

/** The chosen main and quick-reply models for a provider, defaults filled in. */
export function modelsFor(s: Settings, id: ProviderId): { model: string; fast: string } {
  const info = providerInfo(id);
  const chosen = s.models?.[id];
  return {
    model: chosen?.model?.trim() || info.defaultModel,
    fast: chosen?.fast !== undefined ? chosen.fast.trim() : info.defaultFast,
  };
}

/** One provider, configured from settings (the main AI unless `override`). */
export function makeProvider(s: Settings, override?: ProviderId): AiProvider {
  const id = override ?? s.provider;
  const { model } = modelsFor(s, id);
  switch (providerInfo(id).kind) {
    case "anthropic":
      return new AnthropicProvider(model);
    case "ollama":
      return new OllamaProvider({ host: s.ollamaHost, model });
    default:
      return new OpenAiProvider(model, id);
  }
}

/** Main AI first, then the backups in order (each once). */
export function chainOrder(s: Settings): ProviderId[] {
  const out: ProviderId[] = [s.provider];
  for (const id of s.fallbacks ?? []) if (!out.includes(id) && PROVIDERS.some((p) => p.id === id)) out.push(id);
  return out;
}

/** What BEV thinks with: the main AI, falling back to the backups. */
export function makeAssistantProvider(s: Settings): AiProvider {
  return new FallbackProvider(chainOrder(s).map((id) => ({ provider: makeProvider(s, id), fast: modelsFor(s, id).fast || undefined })));
}

export const providerLabels = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.label])) as Record<ProviderId, string>;

export const secretNameFor = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.secret])) as Record<ProviderId, string | null>;
