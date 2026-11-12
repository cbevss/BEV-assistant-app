/** Provider-independent chat + tool-calling contract. */

export interface AiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
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
