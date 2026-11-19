/** Provider-independent chat + tool-calling contract. */

/** A base64 image attached to a message (e.g. a screenshot from look_at_screen). */
export interface AiImage {
  mediaType: "image/jpeg" | "image/png";
  data: string;
}

export interface AiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Images on user or tool messages. Only the newest is kept in history. */
  images?: AiImage[];
  /** Tool result carrying outside content (screen, window titles, web). Never sent to providers. */
  untrusted?: boolean;
  toolCallId?: string;
  toolName?: string;
  /** On assistant messages: the tool calls the model issued in that turn. */
  toolCalls?: ToolCall[];
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  /** Sensitive tools require explicit user approval before execution. */
  sensitive?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AiResponse {
  /** Assistant text, if any. */
  text: string;
  /** Tool calls the model wants executed before continuing. */
  toolCalls: ToolCall[];
}

export interface ChatRequest {
  system: string;
  messages: AiMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
  /** Use this model for this request instead of the provider's default (model routing). */
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
  /**
   * Stream the reply: called with each new piece of text as it's written.
   * The full text and tool calls still come back in the response.
   */
  onText?: (delta: string) => void;
}

export interface AiProvider {
  readonly id: import("./catalog").ProviderId;
  readonly label: string;
  /** Resolve true when credentials/endpoint are configured and reachable. */
  isConfigured(): Promise<boolean>;
  chat(req: ChatRequest): Promise<AiResponse>;
}

/**
 * Why a provider call failed, so BEV knows whether to try a backup AI:
 * network (couldn't connect), auth (bad or missing key), quota (out of
 * credit or rate-limited), unavailable (provider down, model gone), or
 * request (something about this request; another AI may cope).
 */
export type FailureKind = "network" | "auth" | "quota" | "unavailable" | "request";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retriable = false,
    readonly kind: FailureKind = retriable ? "unavailable" : "request"
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Turn an HTTP error from any provider into a classified ProviderError. */
export function httpError(label: string, status: number, body: string): ProviderError {
  const text = body.slice(0, 300);
  const quotaWords = /quota|credit|billing|insufficient|exceeded|rate.?limit|too many requests|usage limit|payment/i;
  let kind: FailureKind;
  if (status === 401 || status === 403) kind = quotaWords.test(text) ? "quota" : "auth";
  else if (status === 402 || status === 429 || quotaWords.test(text)) kind = "quota";
  else if (status === 404 || status === 408 || status >= 500) kind = "unavailable";
  else kind = "request";
  const retriable = status === 429 || status >= 500;
  return new ProviderError(`${label} ${status}: ${text}`, retriable, kind);
}
