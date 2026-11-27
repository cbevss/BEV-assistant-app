/**
 * WhatsApp as a linked device: the bundled bev-wa helper signs in to the user's own
 * account (scan a QR code once, like WhatsApp Web) and keeps working while WhatsApp
 * is closed. Only used when the user turns it on in Settings.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface LinkedChat {
  name: string;
  chatId: string;
  unread: number;
  preview: string;
  time: number;
}
export interface LinkedMessage {
  chat: string;
  chatId: string;
  from: string;
  text: string;
  time: number;
  mine?: boolean;
}
export type WaEvent =
  | { event: "qr"; png: string }
  | { event: "qrTimeout" }
  | { event: "ready"; me: string }
  | ({ event: "message" } & LinkedMessage)
  | { event: "loggedOut" }
  | { event: "stopped" }
  | { event: "error"; error: string };

export const linkApi = {
  start: () => invoke<boolean>("wa_link_start"),
  stop: () => invoke<void>("wa_link_stop"),
  running: () => invoke<boolean>("wa_link_running"),
  request: <T>(request: Record<string, unknown>) => invoke<T>("wa_link_request", { request }),
  onEvent: (fn: (e: WaEvent) => void): Promise<UnlistenFn> => listen<WaEvent>("wa-event", (e) => fn(e.payload)),
};

let connected = false;
void linkApi.onEvent((e) => {
  if (e.event === "ready") connected = true;
  if (e.event === "loggedOut" || e.event === "stopped" || e.event === "qr") connected = false;
});

/** Linked and signed in (requests can go through the helper). */
export function isLinked(): boolean {
  return connected;
}

export const linked = {
  chats: () => linkApi.request<LinkedChat[]>({ cmd: "chats" }),
  read: (chat: string, max = 15) => linkApi.request<LinkedMessage[]>({ cmd: "read", chat, max }),
  send: (to: string, text: string) => linkApi.request<{ to: string }>({ cmd: "send", to, text }),
  logout: () => linkApi.request<null>({ cmd: "logout" }),
};

/** How a message reads aloud / in chat. Pure; tested. */
export function formatLinked(m: LinkedMessage): string {
  return m.from && m.from !== m.chat ? `${m.from}: ${m.text}` : m.text;
}
