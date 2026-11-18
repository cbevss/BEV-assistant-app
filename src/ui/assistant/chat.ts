/**
 * The typed conversation. One orchestrator for the app's lifetime so context
 * survives moving between pages; it shares tools and memory with voice.
 */
import { useAssistant } from "@/state/assistant";
import { useSettings } from "@/state/settings";
import { Orchestrator } from "@/ai/orchestrator";
import { makeProvider } from "@/ai/factory";

let chatOrch: Orchestrator | null = null;
let abort: AbortController | null = null;

function orchestrator(): Orchestrator {
  const s = useSettings.getState().settings;
  if (!chatOrch) {
    chatOrch = new Orchestrator(makeProvider(s), {
      onState: (st) => useAssistant.getState().setState(st),
      onAssistantText: () => {},
      onToolResult: (name, ok, result) => useAssistant.getState().pushMessage({ role: "tool", content: result, toolName: name, ok }),
      requestApproval: (_c, description) => useAssistant.getState().requestApproval?.(description) ?? Promise.resolve(false),
      onPlan: (plan) => useAssistant.getState().setPlan(plan),
    });
  } else {
    chatOrch.setProvider(makeProvider(s));
  }
  return chatOrch;
}

export async function sendChat(text: string): Promise<void> {
  const t = text.trim();
  if (!t) return;
  const a = useAssistant.getState();
  a.pushMessage({ role: "user", content: t });
  abort = new AbortController();
  try {
    const reply = await orchestrator().send(t, abort.signal);
    if (reply) a.pushMessage({ role: "assistant", content: reply });
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    a.pushMessage({ role: "assistant", content: aborted ? "Stopped." : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`, ok: aborted ? undefined : false });
  } finally {
    abort = null;
    useAssistant.getState().setState("idle");
  }
}

export function stopChat() {
  abort?.abort();
}

export function newConversation() {
  stopChat();
  chatOrch?.reset();
  useAssistant.getState().clearMessages();
  useAssistant.getState().setPlan(null);
}
