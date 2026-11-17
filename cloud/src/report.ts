/** Tell the user something: Telegram text + voice note, and a phone call if urgent. */
import type { Env } from "./env";
import type { Store } from "./db";
import { Telegram } from "./telegram";
import { speak } from "./voice";
import { placeCall } from "./phone";

export interface Report {
  /** Short line: what happened (also the phone call's opening). */
  headline: string;
  /** Full message for Telegram. */
  text: string;
  urgent: boolean;
  taskId?: number | null;
}

export interface Deps {
  fetcher?: typeof fetch;
  now?: number;
}

export async function report(env: Env, store: Store, r: Report, deps: Deps = {}): Promise<string> {
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? Date.now();
  await store.addEvent(r.text, r.taskId ?? null, r.urgent, now);
  const chat = await store.get("owner_chat");
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN, fetcher);

  let callNote = "";
  if (r.urgent) {
    const c = await placeCall(env, store, { headline: r.headline, details: r.text }, fetcher, now);
    callNote = c.ok ? "📞 Calling you about this now." : `(Urgent, but no call: ${c.status}.)`;
  }
  if (!chat) return `no Telegram chat linked yet; ${callNote || "message not delivered"}`;

  const text = `${r.urgent ? "🚨 " : ""}${r.text}${callNote ? `\n\n${callNote}` : ""}`;
  await tg.send(chat, text);
  const audio = await speak(env, r.text, fetcher).catch(() => null);
  if (audio) await tg.sendVoice(chat, audio).catch((e) => console.warn("voice note failed", e));
  return callNote || "sent";
}
