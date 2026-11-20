import { describe, it, expect } from "vitest";
import { randInt, makePassword } from "./random";

describe("random", () => {
  it("stays in range and rejects biased values", () => {
    for (let i = 0; i < 500; i++) expect(randInt(6)).toBeLessThan(6);
    const seq = [2 ** 32 - 1, 7];
    expect(randInt(10, (a) => ((a[0] = seq.shift()!), a))).toBe(7);
  });
  it("makes passwords with every kind of character and no look-alikes", () => {
    for (let i = 0; i < 50; i++) {
      const p = makePassword(16);
      expect(p).toHaveLength(16);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[!@#$%^&*\-_=+?]/);
      expect(p).not.toMatch(/[lO01I]/);
    }
    expect(makePassword(4)).toHaveLength(8);
    expect(makePassword(12, false)).toMatch(/^[A-Za-z0-9]{12}$/);
  });
});
