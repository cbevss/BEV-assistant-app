import { describe, it, expect } from "vitest";
import { looksSensitive } from "./sensitive";

describe("looksSensitive", () => {
  it.each([
    ["my password is hunter2"],
    ["api key sk-abcdefghijklmnopqrstuvwx"],
    ["card 4111 1111 1111 1111"],
    ["-----BEGIN RSA PRIVATE KEY-----"],
    ["ghp_abcdefghijklmnopqrstuvwxyz123456"],
  ])("flags %s", (s) => expect(looksSensitive(s)).toBe(true));

  it.each([
    ["gaming mode apps: Discord, Spotify"],
    ["preferred browser is Chrome"],
    ["my steam id number 1234567890123"], // fails Luhn → not a card
  ])("allows %s", (s) => expect(looksSensitive(s)).toBe(false));
});
