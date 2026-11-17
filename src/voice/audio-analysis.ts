/**
 * Pure audio maths for BEV's voice pipeline: levels, an endpointer (when did
 * the user start / stop talking), microphone calibration, and word accuracy.
 * Samples are 16 kHz mono floats in −1..1, in 80 ms chunks (1280 samples).
 */

export const RATE = 16000;
export const CHUNK_MS = 80;

/** RMS level in dBFS (−100 for silence). */
export function dbfs(chunk: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
  const rms = Math.sqrt(sum / Math.max(1, chunk.length));
  return rms > 1e-5 ? 20 * Math.log10(rms) : -100;
}

export function peak(chunk: Float32Array): number {
  let p = 0;
  for (let i = 0; i < chunk.length; i++) p = Math.max(p, Math.abs(chunk[i]));
  return p;
}

function percentile(xs: number[], p: number): number {
  if (!xs.length) return -100;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
}

// ---------------------------------------------------------------------------
// Endpointer

export interface EndpointerConfig {
  /** Speech starts this many dB above the noise floor… */
  startAboveFloorDb: number;
  /** …for this many consecutive chunks. */
  startChunks: number;
  /** Still speech while within this many dB of the floor's margin. */
  keepAboveFloorDb: number;
  /** A pause this long ends the utterance (short mid-sentence pauses don't). */
  endSilenceMs: number;
  maxMs: number;
  /** Audio kept from before speech was detected, so the first word isn't clipped. */
  preRollMs: number;
}

/** Chunks used to learn the room's noise before detecting speech (~480 ms). */
const WARMUP_CHUNKS = 6;

export const DEFAULT_ENDPOINTER: EndpointerConfig = {
  startAboveFloorDb: 10,
  startChunks: 2,
  keepAboveFloorDb: 6,
  endSilenceMs: 1300,
  maxMs: 30_000,
  preRollMs: 400,
};

export type EndpointEvent = { type: "start" } | { type: "end"; audio: Float32Array; speechMs: number; reason: "pause" | "max" };

/**
 * Feeds on 80 ms chunks; reports when speech starts and when the utterance is
 * over, with the audio (pre-roll included). Adapts to the room's noise.
 */
export class Endpointer {
  private floor = -60;
  private warm = 0;
  private above = 0;
  private inSpeech = false;
  private quietMs = 0;
  private speechMs = 0;
  private totalMs = 0;
  private pre: Float32Array[] = [];
  private buf: Float32Array[] = [];

  constructor(private cfg: EndpointerConfig = DEFAULT_ENDPOINTER) {}

  get noiseFloorDb() {
    return this.floor;
  }

  /** Seed the floor (e.g. from calibration) so detection is right from the first chunk. */
  setFloor(db: number) {
    this.floor = Math.max(-80, Math.min(-25, db));
    this.warm = WARMUP_CHUNKS;
  }

  push(chunk: Float32Array): EndpointEvent | null {
    const db = dbfs(chunk);
    if (!this.inSpeech) {
      // Learn the room for the first ~0.5 s whatever it sounds like; after
      // that track the floor only while nobody's talking: quickly down, slowly up.
      if (this.warm < WARMUP_CHUNKS) this.floor += 0.5 * (db - this.floor);
      else if (db < this.floor + this.cfg.startAboveFloorDb) this.floor += (db < this.floor ? 0.3 : 0.03) * (db - this.floor);
      this.warm++;
      this.pre.push(chunk);
      const keep = Math.ceil(this.cfg.preRollMs / CHUNK_MS);
      if (this.pre.length > keep) this.pre.shift();
      this.above = db > this.floor + this.cfg.startAboveFloorDb ? this.above + 1 : 0;
      if (this.above >= this.cfg.startChunks && this.warm > WARMUP_CHUNKS) {
        this.inSpeech = true;
        this.buf = [...this.pre];
        this.pre = [];
        this.speechMs = this.above * CHUNK_MS;
        this.totalMs = this.buf.length * CHUNK_MS;
        this.quietMs = 0;
        return { type: "start" };
      }
      return null;
    }
    this.buf.push(chunk);
    this.totalMs += CHUNK_MS;
    if (db > this.floor + this.cfg.keepAboveFloorDb) {
      this.quietMs = 0;
      this.speechMs += CHUNK_MS;
    } else {
      this.quietMs += CHUNK_MS;
    }
    if (this.quietMs >= this.cfg.endSilenceMs || this.totalMs >= this.cfg.maxMs) {
      const reason = this.totalMs >= this.cfg.maxMs ? "max" : "pause";
      // Trim most of the trailing silence (keep 200 ms).
      const trailing = Math.max(0, Math.floor((this.quietMs - 200) / CHUNK_MS));
      const parts = this.buf.slice(0, this.buf.length - trailing);
      const audio = concat(parts);
      const ev: EndpointEvent = { type: "end", audio, speechMs: this.speechMs, reason };
      this.inSpeech = false;
      this.buf = [];
      this.above = 0;
      return ev;
    }
    return null;
  }
}

