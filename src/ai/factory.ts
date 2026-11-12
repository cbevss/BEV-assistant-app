import type { Settings, ProviderId } from "@/state/settings";
import type { AiProvider } from "./types";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAiProvider } from "./providers/openai";
import { OllamaProvider } from "./providers/ollama";

/** Single place that turns settings into a configured provider instance. */
export function makeProvider(s: Settings, override?: ProviderId): AiProvider {
  switch (override ?? s.provider) {
    case "openai":
      return new OpenAiProvider(s.openaiModel);
    case "ollama":
      return new OllamaProvider({ host: s.ollamaHost, model: s.ollamaModel });
    case "anthropic":
    default:
      return new AnthropicProvider(s.anthropicModel);
  }
}

export const providerLabels: Record<ProviderId, string> = {
  anthropic: "Anthropic Claude",
  openai: "OpenAI",
  ollama: "Ollama (local)",
};

export const secretNameFor: Record<ProviderId, string | null> = {
  anthropic: "anthropic_api_key",
  openai: "openai_api_key",
  ollama: null,
};
