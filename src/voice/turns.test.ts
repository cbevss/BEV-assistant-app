import { describe, expect, it } from "vitest";
import { addresseeHeuristic, asksQuestion, endOfSpeechMs, followUpPlan } from "./turns";

describe("end of speech", () => {
  it("waits longer when the sentence trails off and less when it sounds finished", () => {
    expect(endOfSpeechMs("open spotify and", 1300)).toBe(2200);
    expect(endOfSpeechMs("play something by um", 1300)).toBe(2200);
    expect(endOfSpeechMs("open spotify please", 1300)).toBe(1000);
    expect(endOfSpeechMs("what time is it?", 1300)).toBe(1000);
    expect(endOfSpeechMs("hello", 1300)).toBe(1300);
    expect(endOfSpeechMs("", 1300)).toBe(1300);
  });
});

describe("follow-up after a reply", () => {
  const smart = { followUpMode: "smart" as const, conversationTimeoutMs: 8000 };

  it("listens properly only when BEV asked something", () => {
    expect(asksQuestion("Spotify's open. Want me to play your liked songs?")).toBe(true);
    expect(asksQuestion("Done. What a game that was.")).toBe(false);
    expect(followUpPlan("Want me to play your liked songs?", smart)).toEqual({ listen: true, windowMs: 8000, expectAnswer: true });
    expect(followUpPlan("Volume's at 30%.", smart)).toEqual({ listen: true, windowMs: 4000, expectAnswer: false });
  });

  it("respects the other modes", () => {
    expect(followUpPlan("Volume's at 30%.", { ...smart, followUpMode: "off" }).listen).toBe(false);
    expect(followUpPlan("Volume's at 30%.", { ...smart, followUpMode: "always" })).toEqual({ listen: true, windowMs: 8000, expectAnswer: true });
  });
});

describe("who was that for", () => {
  it("knows talk aimed at BEV", () => {
    expect(addresseeHeuristic("bev turn it up", false)).toBe("bev");
    expect(addresseeHeuristic("yeah go on", true)).toBe("bev");
    expect(addresseeHeuristic("open discord", true)).toBe("bev");
  });

  it("knows talk aimed at friends in a call", () => {
    expect(addresseeHeuristic("bro did you see that", false)).toBe("other");
    expect(addresseeHeuristic("guys hold on one sec", true)).toBe("other");
    expect(addresseeHeuristic("he's literally right there", false)).toBe("other");
  });

  it("leaves the rest to the quick check", () => {
    expect(addresseeHeuristic("what about tomorrow", false)).toBe("unsure");
    expect(addresseeHeuristic("that was mad", false)).toBe("unsure");
  });
});
