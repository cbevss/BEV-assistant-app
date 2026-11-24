/**
 * The assistant: BEV's live state, the conversation (typed and spoken), what
 * BEV is doing right now, and the composer.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { prettyAccelerator } from "@/lib/hotkeys";
import { ArrowRight, ArrowUp, Check, FileText, Mic, MicOff, Paperclip, Plus, Square, X } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { fromBlob, fromPath, MAX_ATTACHMENTS, type Attachment } from "@/lib/attachments";
import { useAssistant, type AssistantState, type ChatMessage } from "@/state/assistant";
import { useSettings, type ProviderId } from "@/state/settings";
import { providerLabels } from "@/ai/factory";
import { progress as planProgress } from "@/ai/plan";
import { getController } from "@/voice/bootstrap";
import { stateMeta } from "../design";
import { Core } from "../components/Core";
import { Emblem } from "../components/Emblem";
import { PlanView } from "../components/PlanView";
import { IconButton, Select } from "../components/Form";
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
    if (el && stick.current && messages.length) el.scrollTop = el.scrollHeight;
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
        <div className={clsx("mx-auto w-full max-w-[760px] px-6 pb-6 pt-6", messages.length === 0 && "flex min-h-full flex-col")}>
          {messages.length === 0 ? (
            <Welcome onPick={setDraft} level={audioLevel} listening={micEnabled && !privacyMode} state={state} status={statusText} />
          ) : (
            <ol className="space-y-5" aria-live="polite" aria-label="Conversation">
              {groups.map((g) =>
                g.kind === "tools" ? (
                  <li key={g.id} className="animate-msg-in">
                    <ToolRun items={g.items} />
                  </li>
                ) : (
                  <li key={g.msg.id} className="animate-msg-in">
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
                <li className="animate-msg-in">
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

function Welcome({ onPick, level, listening, state, status }: { onPick: (s: string) => void; level: number; listening: boolean; state: AssistantState; status?: string }) {
  const idle = state === "idle";
  return (
    <div className="flex flex-1 flex-col items-center justify-center py-4">
      <Emblem state={idle ? (listening ? "idle" : "off") : state} level={level} size={228} continuous />
      <h1 key={idle ? "idle" : state} className="mt-6 animate-page-in text-[30px] font-light leading-9 tracking-[-0.01em] text-ink">{idle ? greeting() : stateMeta[state].label}</h1>
      <p className={clsx("mt-2 max-w-[520px] text-center", idle || !status?.trim() ? "font-mono text-[11px] uppercase tracking-[0.18em] text-ink-3" : state === "error" ? "text-sm text-danger" : "text-sm text-ink-2")}>
        {idle ? (listening ? "Say “Hey BEV” or type below" : "Microphone off · type below") : status?.trim() || ""}
      </p>
      <ul className={clsx("mt-8 w-full max-w-[480px]", !idle && "invisible")}>
        {SUGGESTIONS.slice(0, 3).map((s, i) => (
          <li key={s} className="animate-msg-in" style={{ animationDelay: `${520 + i * 70}ms` }}>
            <button
              className="group flex w-full items-center justify-between gap-3 border-b border-line-subtle py-2.5 text-left text-sm text-ink-3 transition-colors duration-fast hover:text-ink"
              onClick={() => onPick(s)}
            >
              <span className="truncate">{s}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-4 transition-[color,transform] duration-fast group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Message({ m }: { m: ChatMessage }) {
  if (m.role === "user") {
    return (
      <div className="group relative flex justify-end">
        <div className="flex max-w-[78%] flex-col items-end gap-1.5">
          {!!m.attachments?.length && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {m.attachments.map((f, i) =>
                f.thumb ? (
                  <img key={i} src={f.thumb} alt={f.name} title={f.name} className="h-20 max-w-[160px] rounded-lg border border-line object-cover" />
                ) : (
                  <span key={i} className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-1 px-2.5 py-1.5 text-xs text-ink-2" title={f.name}>
                    <FileText className="h-3.5 w-3.5" aria-hidden />
                    <span className="max-w-[180px] truncate">{f.name}</span>
                  </span>
                )
              )}
            </div>
          )}
          {m.content && <div className="whitespace-pre-wrap rounded-xl rounded-br-sm bg-surface-2 px-3.5 py-2 text-base text-ink">{m.content}</div>}
        </div>
        <span className="tnum absolute right-0 top-full mt-1 font-mono text-[10px] tracking-[0.08em] text-ink-4 opacity-0 transition-opacity duration-fast group-hover:opacity-100">{clock(m.at)}</span>
      </div>
    );
  }
  const failed = m.ok === false;
  return (
    <div className="group flex gap-3">
      <div className="mt-0.5 w-6 shrink-0">
        <Core state={failed ? "error" : "idle"} size={20} title="BEV" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em]">
          <span className={failed ? "text-danger" : "text-accent"}>BEV</span>
          <span className="tnum text-ink-4 opacity-0 transition-opacity duration-fast group-hover:opacity-100">{clock(m.at)}</span>
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
        <Icon className={clsx("h-3.5 w-3.5 shrink-0", failed ? "text-danger" : "text-ink-3")} strokeWidth={1.8} aria-hidden />
        <span className={clsx("shrink-0", failed ? "text-danger" : "text-ink-2")}>{toolLabel(t.toolName ?? "")}</span>
        {line && <span className="min-w-0 truncate text-ink-4">{line}</span>}
        <span className="ml-auto shrink-0">{failed ? <X className="h-3 w-3 text-danger" aria-label="failed" /> : <Check className="h-3 w-3 text-ink-4 group-hover:text-ok" aria-label="done" />}</span>
      </button>
      {open && (
        <pre className="mb-1 ml-6 mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-surface-1 px-3 py-2 font-mono text-2xs leading-4 text-ink-3 animate-fade-in">
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
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [attError, setAttError] = useState("");
  const [dragging, setDragging] = useState(false);

  const add = async (make: Array<() => Promise<Attachment>>) => {
    setAttError("");
    const room = MAX_ATTACHMENTS - atts.length;
    if (make.length > room) setAttError(`You can attach up to ${MAX_ATTACHMENTS} things at once.`);
    const out: Attachment[] = [];
    for (const m of make.slice(0, Math.max(0, room))) {
      try {
        out.push(await m());
      } catch (e) {
        setAttError(String((e as Error)?.message ?? e));
      }
    }
    if (out.length) setAtts((cur) => [...cur, ...out].slice(0, MAX_ATTACHMENTS));
    ref.current?.focus();
  };
  const pick = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const chosen = await open({ multiple: true, title: "Attach files for BEV" });
    const paths = Array.isArray(chosen) ? chosen : chosen ? [chosen] : [];
    if (paths.length) void add(paths.map((p) => () => fromPath(p)));
  };
  // Files dragged onto BEV's window.
  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        const t = e.payload.type;
        if (t === "enter" || t === "over") setDragging(true);
        else if (t === "leave") setDragging(false);
        else if (t === "drop") {
          setDragging(false);
          void add(e.payload.paths.map((p) => () => fromPath(p)));
        }
      })
      .then((u) => (alive ? (off = u) : u()))
      .catch(() => {});
    return () => {
      alive = false;
      off?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atts.length]);

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
    if ((!draft.trim() && !atts.length) || busy) return;
    const t = draft;
    const a = atts;
    setDraft("");
    setAtts([]);
    setAttError("");
    sendChat(t, a);
  };

  return (
    <div className="shrink-0 px-6 pb-4 pt-2">
      <div className="mx-auto w-full max-w-[760px]">
        <div className={clsx("rounded-2xl border bg-surface-1 transition-colors duration-fast focus-within:border-accent/50", dragging ? "border-accent" : "border-line")}>
          {(atts.length > 0 || dragging) && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {dragging && <span className="text-xs text-accent">Drop to attach</span>}
              {atts.map((f) => (
                <span key={f.id} className="group/att relative flex items-center gap-2 rounded-lg border border-line bg-surface-2 py-1 pl-1 pr-2 text-xs text-ink-2" title={f.path ?? f.name}>
                  {f.thumb ? <img src={f.thumb} alt="" className="h-9 w-9 rounded object-cover" /> : <FileText className="ml-1 h-4 w-4" aria-hidden />}
                  <span className="max-w-[160px] truncate">{f.name}</span>
                  <button className="rounded p-0.5 text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={`Remove ${f.name}`} onClick={() => setAtts((cur) => cur.filter((x) => x.id !== f.id))}>
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          )}
          {attError && <p className="px-4 pt-2 text-xs text-danger">{attError}</p>}
          <textarea
            ref={ref}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (!files.length) return;
              e.preventDefault();
              void add(files.map((f) => () => fromBlob(f)));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape" && busy) stopChat();
            }}
            placeholder="Ask BEV anything"
            aria-label="Message BEV"
            className="block max-h-[180px] w-full resize-none bg-transparent px-4 pb-1 pt-3 text-base text-ink placeholder:text-ink-4 focus:outline-none"
          />
          <div className="flex items-center gap-2 px-2 pb-2">
            <IconButton icon={Paperclip} label="Attach pictures or files (or paste / drag them in)" disabled={atts.length >= MAX_ATTACHMENTS} onClick={() => void pick()} />
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
              {busy ? (
                <button onClick={stopChat} className="grid h-8 w-8 place-items-center rounded-lg bg-surface-3 text-ink transition-colors hover:bg-danger/20 hover:text-danger" aria-label="Stop" title="Stop (Esc)">
                  <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
                </button>
              ) : (
                <button
                  onClick={submit}
                  disabled={!draft.trim() && !atts.length}
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
