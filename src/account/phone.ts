/**
 * Phone control, PC side. While it's on (Settings → Account → Phone control)
 * and the account is ready, BEV:
 * - checks the accounts service for messages from the phone page and runs
 *   requests in a "remote" conversation (mouse and keyboard need a phone OK first);
 * - sends anything that needs approval to the phone and waits (5 minutes)
 *   for the user to confirm it there, twice;
 * - mirrors what BEV does (requests, steps, replies, from the phone or at
 *   the PC) to the phone, except in privacy mode;
 * - sends a screenshot only when the phone asks, and says so on the PC.
 *
 * Everything is end-to-end encrypted (phoneCrypto.ts).
 */
import { create } from "zustand";
import { load, type Store } from "@tauri-apps/plugin-store";
import { native } from "@/lib/native";
import { notify } from "@/lib/notify";
import { useSettings } from "@/state/settings";
import { useAssistant, type ChatMessage } from "@/state/assistant";
import { toolLabel, summary } from "@/ui/assistant/tools";
import { Orchestrator } from "@/ai/orchestrator";
import { makeAssistantProvider } from "@/ai/factory";
import { useAccount, accountSecrets } from "./account";
import { fromBase64, messageWithAttachments, type Attachment } from "@/lib/attachments";
import { api } from "./client";
import { type PhoneFile, acceptFromPhone, openPhone, phoneKey, sealPhone, type FromPhone } from "./phoneCrypto";

const ACTIVE_MS = 2500;
/** Live screen: frame size and pace (about 1-2 frames a second on a phone connection). */
const LIVE_EDGE = 1280;
const LIVE_BYTES = 260_000;
const LIVE_QUALITY = 0.55;
const LIVE_GAP_MS = 600;
const IDLE_MS = 8000;
const ACTIVE_FOR = 10 * 60_000;
const APPROVAL_MS = 5 * 60_000;
const NEW_CONVERSATION_AFTER = 30 * 60_000;
const SEEN_KEEP = 300;

export interface PhoneStatus {
  running: boolean;
  lastCheck: number | null;
  error: string | null;
}
export const usePhone = create<PhoneStatus>(() => ({ running: false, lastCheck: null, error: null }));

/** Pure: a chat message as a feed item for the phone. */
export function feedItem(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") return { id: m.id, role: "tool", label: toolLabel(m.toolName ?? ""), text: summary(m.content ?? "", 160), ok: m.ok !== false, at: m.at };
  return {
    id: m.id,
    role: m.role,
    text: m.content,
    at: m.at,
    ...(m.source ? { source: m.source } : {}),
    ...(m.attachments?.length ? { files: m.attachments.map((f) => f.name) } : {}),
  };
}

/** Pure: messages that are new or changed since they were last sent. */
export function changedSince(messages: readonly ChatMessage[], sent: Map<string, string>): ChatMessage[] {
  return messages.filter((m) => sent.get(m.id) !== `${m.content}|${m.ok}`);
}

let kv: Store | null = null;
const store = async () => (kv ??= await load("phone.json", { autoSave: true }));

class PhoneLink {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private key: CryptoKey | null = null;
  private userId = "";
  private cursor = 0;
  private seen: string[] = [];
  private lastActivity = 0;
  private sent = new Map<string, string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private unsub: (() => void) | null = null;
  private approvals = new Map<string, (allow: boolean) => void>();
  private queue: Promise<void> = Promise.resolve();
  private orch: Orchestrator | null = null;
  private lastAsk = 0;

  async start() {
    const s = await accountSecrets();
    if (!s) throw new Error("sign in to your BEV account first");
    this.key = await phoneKey(s.dek);
    this.userId = s.userId;
    const st = await store();
    this.cursor = (await st.get<number>(`cursor:${s.userId}`)) ?? 0;
    this.seen = (await st.get<string[]>(`seen:${s.userId}`)) ?? [];
    // Only what happens from now on goes to the phone.
    for (const m of useAssistant.getState().messages) this.sent.set(m.id, `${m.content}|${m.ok}`);
    this.unsub = useAssistant.subscribe((a, prev) => {
      if (a.messages !== prev.messages) this.scheduleFlush();
    });
    usePhone.setState({ running: true, error: null });
    void this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.unsub?.();
    for (const r of this.approvals.values()) r(false);
    this.approvals.clear();
    usePhone.setState({ running: false });
  }

  private async token() {
    return (await accountSecrets())?.token ?? null;
  }

  private async send(payload: Record<string, unknown>) {
    const t = await this.token();
    if (!t || !this.key) return;
    const e = await sealPhone(this.key, "to_phone", this.userId, { ...payload, t: Date.now() });
    await api.phoneSend(t, "to_phone", e.iv, e.ct);
  }

