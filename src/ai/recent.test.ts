import { beforeEach, describe, expect, it } from "vitest";
import { addRecent, clearRecent, recentFor, recentNote, RECENT_WINDOW_MS } from "./recent";

describe("recent conversation", () => {
  beforeEach(() => clearRecent());

  it("shares lines from other conversations within two minutes", () => {
    const now = 1_000_000;
    addRecent({ at: now - 30_000, who: "user", text: "what's the weather", source: "voice", channel: "voice" });
    addRecent({ at: now - 25_000, who: "bev", text: "Rainy, 9 degrees.", source: "voice" });
    addRecent({ at: now - RECENT_WINDOW_MS - 1, who: "user", text: "old", source: "voice" });
    expect(recentFor("chat", 0, now).map((l) => l.text)).toEqual(["what's the weather", "Rainy, 9 degrees."]);
    const note = recentNote("chat", 0, now);
    expect(note).toContain("[30s ago] User (spoken): what's the weather");
    expect(note).not.toContain("old");
  });

  it("hides a conversation's own lines unless they're from before its reset", () => {
    const now = 1_000_000;
    addRecent({ at: now - 60_000, who: "user", text: "before reset", source: "voice" });
    addRecent({ at: now - 10_000, who: "user", text: "after reset", source: "voice" });
    expect(recentFor("voice", now - 30_000, now).map((l) => l.text)).toEqual(["before reset"]);
    expect(recentNote("voice", 0, now)).toBe("");
  });

  it("trims long text", () => {
    addRecent({ at: Date.now(), who: "bev", text: "x".repeat(2000), source: "a" });
    expect(recentFor("b", 0)[0].text.length).toBeLessThan(700);
  });
});
