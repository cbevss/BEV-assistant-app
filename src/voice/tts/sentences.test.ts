import { describe, it, expect } from "vitest";
import { splitForSpeech } from "./sentences";

describe("splitForSpeech", () => {
  it("merges short sentences and splits at sentence ends", () => {
    const chunks = splitForSpeech(
      "Sure. I've opened Rocket League for you. Your CPU is at 42% and RAM at 61%, so everything looks healthy. Anything else?"
    );
    expect(chunks).toEqual([
      "Sure. I've opened Rocket League for you.",
      "Your CPU is at 42% and RAM at 61%, so everything looks healthy. Anything else?",
    ]);
  });

  it("doesn't split decimals or abbreviations mid-sentence", () => {
    const chunks = splitForSpeech("The update is version 3.5 and it's about 1.2 GB, e.g. a few minutes on fibre.");
    expect(chunks).toHaveLength(1);
  });

  it("breaks very long sentences at commas, within the limit", () => {
    const long = Array.from({ length: 12 }, (_, i) => `item number ${i + 1} is ready`).join(", ") + ".";
    const chunks = splitForSpeech(long, 120);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(120));
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(long);
  });

  it("drops markdown and code blocks, and handles empty input", () => {
    expect(splitForSpeech("**Done!** Here's the `config`:\n```json\n{}\n```\nAll set.")).toEqual(["Done! Here's the config: All set."]);
    expect(splitForSpeech("   ")).toEqual([]);
  });
});