export function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Calibration

export interface CalibrationIssue {
  kind: "too_quiet" | "clipping" | "noisy" | "no_speech" | "loud_noise";
  message: string;
  fix: string;
}

export interface CalibrationReport {
  noiseFloorDb: number;
  speechDb: number;
  snrDb: number;
  clippingPct: number;
  verdict: "good" | "ok" | "poor";
  issues: CalibrationIssue[];
  /** Suggested Windows input level change (0..1 absolute), if the level should move. */
  suggestedLevel?: number;
}

function chunks(samples: Float32Array, size = (RATE * CHUNK_MS) / 1000): Float32Array[] {
  const out: Float32Array[] = [];
  for (let i = 0; i + size <= samples.length; i += size) out.push(samples.subarray(i, i + size));
  return out;
}

/**
 * Analyse a quiet recording and a recording of the user reading a sentence.
 * `currentLevel` is the Windows input level (0..1) if known, used to suggest
 * a better one.
 */
export function analyseCalibration(silence: Float32Array, speech: Float32Array, currentLevel?: number | null): CalibrationReport {
  const quiet = chunks(silence).map(dbfs);
  const talk = chunks(speech);
  const talkDb = talk.map(dbfs);
  const noiseFloorDb = percentile(quiet, 50);
  // Speech level: the louder half of the speech recording (skips the gaps between words).
  const speechDb = percentile(talkDb, 75);
  const snrDb = speechDb - noiseFloorDb;
  const clipped = talk.filter((c) => peak(c) >= 0.985).length;
  const clippingPct = talk.length ? (clipped / talk.length) * 100 : 0;

  const issues: CalibrationIssue[] = [];
  let suggestedLevel: number | undefined;
  const lvl = currentLevel ?? null;
  if (speechDb < noiseFloorDb + 6) {
    issues.push({
      kind: "no_speech",
      message: "BEV barely heard you while you were reading.",
      fix: "Check it's the right microphone and that it isn't muted, then try again.",
    });
  } else if (speechDb < -38) {
    issues.push({
      kind: "too_quiet",
      message: `Your voice is quiet (${speechDb.toFixed(0)} dBFS). Speech recognition works best around −30 to −15 dBFS.`,
      fix: "Raise the microphone level, or move closer to the mic.",
    });
    if (lvl !== null) suggestedLevel = Math.min(1, Math.max(lvl + 0.25, lvl * 1.6));
  }
  if (clippingPct > 1) {
    issues.push({
      kind: "clipping",
      message: `Your voice is distorting (${clippingPct.toFixed(1)}% of the time it hit the maximum).`,
      fix: "Lower the microphone level, or move a little further from the mic.",
    });
    if (lvl !== null) suggestedLevel = Math.max(0.2, lvl * 0.7);
  }
  if (noiseFloorDb > -40) {
    issues.push({
      kind: "loud_noise",
      message: `There's a lot of background noise (${noiseFloorDb.toFixed(0)} dBFS when you're quiet).`,
      fix: "Turn on noise suppression below, close the mic to your mouth, or reduce fan / speaker noise.",
    });
  } else if (snrDb < 15 && issues.every((i) => i.kind !== "no_speech")) {
    issues.push({
      kind: "noisy",
      message: `Your voice is only ${snrDb.toFixed(0)} dB above the background.`,
      fix: "Move closer to the mic or try noise suppression.",
    });
  }
  const verdict: CalibrationReport["verdict"] =
    issues.some((i) => i.kind === "no_speech" || i.kind === "clipping") || snrDb < 12
      ? "poor"
      : issues.length || snrDb < 25
        ? "ok"
        : "good";
  return { noiseFloorDb, speechDb, snrDb, clippingPct, verdict, issues, suggestedLevel };
}

// ---------------------------------------------------------------------------
// Recognition accuracy

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Word accuracy of `heard` against `said` (1 − word error rate, floored at 0). */
export function wordAccuracy(said: string, heard: string): { accuracy: number; errors: number; words: number } {
  const a = words(said);
  const b = words(heard);
  const d: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  const errors = d[b.length];
  return { accuracy: a.length ? Math.max(0, 1 - errors / a.length) : 0, errors, words: a.length };
}

/** Sentences for the recognition test: everyday commands with names Whisper/Windows often miss. */
export const TEST_SENTENCES = [
  "Hey BEV, open Antimicro and turn the volume down to thirty percent.",
  "Remind me at half past six to ring the garage about my car.",
  "What's using all my memory? Close Discord if it's that.",
  "Check whether my AMD drivers are up to date and tell me the version.",
];
