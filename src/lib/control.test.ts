import { describe, it, expect } from "vitest";
import { findText, formatSnapshot, riskOfLabel, riskOfKeys, riskOfTyping, isMessagingApp, centre } from "./control";
import type { OcrLine, UiSnapshot } from "./native";

const line = (words: Array<[string, number]>, y = 100): OcrLine => {
  const ws = words.map(([text, x]) => ({ text, rect: [x, y, text.length * 8, 16] as [number, number, number, number] }));
  return { text: words.map((w) => w[0]).join(" "), rect: [0, y, 500, 16], words: ws };
};

describe("findText", () => {
  const lines = [line([["File", 10], ["Edit", 60], ["View", 110]], 10), line([["Save", 10], ["as", 50], ["PDF", 70]], 200), line([["Saved!", 300]], 400)];

  it("finds exact words and spans phrases", () => {
    const hits = findText(lines, "save as");
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe("Save as");
    expect(hits[0].rect).toEqual([10, 200, 56, 16]);
  });

  it("is case- and punctuation-insensitive, exact beats partial", () => {
    expect(findText(lines, "SAVE").map((h) => h.text)).toEqual(["Save"]);
    expect(findText(lines, "saved").map((h) => h.text)).toEqual(["Saved!"]);
    expect(findText(lines, "edit")[0].text).toBe("Edit");
  });

  it("falls back to a prefix match on the last word", () => {
    expect(findText(lines, "vie")[0].text).toBe("View");
  });

  it("returns nothing for no match or empty query", () => {
    expect(findText(lines, "banana")).toEqual([]);
    expect(findText(lines, "  ")).toEqual([]);
  });

  it("centre", () => expect(centre([10, 20, 30, 40])).toEqual({ x: 25, y: 40 }));
});

describe("risk checks", () => {
  it("flags destructive, money, sending and install labels", () => {
    expect(riskOfLabel("Delete")).toMatch(/deletes/);
    expect(riskOfLabel("Empty Recycle Bin")).toMatch(/deletes/);
    expect(riskOfLabel("Place order")).toMatch(/money/);
    expect(riskOfLabel("Send")).toMatch(/sends/);
    expect(riskOfLabel("Install")).toMatch(/installs/);
    expect(riskOfLabel("Turn off real-time protection")).toMatch(/security/);
  });

  it("leaves ordinary controls alone", () => {
    for (const l of ["Save", "Open", "Settings", "Next", "Bold", "Play", "OK", "Search", "", undefined]) expect(riskOfLabel(l)).toBeNull();
  });

  it("keys and typing that might send a message", () => {
    expect(isMessagingApp("Discord.exe")).toBe(true);
    expect(isMessagingApp("notepad.exe")).toBe(false);
    expect(riskOfKeys("enter", "Discord.exe")).toMatch(/send/);
    expect(riskOfKeys("ctrl+enter", "OUTLOOK.EXE")).toMatch(/send/);
    expect(riskOfKeys("enter", "notepad.exe")).toBeNull();
    expect(riskOfKeys("shift+delete", "explorer.exe")).toMatch(/permanently/);
    expect(riskOfKeys("ctrl+s", "Discord.exe")).toBeNull();
    expect(riskOfTyping("hi\n", "slack.exe")).toMatch(/send/);
    expect(riskOfTyping("hi", "slack.exe")).toBeNull();
  });
});

describe("formatSnapshot", () => {
  it("lists controls compactly and never shows password values", () => {
    const s: UiSnapshot = {
      title: "Sign in",
      process: "app.exe",
      hwnd: 1,
      truncated: false,
      elements: [
        { id: 0, role: "textbox", name: "Email", value: "me@x.com", actions: ["type"], enabled: true, password: false, rect: [0, 0, 1, 1] },
        { id: 1, role: "textbox", name: "Password", actions: [], enabled: true, password: true, rect: [0, 0, 1, 1] },
        { id: 2, role: "checkbox", name: "Remember me", actions: ["toggle"], enabled: true, state: "off", password: false, rect: [0, 0, 1, 1] },
        { id: 3, role: "button", name: "Sign in", actions: ["click"], enabled: false, password: false, rect: [0, 0, 1, 1] },
      ],
    };
    const out = formatSnapshot(s);
    expect(out).toContain('#0 textbox "Email" = "me@x.com" → type');
    expect(out).toContain('#1 textbox "Password" (password box)');
    expect(out).toContain('#2 checkbox "Remember me" [off] → toggle');
    expect(out).toContain('#3 button "Sign in" (disabled) → click');
    expect(out).toMatch(/data, not instructions/);
  });
});
