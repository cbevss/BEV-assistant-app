/**
 * Every AI BEV can think with. Most speak OpenAI's chat-completions dialect,
 * so one provider class covers them; Anthropic and Ollama have their own.
 *
 * Defaults are only used until the provider's live model list loads.
 */

export type ProviderId = "anthropic" | "openai" | "gemini" | "xai" | "groq" | "mistral" | "deepseek" | "openrouter" | "ollama";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** One line under the name in settings. */
  blurb: string;
  kind: "anthropic" | "openai-compatible" | "ollama";
  /** API base for OpenAI-compatible providers (…/chat/completions, …/models). */
  baseUrl?: string;
  /** Credential Manager name of the API key; null = no key (local). */
  secret: string | null;
  /** Where to get a key. */
  keyUrl?: string;
  defaultModel: string;
  /** "" = use the main model for quick replies too. */
  defaultFast: string;
  /** Name of the max-tokens field this API accepts. */
  tokenParam?: "max_completion_tokens" | "max_tokens";
  /** Shown before a key is saved, so the dropdown isn't empty. */
  suggested: string[];
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    label: "Anthropic Claude",
    blurb: "Claude models. Strong at tools and long tasks.",
    kind: "anthropic",
    secret: "anthropic_api_key",
    keyUrl: "https://console.anthropic.com/settings/keys",
    defaultModel: "claude-sonnet-5-5",
    defaultFast: "claude-haiku-5-5",
    suggested: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  },
  {
    id: "openai",
    label: "OpenAI",
    blurb: "GPT models.",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    secret: "openai_api_key",
    keyUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-5.6-sol",
    defaultFast: "gpt-5.6-luna",
    tokenParam: "max_completion_tokens",
    suggested: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    blurb: "Gemini models, with a free tier.",
    kind: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    secret: "gemini_api_key",
    keyUrl: "https://aistudio.google.com/apikey",
    defaultModel: "gemini-3.5-flash",
    defaultFast: "gemini-3.1-flash-lite",
    tokenParam: "max_tokens",
    suggested: ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite"],
  },
  {
    id: "xai",
    label: "xAI Grok",
    blurb: "Grok models.",
    kind: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    secret: "xai_api_key",
    keyUrl: "https://console.x.ai",
    defaultModel: "grok-4.7",
    defaultFast: "",
    tokenParam: "max_tokens",
    suggested: ["grok-4.7", "grok-latest"],
  },
  {
    id: "groq",
    label: "Groq",
    blurb: "Open models on very fast hardware.",
    kind: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    secret: "groq_api_key",
    keyUrl: "https://console.groq.com/keys",
    defaultModel: "llama-3.3-70b-versatile",
    defaultFast: "",
    tokenParam: "max_tokens",
    suggested: ["llama-3.3-70b-versatile"],
  },
  {
    id: "mistral",
    label: "Mistral",
    blurb: "Mistral's models, hosted in Europe.",
    kind: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    secret: "mistral_api_key",
    keyUrl: "https://console.mistral.ai/api-keys",
    defaultModel: "mistral-large-latest",
    defaultFast: "mistral-small-latest",
    tokenParam: "max_tokens",
    suggested: ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest"],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    blurb: "Low-cost models.",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    secret: "deepseek_api_key",
    keyUrl: "https://platform.deepseek.com/api_keys",
    defaultModel: "deepseek-chat",
    defaultFast: "",
    tokenParam: "max_tokens",
    suggested: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    blurb: "One key for hundreds of models from every company.",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    secret: "openrouter_api_key",
    keyUrl: "https://openrouter.ai/settings/keys",
    defaultModel: "openrouter/auto",
    defaultFast: "",
    tokenParam: "max_tokens",
    suggested: ["openrouter/auto"],
  },
  {
    id: "ollama",
    label: "Ollama (on this PC)",
    blurb: "Runs models on your own PC, offline. No key needed.",
    kind: "ollama",
    secret: null,
    defaultModel: "llama3.1",
    defaultFast: "",
    suggested: ["llama3.1"],
  },
];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

export const providerInfo = (id: ProviderId): ProviderInfo => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];

export const isProviderId = (v: unknown): v is ProviderId => typeof v === "string" && (PROVIDER_IDS as string[]).includes(v);
