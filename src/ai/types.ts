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
}

export interface AiProvider {
  readonly id: "anthropic" | "openai" | "ollama";
  readonly label: string;
  /** Resolve true when credentials/endpoint are configured and reachable. */
  isConfigured(): Promise<boolean>;
  chat(req: ChatRequest): Promise<AiResponse>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly retriable = false) {
    super(message);
    this.name = "ProviderError";
  }
}
