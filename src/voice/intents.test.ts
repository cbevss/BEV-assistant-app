import { describe, it, expect } from "vitest";
import { endIntent } from "./intents";

describe("endIntent", () => {
  it.each([
    "I wasn't talking to you",
    "sorry, I wasn't talking to you BEV",
    "not talking to you",
    "I'm not talking to you",
    "I was talking to someone else",
    "not you",
    "That's all",
    "that's all for now, thanks",
    "OK thanks BEV, that's it",
    "no that's everything",
    "that's all I needed",
    "that will be all",
    "I'm done",
    "thanks, I'm good",
    "all good thanks",
    "nothing else",
    "no thanks",
    "never mind",
    "nevermind",
    "forget it",
    "bye",
    "goodbye BEV",
    "see you later",
    "thanks",
    "thank you BEV",
    "cheers mate",
    "Good night",
  ])("%s → dismiss", (u) => {
    expect(endIntent(u)).toBe("dismiss");
  });

  it.each(["stop", "BEV stop", "stop talking", "shut up", "cancel", "be quiet", "please stop"])("%s → stop", (u) => {
    expect(endIntent(u)).toBe("stop");
  });

  it.each([
    "open Rocket League",
    "what's the weather",
    "that's all the files I need, now zip them",
    "turn the volume down then that's all",
    "no, open Steam instead",
    "thank you, now open Discord",
    "is everything done downloading",
    "who are you talking to",
    "stop Spotify",
    "set a timer for ten minutes",
    "",
    "   ",
    "no",
    "yeah",
  ])("%j → keep talking", (u) => {
    expect(endIntent(u)).toBeNull();
  });
});
