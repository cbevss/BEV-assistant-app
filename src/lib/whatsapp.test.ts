import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { parseChatList, parseMessages, phoneNumber, newlyUnread } from "./whatsapp";
import type { UiElement } from "./native";

const el = (role: string, name: string, id = Math.floor(Math.random() * 1e6)): UiElement => ({ id, role, name, actions: [], enabled: true, password: false, rect: [0, 0, 10, 10] });

describe("WhatsApp", () => {
  it("reads chats and unread counts from the chat list, whatever order the parts come in", () => {
    const chats = parseChatList([
      el("button", "New chat"),
      el("list item", "Mum, 21:30, Are you coming for tea?, 2 unread messages"),
      el("list item", "Football lads, 1 unread message, Dan: kick off at 7, Yesterday"),
      el("list item", "Sam, 18:02, ok see you then"),
      el("list item", "Settings"),
    ]);
    expect(chats).toEqual([
      { name: "Mum", unread: 2, preview: "Are you coming for tea?", time: "21:30" },
      { name: "Football lads", unread: 1, preview: "Dan: kick off at 7", time: "Yesterday" },
      { name: "Sam", unread: 0, preview: "ok see you then", time: "18:02" },
    ]);
  });
  it("reads the messages in a chat without the app's labels", () => {
    const msgs = parseMessages(
      [el("text", "Mum"), el("button", "Attach"), el("list item", "Are you coming for tea?"), el("text", "21:30"), el("list item", "Bring milk"), el("textbox", "Type a message")],
      "Mum"
    );
    expect(msgs).toEqual(["Are you coming for tea?", "Bring milk"]);
  });
  it("understands phone numbers", () => {
    expect(phoneNumber("+44 7700 900123")).toBe("447700900123");
    expect(phoneNumber("07700 900123")).toBe("447700900123");
    expect(phoneNumber("0044 7700 900123")).toBe("447700900123");
    expect(phoneNumber("Mum")).toBeNull();
  });
  it("spots chats with more unread than before", () => {
    const before = new Map([["Mum", 1], ["Sam", 0]]);
    const now = [
      { name: "Mum", unread: 2, preview: "", time: "" },
      { name: "Sam", unread: 0, preview: "", time: "" },
      { name: "Dan", unread: 1, preview: "", time: "" },
    ];
    expect(newlyUnread(before, now).map((c) => c.name)).toEqual(["Mum", "Dan"]);
  });
});
