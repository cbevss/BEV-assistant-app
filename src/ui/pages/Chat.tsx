import { useEffect, useRef, useState } from "react";
import { useAssistant } from "@/state/assistant";
import { useSettings, ProviderId } from "@/state/settings";
import { Orchestrator } from "@/ai/orchestrator";
import { makeProvider, providerLabels } from "@/ai/factory";
import { Select, Button } from "../components/Form";

/**
 * One chat orchestrator for the app's lifetime, so conversation context
 * survives navigating between pages. Uses the same tools/memory as voice.
 */
let chatOrch: Orchestrator | null = null;
function getChatOrchestrator(): Orchestrator {
  const s = useSettings.getState().settings;
  if (!chatOrch) {
    chatOrch = new Orchestrator(makeProvider(s), {
      onState: (st) => useAssistant.getState().setState(st),
      onAssistantText: () => {},
      onToolResult: (name, ok, result) =>
        useAssistant.getState().pushMessage({ role: "tool", content: result, toolName: name, ok }),
      requestApproval: (_c, description) =>
        useAssistant.getState().requestApproval?.(description) ?? Promise.resolve(false),
    });
  } else {
    chatOrch.setProvider(makeProvider(s));
  }
  return chatOrch;
}

export function Chat() {
  const { messages, pushMessage, clearMessages, state, setState } = useAssistant();
  const { settings, update } = useSettings();
  const [input, setInput] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const busy = state === "thinking" || state === "executing";

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    pushMessage({ role: "user", content: text });
    abortRef.current = new AbortController();
    try {
      const reply = await getChatOrchestrator().send(text, abortRef.current.signal);
      if (reply) pushMessage({ role: "assistant", content: reply });
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      pushMessage({
        role: "assistant",
        content: aborted ? "Stopped." : `⚠ ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setState("idle");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-glow">AI Chat</h1>
        <div className="flex items-center gap-2">
          <div className="w-48">
            <Select<ProviderId>
              ariaLabel="AI provider"
              value={settings.provider}
              onChange={(provider) => update({ provider })}
              options={(Object.keys(providerLabels) as ProviderId[]).map((p) => ({ value: p, label: providerLabels[p] }))}
            />
          </div>
          <Button
            variant="ghost"
            disabled={busy || messages.length === 0}
            onClick={() => {
              chatOrch?.reset();
              clearMessages();
            }}
          >
            Clear
          </Button>
        </div>
      </header>

      <div className="glass flex-1 space-y-3 overflow-y-auto rounded-xl p-4" aria-live="polite">
        {messages.length === 0 && (
          <p className="text-sm text-slate-500">
            Ask BEV anything, or give it a command like “set my volume to 30%” or “what's using my RAM?”.
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`max-w-[80%] whitespace-pre-wrap rounded-xl px-4 py-2 text-sm ${
              m.role === "user"
                ? "ml-auto bg-bev-blue/20 text-slate-100"
                : m.role === "tool"
                  ? `font-mono text-xs ${m.ok ? "bg-white/5 text-slate-400" : "bg-bev-danger/10 text-bev-danger"}`
                  : "bg-bev-cyan/10 text-slate-100"
            }`}
          >
            {m.role === "tool" ? `${m.ok ? "✓" : "✕"} ${m.toolName}: ${truncate(m.content, 400)}` : m.content}
          </div>
        ))}
        {busy && <div className="text-xs text-bev-violet">{state === "executing" ? "Working on it…" : "Thinking…"}</div>}
        <div ref={endRef} />
      </div>

      <div className="mt-4 flex gap-2">
        <input
          className="no-drag flex-1 rounded-xl bg-white/5 px-4 py-3 text-sm outline-none focus:ring-1 focus:ring-bev-cyan"
          placeholder="Message BEV…"
          aria-label="Message BEV"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        {busy ? (
          <Button variant="danger" onClick={() => abortRef.current?.abort()}>
            Stop
          </Button>
        ) : (
          <Button onClick={send} disabled={!input.trim()}>
            Send
          </Button>
        )}
      </div>
    </div>
  );
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
