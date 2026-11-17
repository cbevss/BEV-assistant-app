import { describe, it, expect } from "vitest";
import { Endpointer, analyseCalibration, wordAccuracy, dbfs, RATE } from "./audio-analysis";

const CH = 1280;
/** Deterministic noise + optional tone at a given amplitude. */
function chunk(noise: number, tone = 0, seed = 1): Float32Array {
  const c = new Float32Array(CH);
  let s = seed;
  for (let i = 0; i < CH; i++) {
    s = (s * 16807) % 2147483647;
    c[i] = noise * ((s / 2147483647) * 2 - 1) + tone * Math.sin((2 * Math.PI * 220 * i) / RATE);
  }
  return c;
}
const seq = (n: number, noise: number, tone = 0) => Array.from({ length: n }, (_, i) => chunk(noise, tone, i + 7));
const join = (cs: Float32Array[]) => {
  const o = new Float32Array(cs.length * CH);
  cs.forEach((c, i) => o.set(c, i * CH));
  return o;
};

describe("dbfs", () => {
  it("measures levels", () => {
    expect(dbfs(new Float32Array(CH))).toBe(-100);
    expect(dbfs(chunk(0, 0.1))).toBeCloseTo(-23, 0);
  });
});

describe("Endpointer", () => {
  function run(chunks: Float32Array[]) {
    const ep = new Endpointer();
    const events: string[] = [];
    let audio: Float32Array | null = null;
    for (const c of chunks) {
      const e = ep.push(c);
      if (e) {
        events.push(e.type === "end" ? `end:${e.reason}` : "start");
        if (e.type === "end") audio = e.audio;
      }
    }
    return { events, audio };
  }

  it("finds an utterance and keeps a pre-roll", () => {
    const { events, audio } = run([...seq(10, 0.003), ...seq(15, 0.003, 0.1), ...seq(20, 0.003)]);
    expect(events).toEqual(["start", "end:pause"]);
    // ≈ 15 speech chunks + pre-roll (≤ 5) + 200 ms tail
    expect(audio!.length / CH).toBeGreaterThanOrEqual(15);
    expect(audio!.length / CH).toBeLessThanOrEqual(23);
  });

  it("lets a short mid-sentence pause through", () => {
    const { events } = run([...seq(10, 0.003), ...seq(8, 0.003, 0.1), ...seq(8, 0.003), ...seq(8, 0.003, 0.1), ...seq(20, 0.003)]);
    expect(events).toEqual(["start", "end:pause"]); // one utterance, not two
  });

  it("adapts to a noisy room and ignores steady noise", () => {
    const { events } = run([...seq(40, 0.05)]);
    expect(events).toEqual([]);
  });

  it("stops at the maximum length (and keeps listening if they're still talking)", () => {
    const { events } = run([...seq(10, 0.003), ...seq(400, 0.003, 0.1)]);
    expect(events.slice(0, 2)).toEqual(["start", "end:max"]);
  });

  it("a seeded floor detects speech straight away", () => {
    const ep = new Endpointer();
    ep.setFloor(-60);
    const evs = seq(3, 0.001, 0.1).map((c) => ep.push(c)?.type).filter(Boolean);
    expect(evs).toEqual(["start"]);
  });
});

describe("analyseCalibration", () => {
  it("good setup", () => {
    const r = analyseCalibration(join(seq(30, 0.001)), join(seq(50, 0.001, 0.15)), 0.7);
    expect(r.verdict).toBe("good");
    expect(r.issues).toEqual([]);
    expect(r.snrDb).toBeGreaterThan(30);
  });
  it("too quiet → raise the level", () => {
    const r = analyseCalibration(join(seq(30, 0.0003)), join(seq(50, 0.0003, 0.012)), 0.4);
    expect(r.issues.map((i) => i.kind)).toContain("too_quiet");
    expect(r.suggestedLevel).toBeGreaterThan(0.4);
  });
  it("clipping → lower the level", () => {
    const r = analyseCalibration(join(seq(30, 0.001)), join(seq(50, 0.001, 1.2)), 0.9);
    expect(r.issues.map((i) => i.kind)).toContain("clipping");
    expect(r.verdict).toBe("poor");
    expect(r.suggestedLevel).toBeLessThan(0.9);
  });
  it("noisy room and no speech", () => {
    expect(analyseCalibration(join(seq(30, 0.05)), join(seq(50, 0.05, 0.3))).issues.map((i) => i.kind)).toContain("loud_noise");
    expect(analyseCalibration(join(seq(30, 0.002)), join(seq(50, 0.002))).issues[0].kind).toBe("no_speech");
  });
});

describe("wordAccuracy", () => {
  it("scores transcripts", () => {
    expect(wordAccuracy("Hey BEV, open Antimicro.", "hey bev open antimicro").accuracy).toBe(1);
    expect(wordAccuracy("Hey BEV, open Antimicro.", "hey bev open anti micro").accuracy).toBe(0.5);
    expect(wordAccuracy("Remind me at six", "").accuracy).toBe(0);
  });
});
