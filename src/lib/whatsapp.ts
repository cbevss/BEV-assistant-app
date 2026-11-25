/**
 * WhatsApp through the WhatsApp desktop app on this PC (no unofficial WhatsApp
 * clients: those break WhatsApp's terms and can get the number banned). BEV
 * reads the app's chat list and chats through Windows' accessibility tree, and
 * sends by opening the chat and typing, like the user would.
 */
import { native, type UiElement, type UiSnapshot } from "./native";
import { layoutApi, findWindows } from "./layouts";
import { appsApi } from "./apps";
import { controlCache, findControl } from "./control";

export interface ChatSummary {
  name: string;
  unread: number;
  preview: string;
  time: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TIME = /^(\d{1,2}:\d{2}(\s?[ap]m)?|yesterday|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}\/\d{2,4})$/i;

/**
 * Chats from the chat list. WhatsApp names each row like
 * "Mum, 2 unread messages, Are you coming?, 21:30" (the order varies by version), so
 * the parts are told apart by their shape. Pure; tested.
 */
export function parseChatList(elements: UiElement[]): ChatSummary[] {
  const out: ChatSummary[] = [];
  const seen = new Set<string>();
  for (const e of elements) {
    if (!["list item", "row", "tree item", "group"].includes(e.role) || !e.name) continue;
    const parts = e.name.split(/,\s+|\n/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const unreadPart = parts.find((p) => /\bunread message/i.test(p));
    const unread = unreadPart ? Number(unreadPart.match(/(\d+)/)?.[1] ?? 1) : 0;
    const time = parts.find((p) => TIME.test(p)) ?? "";
    const rest = parts.filter((p) => p !== unreadPart && p !== time && !/^(pinned|muted|typing…?|online)$/i.test(p));
    const name = rest[0];
    if (!name || name.length > 60 || seen.has(name)) continue;
    // A chat row has a time or an unread count; plain list items elsewhere don't.
    if (!time && !unread) continue;
    seen.add(name);
    out.push({ name, unread, preview: rest.slice(1).join(", ").slice(0, 300), time });
  }
  return out;
}

/** Text of the messages in the open chat (the newest last), without the app's own labels. Pure; tested. */
export function parseMessages(elements: UiElement[], chatName: string, max = 15): string[] {
  const skip = /^(type a message|search|menu|attach|emoji|send|voice message|chats|status|calls|communities|settings|profile|new chat|filter|archived|end-to-end encrypted)/i;
  const msgs: string[] = [];
  for (const e of elements) {
    if (!["list item", "row", "group", "text"].includes(e.role) || !e.name || e.name.length < 2) continue;
    if (skip.test(e.name) || e.name === chatName || TIME.test(e.name)) continue;
    if (/\bunread message/i.test(e.name)) continue;
    if (msgs[msgs.length - 1] === e.name) continue;
    msgs.push(e.name.slice(0, 600));
  }
  return msgs.slice(-max);
}

/** A phone number the user gave ("+44 7700 900123", "07700900123" → needs a country code). Pure; tested. */
export function phoneNumber(to: string): string | null {
  const t = to.replace(/[\s()-]/g, "");
  if (!/^\+?\d{8,15}$/.test(t)) return null;
  if (t.startsWith("+")) return t.slice(1);
  if (t.startsWith("00")) return t.slice(2);
  if (t.startsWith("07") && t.length === 11) return "44" + t.slice(1);   // a UK mobile written the UK way
  return t;
}

async function whatsappWindow(open: boolean) {
  const find = async () => findWindows(await layoutApi.placements(), "whatsapp")[0] ?? null;
  let w = await find();
  if (!w && open) {
    await appsApi.open("WhatsApp");
    for (let i = 0; i < 20 && !w; i++) {
      await sleep(500);
      w = await find();
    }
  }
  if (!w && open) throw new Error("WhatsApp isn't installed or didn't open. Install WhatsApp from the Microsoft Store and link it to your phone first.");
  return w;
}

async function read(hwnd: number): Promise<UiSnapshot> {
  const snap = await native.uiRead(hwnd);
  controlCache.setUi(snap);
  return snap;
}

/** Unread chats (needs WhatsApp's window open, even if it's behind other windows). */
export async function unreadChats(): Promise<ChatSummary[]> {
  const w = await whatsappWindow(true);
  return parseChatList((await read(w!.hwnd)).elements).filter((c) => c.unread > 0);
}

/** Open a chat by searching for it. Returns the snapshot of the opened chat. */
async function openChat(name: string): Promise<{ hwnd: number; snap: UiSnapshot }> {
  const w = await whatsappWindow(true);
  let snap = await read(w!.hwnd);
  const row = parseChatList(snap.elements).find((c) => c.name.toLowerCase() === name.toLowerCase());
  const rowEl = row ? snap.elements.find((e) => e.name.startsWith(row.name)) : null;
  if (rowEl) await native.uiAct(rowEl.id, "click");
  else {
    const search = findControl(snap.elements, "Search", "textbox") ?? snap.elements.find((e) => e.role === "textbox" && /search/i.test(e.name));
    if (!search) throw new Error("Couldn't find WhatsApp's search box. Is WhatsApp linked and on the Chats page?");
    await native.uiAct(search.id, "type", name);
    await sleep(900);
    snap = await read(w!.hwnd);
    const hit = parseChatList(snap.elements).find((c) => c.name.toLowerCase().includes(name.toLowerCase()));
    const el = hit ? snap.elements.find((e) => e.name.startsWith(hit.name)) : null;
    if (!el) throw new Error(`No WhatsApp chat called "${name}". Check the name, or give their number.`);
    await native.uiAct(el.id, "click");
  }
  await sleep(900);
  return { hwnd: w!.hwnd, snap: await read(w!.hwnd) };
}

export async function readChat(name: string, max = 15): Promise<string[]> {
  const { snap } = await openChat(name);
  return parseMessages(snap.elements, name, max);
}

export async function sendMessage(to: string, text: string): Promise<string> {
  const number = phoneNumber(to);
  let hwnd: number;
  if (number) {
    // WhatsApp's own link opens the chat with the message typed in.
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(`whatsapp://send?phone=${number}&text=${encodeURIComponent(text)}`);
    await sleep(2500);
    const w = await whatsappWindow(true);
    hwnd = w!.hwnd;
    await read(hwnd);
  } else {
    const chat = await openChat(to);
    hwnd = chat.hwnd;
    const box = chat.snap.elements.find((e) => e.role === "textbox" && /type a message|message/i.test(e.name));
    if (!box) throw new Error("Couldn't find the message box in that chat.");
    await native.uiAct(box.id, "type", text);
  }
  await native.focusWindow(hwnd).catch(() => {});
  await sleep(250);
  await native.inputKeys("enter");
  await sleep(1200);
  const after = parseMessages((await read(hwnd)).elements, to, 6);
  const sent = after.some((m) => m.includes(text.slice(0, 40)));
  return sent ? "sent" : "sent (couldn't confirm it appeared in the chat)";
}

// ---------------------------------------------------------------------------
// Telling the user when a new message arrives (while WhatsApp's window is open, even behind others).

let last = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Chats that have more unread than last time. Pure; tested. */
export function newlyUnread(before: Map<string, number>, now: ChatSummary[]): ChatSummary[] {
  return now.filter((c) => c.unread > (before.get(c.name) ?? 0));
}

export function startWhatsAppWatch(onNew: (chats: ChatSummary[]) => void, everyMs = 30_000) {
  if (timer) return;
  const tick = async () => {
    try {
      const w = await whatsappWindow(false);
      // A minimised window would have to be restored to read it: leave it alone.
      if (w && w.state !== "minimized") {
        const chats = parseChatList((await native.uiRead(w.hwnd)).elements);
        const fresh = last.size || chats.length ? newlyUnread(last, chats) : [];
        if (last.size && fresh.length) onNew(fresh);
        last = new Map(chats.map((c) => [c.name, c.unread]));
      }
    } catch {
      /* not running, or the window changed: try again next time */
    }
    timer = setTimeout(() => void tick(), everyMs);
  };
  timer = setTimeout(() => void tick(), 10_000);
}
