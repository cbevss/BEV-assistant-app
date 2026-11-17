import { it, expect, vi } from "vitest";
vi.mock("./oww/capture-worklet.js?url", () => ({ default: "" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { BargeInDetector } from "./bargein";

const tone = (amp: number) => {
  const c = new Float32Array(1280);
  for (let i = 0; i < c.length; i++) c[i] = amp * Math.sin(i / 3);
  return c;
};
const feed = (d: BargeInDetector, amps: number[]) => amps.map((a) => d.push(tone(a))).indexOf(true);

it("ignores BEV's leftover echo and short noises, triggers on sustained speech", () => {
  // Baseline: faint echo while BEV talks.
  expect(feed(new BargeInDetector(), [0.005, 0.005, 0.006, 0.005, 0.005, 0.006, 0.005, 0.006])).toBe(-1);
  // A cough: two loud chunks, then quiet again.
  expect(feed(new BargeInDetector(), [0.005, 0.005, 0.005, 0.005, 0.005, 0.1, 0.1, 0.005, 0.005, 0.005])).toBe(-1);
  // The user talks over BEV for ~0.4 s.
  expect(feed(new BargeInDetector(), [0.005, 0.005, 0.005, 0.005, 0.005, 0.08, 0.09, 0.07, 0.08, 0.09, 0.08])).toBe(9);
});

it("needs more than the echo level when BEV is loud", () => {
  // Loud echo baseline (speakers): moderate speech isn't enough…
  expect(feed(new BargeInDetector(), [0.05, 0.05, 0.05, 0.05, 0.05, 0.08, 0.08, 0.08, 0.08, 0.08, 0.08])).toBe(-1);
  // …clearly louder speech is.
  expect(feed(new BargeInDetector(), [0.05, 0.05, 0.05, 0.05, 0.05, 0.3, 0.3, 0.3, 0.3, 0.3])).toBe(9);
});
