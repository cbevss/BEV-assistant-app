/** Telegram Bot API: messages, voice notes, files, and owner pairing. */
import type { Env } from "./env";

const MAX_TEXT = 4000;

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Secret Telegram sends with each webhook call, so nobody else can post to /tg. */
export async function webhookSecret(env: Env): Promise<string> {
  return (await sha256Hex(`tg-webhook:${env.ADMIN_KEY}`)).slice(0, 48);
}

/** One-time code the owner sends as "/start CODE" to link their chat. */
export async function pairingCode(env: Env): Promise<string> {
  return (await sha256Hex(`tg-pair:${env.ADMIN_KEY}`)).slice(0, 8).toUpperCase();
}

export class Telegram {
  private token: string;
  constructor(
    token: string,
    private fetcher: typeof fetch = fetch
  ) {
    // A pasted token often carries a stray space or line break.
    this.token = (token ?? "").trim();
  }

  async call<T = unknown>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
    const isForm = body instanceof FormData;
    // Called unbound: Workers throw "Illegal invocation" if fetch runs with `this` set to another object.
    const f = this.fetcher;
    const res = await f(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: isForm ? undefined : { "content-type": "application/json" },
      body: isForm ? body : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description ?? res.status}`);
    return data.result as T;
  }

  /** Plain text (no markdown, so nothing needs escaping), split if long. */
  async send(chatId: string | number, text: string) {
    const parts: string[] = [];
    let rest = text.trim() || "…";
    while (rest.length > MAX_TEXT) {
      const cut = rest.lastIndexOf("\n", MAX_TEXT) > MAX_TEXT / 2 ? rest.lastIndexOf("\n", MAX_TEXT) : MAX_TEXT;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    parts.push(rest);
    for (const p of parts) await this.call("sendMessage", { chat_id: chatId, text: p, link_preview_options: { is_disabled: true } });
  }

  async sendVoice(chatId: string | number, mp3: ArrayBuffer) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("voice", new Blob([mp3], { type: "audio/mpeg" }), "bev.mp3");
    await this.call("sendVoice", form);
  }

  typing(chatId: string | number) {
    return this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  }

  async download(fileId: string): Promise<ArrayBuffer> {
    const f = await this.call<{ file_path: string; file_size?: number }>("getFile", { file_id: fileId });
    if ((f.file_size ?? 0) > 20 * 1024 * 1024) throw new Error("That file is too big.");
    const get = this.fetcher;
    const res = await get(`https://api.telegram.org/file/bot${this.token}/${f.file_path}`);
    if (!res.ok) throw new Error(`download ${res.status}`);
    return res.arrayBuffer();
  }

  setWebhook(url: string, secret: string) {
    return this.call("setWebhook", {
      url,
      secret_token: secret,
      allowed_updates: ["message"],
      drop_pending_updates: true,
    });
  }

  setCommands() {
    return this.call("setMyCommands", {
      commands: [
        { command: "tasks", description: "What BEV is tracking" },
        { command: "reports", description: "What BEV reported in the last day" },
        { command: "call", description: "Test call (if phone calls are set up)" },
        { command: "clear", description: "Start a fresh conversation" },
        { command: "help", description: "What BEV can do" },
      ],
    });
  }
}

/** The bits of a Telegram update BEV uses. */
export interface TgMessage {
  chat: { id: number; type: string };
  from?: { id: number; first_name?: string };
  text?: string;
  voice?: { file_id: string; duration: number };
  audio?: { file_id: string; duration?: number };
}
