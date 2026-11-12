import { native } from "@/lib/native";
import { useSettings, toolAllowed } from "@/state/settings";
import { AiMessage, AiProvider, ProviderError, ToolCall } from "./types";
import { tools, toolSpecs, isSensitive } from "./tools";
import { buildSystemPrompt } from "./persona";

export interface OrchestratorHooks {
  onState: (s: "thinking" | "executing" | "speaking" | "completed" | "error") => void;
  onAssistantText: (text: string) => void;
  onToolResult: (name: string, ok: boolean, result: string) => void;
  /** Return true to allow a sensitive tool call. */
  requestApproval: (call: ToolCall, description: string) => Promise<boolean>;
}

/** Builds the system prompt from current settings + approved memories. */
async function currentSystemPrompt(): Promise<string> {
  const s = useSettings.getState().settings;
  const memories = await native.memoryList().catch(() => []);
  return buildSystemPrompt(s, memories);
}

/** Drop history beyond this many messages to bound token use / latency. */
const MAX_HISTORY = 30;

/**
 * Runs the conversation loop: model → tool calls → results → model, until the
 * model stops requesting tools or the step budget is exhausted. Honours an
 * AbortSignal so the user can interrupt ("BEV, stop").
 */
export class Orchestrator {
  private history: AiMessage[] = [];
  private readonly maxSteps = 6;

  constructor(private provider: AiProvider, private hooks: OrchestratorHooks) {}

  reset() {
    this.history = [];
  }

  getHistory(): readonly AiMessage[] {
    return this.history;
  }

  setProvider(p: AiProvider) {
    this.provider = p;
  }

  async send(userText: string, signal?: AbortSignal): Promise<string> {
    this.history.push({ role: "user", content: userText });
    this.trimHistory();
    let finalText = "";
    const system = await currentSystemPrompt();
    // Only advertise tools the user hasn't revoked.
    const specs = toolSpecs().filter((t) => toolAllowed(t.name));

    for (let step = 0; step < this.maxSteps; step++) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      this.hooks.onState("thinking");

      const res = await this.chatWithRetry(system, specs, signal);

      if (res.text || res.toolCalls.length) {
        // One assistant message carrying both text and tool calls, so providers
        // can pair each tool result with the call that produced it.
        this.history.push({
          role: "assistant",
          content: res.text,
          toolCalls: res.toolCalls.length ? res.toolCalls : undefined,
        });
      }
      if (res.text) {
        finalText = res.text;
        this.hooks.onAssistantText(res.text);
      }

      if (res.toolCalls.length === 0) break;

      this.hooks.onState("executing");
      for (const call of res.toolCalls) {
        const result = await this.runTool(call, signal);
        this.history.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: result.text,
        });
        this.hooks.onToolResult(call.name, result.ok, result.text);
        native.logAction(call.name, JSON.stringify(call.args), result.text, result.ok).catch(() => {});
      }
    }

    this.hooks.onState("completed");
    return finalText;
  }

  /** One retry with backoff on transient (network / 5xx) provider failures. */
  private async chatWithRetry(system: string, specs: ReturnType<typeof toolSpecs>, signal?: AbortSignal) {
    const req = { system, messages: this.history, tools: specs, signal };
    try {
      return await this.provider.chat(req);
    } catch (e) {
      const retriable = e instanceof ProviderError && e.retriable;
      if (!retriable || signal?.aborted) throw e;
      await new Promise((r) => setTimeout(r, 1200));
      return await this.provider.chat(req);
    }
  }

  /** Keep the most recent turns; never start history on an orphaned tool result. */
  private trimHistory() {
    if (this.history.length <= MAX_HISTORY) return;
    let cut = this.history.length - MAX_HISTORY;
    while (cut < this.history.length && this.history[cut].role !== "user") cut++;
    this.history = this.history.slice(cut);
  }

  private async runTool(
    call: ToolCall,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; text: string }> {
    const tool = tools[call.name];
    if (!tool) return { ok: false, text: `unknown tool: ${call.name}` };
    if (!toolAllowed(call.name)) {
      return { ok: false, text: `permission for ${call.name} is revoked in Security settings` };
    }

    if (isSensitive(call.name)) {
      const desc = describeCall(call);
      const approved = await this.hooks.requestApproval(call, desc);
      if (!approved) return { ok: false, text: "user declined this action" };
    }

    try {
      const text = await withTimeout(tool.run(call.args), 15_000, signal);
      return { ok: true, text };
    } catch (e) {
      return { ok: false, text: `error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

function describeCall(call: ToolCall): string {
  switch (call.name) {
    case "close_app":
      return `BEV wants to close ${String(call.args.name ?? "an application")}.`;
    case "power_action": {
      const a = String(call.args.action ?? "");
      if (a === "cancel") return "BEV wants to cancel the pending restart/shutdown.";
      if (a === "sleep") return "BEV wants to put the PC to sleep.";
      const d = call.args.delay_seconds ?? 15;
      return `BEV wants to ${a} the PC in ${String(d)} seconds. Save your work first.`;
    }
    default:
      return `BEV wants to run ${call.name} with ${JSON.stringify(call.args)}.`;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
