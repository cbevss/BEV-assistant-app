import type { Env } from "../src/env";
import type { Chat, ChatResult } from "../src/ai";
import { testDb } from "./d1";

export interface Sent {
  url: string;
  body: unknown;
}

/** A fetch that records calls and answers Telegram/ElevenLabs/web like the real ones. */
export function fakeFetch(pages: Record<string, string> = {}) {
  const sent: Sent[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep text */
      }
    }
    sent.push({ url, body });
    if (url.startsWith("https://api.telegram.org/")) return Response.json({ ok: true, result: { file_path: "voice/1.oga" } });
    if (url.includes("/v1/text-to-speech/")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    if (init?.method === "PATCH" && /\/v1\/convai\/(tools|agents)\//.test(url)) return Response.json({});
    if (url.endsWith("/v1/convai/tools")) return Response.json({ id: `tool_${sent.length}` });
    if (url.endsWith("/v1/convai/agents/create")) return Response.json({ agent_id: "agent_1" });
    if (url.endsWith("/v1/convai/phone-numbers")) return Response.json({ phone_number_id: "phone_1" });
    if (url.endsWith("/v1/convai/twilio/outbound-call")) return Response.json({ success: true, conversation_id: "c1", callSid: "CA1" });
    if (url in pages) return new Response(pages[url], { headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fn, sent, pages };
}

export function testEnv(extra: Partial<Env> = {}): Env {
  return {
    DB: testDb(),
    AI: {} as Ai,
    TIMEZONE: "Europe/London",
    ADMIN_KEY: "test-admin-key-0123456789abcdef",
    TELEGRAM_BOT_TOKEN: "123:abc",
    AI_API_KEY: "sk-test",
    ...extra,
  };
}

export const withCalls: Partial<Env> = {
  ELEVENLABS_API_KEY: "el",
  ELEVENLABS_VOICE_ID: "voice1",
  TWILIO_ACCOUNT_SID: "AC1",
  TWILIO_AUTH_TOKEN: "tok",
  TWILIO_PHONE_NUMBER: "+447000000000",
  MY_PHONE_NUMBER: "+447111111111",
};

/** A scripted model: each call returns the next reply. */
export function scriptedChat(replies: Array<Partial<ChatResult> | ((req: Parameters<Chat>[0]) => Partial<ChatResult>)>) {
  const calls: Parameters<Chat>[0][] = [];
  const chat: Chat = async (req) => {
    calls.push(structuredClone(req));
    const r = replies.shift();
    const v = typeof r === "function" ? r(req) : r ?? {};
    return { text: v.text ?? "", toolCalls: v.toolCalls ?? [] };
  };
  return { chat, calls };
}
