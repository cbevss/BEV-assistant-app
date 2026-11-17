/**
 * Barge-in: talk while BEV is speaking and it stops to listen.
 *
 * The mic runs with echo cancellation on, so BEV's own voice is mostly
 * removed; on top of that only *sustained* sound well above the level heard
 * in the first moments of BEV speaking counts, so leftover echo, a cough or a
 * door doesn't cut BEV off.
 */
import { dbfs } from "./audio-analysis";
import { Mic16k, type CaptureOptions } from "./capture";

export interface BargeInConfig {
  /** Chunks (80 ms) used to measure the background while BEV talks. */
  baselineChunks: number;
  /** Speech must be this far above that baseline… */
  aboveBaselineDb: number;
  /** …and never quieter than this… */
  minDb: number;
  /** …for this many consecutive chunks (~0.4 s). */
  sustainChunks: number;
}

export const DEFAULT_BARGE_IN: BargeInConfig = { baselineChunks: 5, aboveBaselineDb: 12, minDb: -45, sustainChunks: 5 };

export class BargeInDetector {
  private seen = 0;
  private baseline = -100;
  private run = 0;
  constructor(private cfg: BargeInConfig = DEFAULT_BARGE_IN) {}

  /** True once the user is clearly talking. */
  push(chunk: Float32Array): boolean {
    const db = dbfs(chunk);
    if (this.seen < this.cfg.baselineChunks) {
      // Residual echo / room level while BEV starts speaking.
      this.baseline = this.seen === 0 ? db : Math.max(this.baseline, db);
      this.seen++;
      return false;
    }
    const loud = db > Math.max(this.cfg.minDb, this.baseline + this.cfg.aboveBaselineDb);
    this.run = loud ? this.run + 1 : 0;
    return this.run >= this.cfg.sustainChunks;
  }
}

/**
 * Resolves true if the user starts talking before `signal` aborts (BEV
 * finished speaking), false otherwise. Never rejects: barge-in is a bonus,
 * so a mic problem here just means no barge-in.
 */
export function listenForBargeIn(opts: CaptureOptions, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const mic = new Mic16k();
    const det = new BargeInDetector();
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      mic.stop();
      resolve(v);
    };
    signal.addEventListener("abort", () => finish(false), { once: true });
    mic.start({ ...opts, echoCancellation: true }, (c) => {
      if (!done && det.push(c)) finish(true);
    }).catch(() => finish(false));
  });
}