  private async tick() {
    if (this.stopped) return;
    try {
      const t = await this.token();
      if (t && this.key) {
        const r = await api.phoneInbox(t, this.cursor);
        for (const m of r.messages) {
          this.cursor = Math.max(this.cursor, m.id);
          const p = await openPhone<unknown>(this.key, "to_pc", this.userId, m.iv, m.ct).catch(() => null);
          const msg = acceptFromPhone(p, Date.now(), new Set(this.seen));
          if (msg) {
            this.seen = [...this.seen, msg.id].slice(-SEEN_KEEP);
            this.lastActivity = Date.now();
            this.handle(msg);
          }
        }
        if (r.messages.length) {
          const st = await store();
          await st.set(`cursor:${this.userId}`, this.cursor);
          await st.set(`seen:${this.userId}`, this.seen);
        }
        this.setLive(r.live_until ?? 0, r.live_display ?? "current");
        usePhone.setState({ lastCheck: Date.now(), error: null });
      }
    } catch (e) {
      usePhone.setState({ error: e instanceof Error ? e.message : String(e) });
    }
    const busy = Date.now() - this.lastActivity < ACTIVE_FOR || this.liveUntil > Date.now();
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), busy ? ACTIVE_MS : IDLE_MS);
  }

  // ---- live screen: frames go up while the phone keeps asking for them

  private liveUntil = 0;
  private liveDisplay = "current";
  private streaming = false;

  private setLive(until: number, display: string) {
    this.liveUntil = until;
    this.liveDisplay = ["current", "all", "primary"].includes(display) ? display : "current";
    if (until > Date.now() && !this.streaming) void this.stream();
  }

  private async stream() {
    this.streaming = true;
    this.lastActivity = Date.now();
    useAssistant.getState().pushMessage({ role: "tool", content: "Your phone is watching your screen live.", toolName: "phone_live", ok: true });
    void notify("BEV", "Your phone is now watching your screen live.").catch(() => {});
    let last = "";
    let failures = 0;
    try {
      while (!this.stopped && this.liveUntil > Date.now() && failures < 5) {
        const started = Date.now();
        // Privacy mode: nothing leaves the PC, not even encrypted.
        if (!useAssistant.getState().privacyMode) {
          try {
            const shot = await native.captureScreen(this.liveDisplay as "current" | "all" | "primary");
            const data = await shrinkJpeg(shot.data, LIVE_EDGE, LIVE_BYTES, LIVE_QUALITY);
            if (data !== last) {
              const t = await this.token();
              if (!t || !this.key) break;
              const e = await sealPhone(this.key, "frame", this.userId, { type: "frame", data, label: shot.label || "Your screen", t: Date.now() });
              await api.phoneFrame(t, e.iv, e.ct);
              last = data;
            }
            failures = 0;
          } catch (e) {
            // 409: the phone stopped watching. Anything else: try a few more times.
            const status = (e as { status?: number })?.status;
            if (status === 409) break;
            if (status !== 429) failures++;
          }
        }
        await new Promise((r) => setTimeout(r, Math.max(150, LIVE_GAP_MS - (Date.now() - started))));
      }
    } finally {
      this.streaming = false;
      this.liveUntil = 0;
      useAssistant.getState().pushMessage({ role: "tool", content: "Stopped sharing your screen with your phone.", toolName: "phone_live", ok: true });
    }
  }

  private handle(m: FromPhone) {
    if (m.type === "approve") {
      const r = this.approvals.get(m.re);
      if (r) r(m.allow);
      return;
    }
    if (m.type === "screen") {
      void this.sendScreen().catch((e) => this.send({ type: "feed", items: [{ id: `${m.id}-r`, role: "tool", label: "Couldn't take a screenshot", text: String(e instanceof Error ? e.message : e), ok: false, at: Date.now() }] }));
      return;
    }
    // One request at a time, in order.
    this.queue = this.queue.then(() => this.ask(m.id, m.text, m.files ?? [])).catch(() => {});
  }

  private orchestrator(): Orchestrator {
    const s = useSettings.getState().settings;
    if (!this.orch || Date.now() - this.lastAsk > NEW_CONVERSATION_AFTER) {
      let live: string | null = null;
      this.orch = new Orchestrator(
        makeAssistantProvider(s),
        {
          onState: () => {},
          onAssistantText: () => {},
          onToolResult: (name, ok, result) => useAssistant.getState().pushMessage({ role: "tool", content: result, toolName: name, ok }),
          requestApproval: (_c, description) => this.approve(description),
          onTextDelta: (d) => {
            const a = useAssistant.getState();
            if (!live) {
              if (!d.trim()) return;
              live = `phone-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              a.pushMessage({ id: live, role: "assistant", content: d.replace(/^\s+/, "") });
              return;
            }
            a.appendToMessage(live, d);
          },
          onTextEnd: () => {
            live = null;
          },
        },
        { remote: true },
      );
    } else {
      this.orch.setProvider(makeAssistantProvider(s));
    }
    return this.orch;
  }

  private async ask(id: string, typed: string, files: PhoneFile[] = []) {
    const a = useAssistant.getState();
    // Pictures and files from the phone: pictures go to the AI, other files are saved on the PC.
    const atts: Attachment[] = [];
    const problems: string[] = [];
    for (const f of files) {
      try {
        atts.push(await fromBase64(f.name, f.mime, f.data));
      } catch (e) {
        problems.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    a.pushMessage({
      id,
      role: "user",
      content: typed,
      source: "phone",
      ...(atts.length ? { attachments: atts.map((x) => ({ name: x.name, kind: x.kind, thumb: x.thumb })) } : {}),
    });
    if (problems.length) a.pushMessage({ role: "tool", content: `Couldn't take ${problems.join("; ")}`, toolName: "phone_files", ok: false });
    if (!typed && !atts.length) return;
    const text = messageWithAttachments(typed, atts);
    const images = atts.flatMap((x) => (x.image ? [x.image] : []));
    const before = new Set(useAssistant.getState().messages.map((m) => m.id));
    try {
      const reply = await this.orchestrator().send(text, undefined, images);
      this.lastAsk = Date.now();
      // Streamed replies are already in the chat; otherwise add it now.
      const streamedReply = useAssistant.getState().messages.some((m) => !before.has(m.id) && m.role === "assistant");
      if (reply && !streamedReply) a.pushMessage({ role: "assistant", content: reply });
    } catch (e) {
      a.pushMessage({ role: "assistant", content: `Something went wrong: ${e instanceof Error ? e.message : String(e)}`, ok: false });
    }
  }

  /** Ask on the phone; the phone page asks the user to confirm a second time. */
  private async approve(description: string): Promise<boolean> {
    const id = crypto.randomUUID().replace(/-/g, "");
    const expires = Date.now() + APPROVAL_MS;
    await this.send({ type: "approval", id, text: description, expires });
    const allow = await new Promise<boolean | null>((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(id);
        resolve(null);
      }, APPROVAL_MS);
      this.approvals.set(id, (v) => {
        clearTimeout(timer);
        this.approvals.delete(id);
        resolve(v);
      });
    });
    void this.send({ type: "approval_done", re: id, outcome: allow === null ? "expired" : allow ? "allowed" : "declined" }).catch(() => {});
    return allow === true;
  }

  private async sendScreen() {
    const shot = await native.captureScreen("auto");
    const data = await shrinkJpeg(shot.data, 1280, 600_000);
    await this.send({ type: "screen", id: crypto.randomUUID().replace(/-/g, ""), data, label: shot.label || "Your screen" });
    useAssistant.getState().pushMessage({ role: "tool", content: `Sent a screenshot of ${shot.label || "your screen"} to your phone.`, toolName: "phone_screenshot", ok: true });
    void notify("BEV", "A screenshot of your screen was sent to your phone.").catch(() => {});
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 800);
  }

  private async flush() {
    if (this.stopped) return;
    const a = useAssistant.getState();
    const changed = changedSince(a.messages, this.sent);
    for (const m of changed) this.sent.set(m.id, `${m.content}|${m.ok}`);
    // Privacy mode: nothing leaves the PC, not even encrypted.
    if (!changed.length || a.privacyMode) return;
    this.lastActivity = Date.now();
    for (let i = 0; i < changed.length; i += 20) await this.send({ type: "feed", items: changed.slice(i, i + 20).map(feedItem) }).catch(() => {});
  }
}

/** Make a screenshot small enough for a phone (and the relay). */
async function shrinkJpeg(b64: string, maxEdge: number, maxBytes: number, startQuality = 0.7): Promise<string> {
  const img = new Image();
  img.src = `data:image/jpeg;base64,${b64}`;
  await img.decode();
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  for (const q of [0.7, 0.55, 0.4, 0.3].filter((x) => x <= startQuality)) {
    const out = c.toDataURL("image/jpeg", q).split(",")[1];
    if (out.length * 0.75 <= maxBytes) return out;
  }
  throw new Error("the screenshot was too big to send");
}

let link: PhoneLink | null = null;

/** Keep the phone link running whenever it's switched on and the account is ready. */
export function startPhoneControl() {
  const sync = () => {
    const want = useSettings.getState().settings.phoneControl && useAccount.getState().status === "ready";
    if (want && !link) {
      link = new PhoneLink();
      link.start().catch((e) => {
        usePhone.setState({ running: false, error: e instanceof Error ? e.message : String(e) });
        link = null;
      });
    } else if (!want && link) {
      link.stop();
      link = null;
    }
  };
  useSettings.subscribe(sync);
  useAccount.subscribe(sync);
  sync();
}
