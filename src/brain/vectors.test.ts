import { describe, it, expect } from "vitest";
import { encodeVec, decodeVec, cosine, jaccard, keywordScore, rank, tokens } from "./vectors";

describe("vectors", () => {
  it("round-trips through base64", () => {
    const v = new Float32Array([0.5, -1.25, 3e-5, 0]);
    expect(Array.from(decodeVec(encodeVec(v)))).toEqual(Array.from(v));
  });
  it("cosine", () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1);
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
    expect(cosine(new Float32Array([1]), new Float32Array([1, 0]))).toBe(0);
  });
  it("tokens drop filler and plurals", () => {
    expect(tokens("What's my main browsers?")).toEqual(["main", "browser"]);
  });
  it("jaccard and keyword score", () => {
    expect(jaccard("main browser", "browser main")).toBe(1);
    expect(jaccard("favourite food", "favourite colour")).toBeCloseTo(1 / 3);
    expect(keywordScore("browser", "main browser: Chrome")).toBe(1);
    expect(keywordScore("brow", "main browser: Chrome")).toBe(1); // prefix
    expect(keywordScore("car", "main browser: Chrome")).toBe(0);
  });
  it("rank combines meaning and words, drops non-matches", () => {
    const items = [
      { id: 1, t: "vehicle: VW Golf", v: new Float32Array([1, 0, 0]) },
      { id: 2, t: "main browser: Chrome", v: new Float32Array([0, 1, 0]) },
      { id: 3, t: "car insurance renews in March", v: new Float32Array([0.8, 0, 0.6]) },
    ];
    const q = new Float32Array([1, 0, 0]); // "my car"
    const r = rank(items, "my car", (i) => i.t, { queryVec: q, vec: (i) => i.v });
    expect(r.map((x) => x.item.id)).toEqual([3, 1]); // both car-related; 3 also matches the word
    expect(rank(items, "my car", (i) => i.t).map((x) => x.item.id)).toEqual([3]); // words only
  });
});
