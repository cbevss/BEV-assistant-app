import { describe, it, expect } from "vitest";
import { smallTalk, smallTalkReply, THANKS_REPLIES, SIGNOFF_REPLIES } from "../src/smalltalk";

describe("short replies to thanks and sign-offs", () => {
  it("spots plain thanks", () => {
    for (const t of ["Good, thanks bev.", "thanks", "Cheers mate", "thank you so much", "ty", "nice one thanks", "thanks, that's all"]) expect(smallTalk(t), t).toBe("thanks");
  });
  it("spots sign-offs", () => {
    for (const t of ["that's all", "I'm done", "bye bev", "ok that's it"]) expect(smallTalk(t), t).toBe("signoff");
  });
  it("leaves real requests to the AI", () => {
    for (const t of ["thanks, can you also check Argos?", "thanks, now remind me at 5", "what's the price?", "check currys", "thanks for nothing, it's broken and the price is wrong again today"])
      expect(smallTalk(t), t).toBeNull();
  });
  it("varies and stays short", () => {
    expect(new Set([0, 0.15, 0.35, 0.55, 0.95].map((r) => smallTalkReply("thanks", () => r))).size).toBeGreaterThan(3);
    for (const r of [...THANKS_REPLIES, ...SIGNOFF_REPLIES]) expect(r.split(" ").length).toBeLessThanOrEqual(6);
  });
});
