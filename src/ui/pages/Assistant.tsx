/**
 * The assistant: BEV's live state, the conversation (typed and spoken), what
 * BEV is doing right now, and the composer.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { prettyAccelerator } from "@/lib/hotkeys";
import { ArrowUp, Check, ChevronRight, Mic, MicOff, Plus, Square, X } from "lucide-react";
import { useAssistant, type ChatMessage } from "@/state/assistant";
import { useSettings, type ProviderId } from "@/state/settings";
import { providerLabels } from "@/ai/factory";
import { progress as planProgress } from "@/ai/plan";
import { getController } from "@/voice/bootstrap";
import { stateMeta } from "../design";
import { Core } from "../components/Core";
import { HudFrame, HudLabel, Readout } from "../components/Hud";
import { PlanView } from "../components/PlanView";
import { IconButton, Kbd, Select } from "../components/Form";
import { Markdown } from "../assistant/Markdown";
import { toolIcon, toolLabel, summary } from "../assistant/tools";
import { sendChat, stopChat, newConversation } from "../assistant/chat";

const SUGGESTIONS = [
  "What's slowing my PC down?",
  "Open Spotify and play my liked songs",
  "In the background, compare the three cheapest 1440p monitors and save a note",
  "Remind me to renew the car insurance on Friday",
];

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Working late." : h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
}

export function useMicLabel(): string {
  const deviceId = useSettings((s) => s.settings.micDeviceId);
  const [label, setLabel] = useState("");
  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) => {
        const mics = all.filter((d) => d.kind === "audioinput");
        const d = mics.find((m) => m.deviceId === deviceId) ?? mics.find((m) => m.deviceId === "default") ?? mics[0];
        setLabel((d?.label ?? "").replace(/^(Default|Communications) - /, "").replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, ""));
      })
      .catch(() => {});
  }, [deviceId]);
  return label;
}

function useElapsed(active: boolean) {
  const [start, setStart] = useState<number | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return setStart(null);
    setStart(Date.now());
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  return start ? Math.floor((Date.now() - start) / 1000) : 0;
}

// ---------------------------------------------------------------------------

export function Assistant() {
  const { messages, state, statusText, micEnabled, privacyMode, plan, audioLevel } = useAssistant();
  const busy = state === "thinking" || state === "executing";
  const p = plan && plan.length ? planProgress(plan) : null;
  const scroller = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");

  // Keep the newest message in view unless the user has scrolled up to read.
  const stick = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, plan, state]);

  const groups = useMemo(() => groupMessages(messages), [messages]);

  return (
    <div className="flex h-full flex-col">
      <AssistantBar />
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="mx-auto w-full max-w-[760px] px-6 pb-6 pt-6">
          {messages.length === 0 && !busy ? (
            <Welcome onPick={setDraft} level={audioLevel} listening={micEnabled && !privacyMode} />
          ) : (
            <ol className="space-y-5" aria-live="polite" aria-label="Conversation">
              {groups.map((g) =>
                g.kind === "tools" ? (
                  <li key={g.id}>
                    <ToolRun items={g.items} />
                  </li>
                ) : (
                  <li key={g.msg.id}>
                    <Message m={g.msg} />
                  </li>
                )
              )}
              {plan && plan.length > 0 && (busy || (p && p.done < p.total)) && (
                <li className="ml-9">
                  <PlanView plan={plan} compact />
                </li>
              )}
              {busy && (
                <li>
                  <Working text={statusText} />
                </li>
              )}
            </ol>
          )}
        </div>
      </div>
      <Composer draft={draft} setDraft={setDraft} busy={busy} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function AssistantBar() {
  const { state, statusText, micEnabled, privacyMode, audioLevel, plan, messages } = useAssistant();
  const { settings, update } = useSettings();
  const mic = useMicLabel();
  const nav = useNavigate();
  const p = plan && plan.length ? planProgress(plan) : null;
  const off = privacyMode || !micEnabled;
  const coreState = state === "idle" && off ? "off" : state;
  const line = privacyMode
    ? "Privacy mode: the microphone is off"
    : state === "idle"
      ? micEnabled
        ? "Listening for the wake word"
        : "Microphone off"
      : statusText?.trim() || stateMeta[state].label;

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line-subtle px-5">
      <Core state={coreState} level={audioLevel} progress={p && p.total ? p.done / p.total : null} size={30} />
      <div className="min-w-0 flex-1">
        <HudLabel className={clsx(state === "error" ? "text-danger" : state !== "idle" && !off && "text-accent")}>{privacyMode ? "Privacy" : state === "idle" ? (off ? "Offline" : "Standby") : state === "error" ? "Fault" : stateMeta[state].label}</HudLabel>
        <div className="truncate text-sm text-ink" aria-live="polite">
          {line}
        </div>
        <button className="flex max-w-full items-center gap-1 truncate text-2xs text-ink-3 hover:text-ink-2" onClick={() => nav("/settings/voice")} title="Microphone settings">
          {off ? <MicOff className="h-3 w-3 shrink-0" aria-hidden /> : <Mic className="h-3 w-3 shrink-0" aria-hidden />}
          <span className="truncate">{mic || "System default microphone"}</span>
        </button>
      </div>
      <div className="w-44">
        <Select<ProviderId>
          ariaLabel="AI provider"
          value={settings.provider}
          onChange={(provider) => update({ provider })}
          options={(Object.keys(providerLabels) as ProviderId[]).map((id) => ({ value: id, label: providerLabels[id] }))}
        />
      </div>
      <IconButton icon={Plus} label="New conversation" disabled={messages.length === 0} onClick={newConversation} />
    </div>
  );
}

function Welcome({ onPick, level, listening }: { onPick: (s: string) => void; level: number; listening: boolean }) {
  const { settings } = useSettings();
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const model = settings.provider === "openai" ? settings.openaiModel : settings.provider === "ollama" ? settings.ollamaModel : settings.anthropicModel;
  return (
    <div className="flex min-h-[62vh] flex-col items-center justify-center py-8">
      <div className="grid w-full max-w-[640px] grid-cols-[1fr_auto_1fr] items-center gap-8 max-[860px]:grid-cols-1 max-[860px]:justify-items-center">
        <div className="space-y-3 text-right max-[860px]:hidden">
          <Readout label="Local time" value={now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} />
          <Readout label="Date" value={now.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" })} />
        </div>
        <HudFrame className="p-5" size={10}>
          <Core state={listening ? "idle" : "off"} level={level} size={132} />
        </HudFrame>
        <div className="space-y-3 max-[860px]:hidden">
          <Readout label="Voice" value={listening ? "Wake word armed" : "Mic off"} tone={listening ? "ok" : undefined} />
          <Readout label="Model" value={model} />
        </div>
      </div>
      <h1 className="mt-8 text-2xl font-semibold text-ink">{greeting()}</h1>
      <p className="mt-1 text-sm text-ink-3">{listening ? "Say “Hey BEV”, or type below." : "Type below, or turn the microphone on to talk."}</p>
      <div className="mt-8 w-full max-w-[540px]">
        <HudLabel className="mb-2 block px-1">Try</HudLabel>
        <ul className="divide-y divide-line-subtle overflow-hidden rounded-lg border border-line-subtle text-left">
          {SUGGESTIONS.map((s) => (
            <li key={s}>
              <button className="group flex w-full items-center justify-between gap-3 bg-surface-1 px-4 py-2.5 text-sm text-ink-2 transition-colors duration-fast hover:bg-surface-2 hover:text-ink" onClick={() => onPick(s)}>
                <span className="truncate">{s}</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-4 group-hover:text-accent" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Message({ m }: { m: ChatMessage }) {
  if (m.role === "user") {
    return (
      <div className="flex flex-col items-end">
        <div className="max-w-[78%] whitespace-pre-wrap rounded-xl rounded-br-sm bg-surface-2 px-3.5 py-2 text-base text-ink">{m.content}</div>
        <span className="tnum mt-1 font-mono text-[10px] tracking-[0.08em] text-ink-4">{clock(m.at)}</span>
      </div>
    );
  }
  const failed = m.ok === false;
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 w-6 shrink-0">
        <Core state={failed ? "error" : "idle"} size={22} title="BEV" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em]">
          <span className={failed ? "text-danger" : "text-accent"}>BEV</span>
          <span className="tnum text-ink-4">{clock(m.at)}</span>
        </div>
        <div className={clsx("text-base leading-[24px]", failed ? "text-danger" : "text-ink")}>
          <Markdown text={m.content} />
        </div>
      </div>
    </div>
  );
}

type Group = { kind: "msg"; msg: ChatMessage } | { kind: "tools"; id: string; items: ChatMessage[] };
export function groupMessages(ms: ChatMessage[]): Group[] {
  const out: Group[] = [];
  for (const m of ms) {
    if (m.role === "tool") {
      const last = out[out.length - 1];
      if (last?.kind === "tools") last.items.push(m);
      else out.push({ kind: "tools", id: m.id, items: [m] });
    } else out.push({ kind: "msg", msg: m });
  }
  return out;
}

function ToolRun({ items }: { items: ChatMessage[] }) {
  return (
    <div className="ml-9 border-l border-line pl-3">
      <ul className="space-y-0.5">
        {items.map((t) => (
          <ToolRow key={t.id} t={t} />
        ))}
      </ul>
    </div>
  );
}

function ToolRow({ t }: { t: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(t.toolName ?? "");
  const failed = t.ok === false;
  const line = summary(t.content);
  return (
    <li>
      <button
        className="group flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors duration-fast hover:bg-surface-1"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="tnum w-[52px] shrink-0 font-mono text-[10px] tracking-[0.06em] text-ink-4">{clock(t.at)}</span>
        <Icon className={clsx("h-3.5 w-3.5 shrink-0", failed ? "text-danger" : "text-ink-3")} strokeWidth={1.8} aria-hidden />
        <span className={clsx("shrink-0", failed ? "text-danger" : "text-ink-2")}>{toolLabel(t.toolName ?? "")}</span>
        {line && <span className="min-w-0 truncate text-ink-4">{line}</span>}
        <span className="ml-auto shrink-0">{failed ? <X className="h-3 w-3 text-danger" aria-label="failed" /> : <Check className="h-3 w-3 text-ink-4 group-hover:text-ok" aria-label="done" />}</span>
      </button>
      {open && (
        <pre className="mb-1 ml-[82px] mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-surface-1 px-3 py-2 font-mono text-2xs leading-4 text-ink-3 animate-fade-in">
          {t.content}
        </pre>
      )}
    </li>
  );
}

function Working({ text }: { text?: string }) {
  const { state } = useAssistant();
  const secs = useElapsed(true);
  return (
    <div className="flex items-center gap-3 text-sm text-ink-3">
      <div className="w-6">
        <Core state={state} size={22} />
      </div>
      <span className="text-ink-2">{text?.trim() || stateMeta[state].label}</span>
      {secs > 2 && <span className="tnum text-2xs text-ink-4">{secs}s</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Composer({ draft, setDraft, busy }: { draft: string; setDraft: (s: string) => void; busy: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { state, privacyMode } = useAssistant();
  const shortcut = useSettings((s) => s.settings.pushToTalkShortcut);
  const voiceBusy = state === "listening" || state === "speaking" || state === "activating";

  // Grow with the text up to a limit; keep focus when a suggestion is picked.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);
  useEffect(() => {
    if (draft) ref.current?.focus();
  }, [draft]);

  const submit = () => {
    if (!draft.trim() || busy) return;
    const t = draft;
    setDraft("");
    sendChat(t);
  };

  return (
    <div className="shrink-0 px-6 pb-4 pt-2">
      <div className="mx-auto w-full max-w-[760px]">
        <div className="rounded-xl border border-line bg-surface-1 transition-colors duration-fast focus-within:border-line-strong">
          <textarea
            ref={ref}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape" && busy) stopChat();
            }}
            placeholder="Ask BEV, or give it a task"
            aria-label="Message BEV"
            className="block max-h-[180px] w-full resize-none bg-transparent px-4 pb-1 pt-3 text-base text-ink placeholder:text-ink-4 focus:outline-none"
          />
          <div className="flex items-center gap-2 px-2 pb-2">
            <IconButton
              icon={voiceBusy ? Square : Mic}
              label={voiceBusy ? "Stop talking" : `Talk to BEV${shortcut ? ` (${prettyAccelerator(shortcut)})` : ""}`}
              active={voiceBusy}
              disabled={privacyMode}
              onClick={() => {
                const c = getController();
                if (!c) return;
                if (voiceBusy) c.interrupt();
                else c.onWake();
              }}
            />
            <div className="ml-auto flex items-center gap-2">
              <span className="hidden text-2xs text-ink-4 md:inline">
                <Kbd>Enter</Kbd> send <span className="mx-1">·</span> <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line
              </span>
              {busy ? (
                <button onClick={stopChat} className="grid h-8 w-8 place-items-center rounded-lg bg-surface-3 text-ink transition-colors hover:bg-danger/20 hover:text-danger" aria-label="Stop" title="Stop (Esc)">
                  <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
                </button>
              ) : (
                <button
                  onClick={submit}
                  disabled={!draft.trim()}
                  className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-accent-ink transition-colors hover:bg-accent-strong disabled:bg-surface-3 disabled:text-ink-4"
                  aria-label="Send"
                  title="Send (Enter)"
                >
                  <ArrowUp className="h-4 w-4" strokeWidth={2.2} aria-hidden />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
