import { it, expect } from "vitest";
import { cleanTranscript } from "./clean";

it("drops Whisper's phantom phrases but keeps real speech", () => {
  expect(cleanTranscript(" [BLANK_AUDIO]", 0)).toBe("");
  expect(cleanTranscript("Thank you.", 600)).toBe("");
  expect(cleanTranscript(" you", 300)).toBe("");
  expect(cleanTranscript("(music) Open Spotify.", 1800)).toBe("Open Spotify.");
  // A real "thank you" said deliberately (longer speech) is kept.
  expect(cleanTranscript("Thank you.", 2000)).toBe("Thank you.");
  expect(cleanTranscript("Open Antimicro and turn the volume down.", 2500)).toBe("Open Antimicro and turn the volume down.");
  expect(cleanTranscript("...", 400)).toBe("");
});
