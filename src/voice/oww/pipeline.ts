/**
 * openWakeWord streaming pipeline, ported from the reference Python
 * implementation (openwakeword/utils.py AudioFeatures + model.py predict).
 *
 * Every 80 ms of 16 kHz audio (1280 samples):
 *   1. melspectrogram model on the newest 1280 + 480 samples → 8 mel frames
 *      (transformed x / 10 + 2, as the reference does)
 *   2. embedding model on the newest 76 mel frames → one 96-dim embedding
 *   3. wake-word model on the newest 16 embeddings → a 0..1 score
 *
 * Inference is abstracted behind `OwwRunner` so the same code runs in the app
 * (onnxruntime-web) and in tests (checked against the Python reference).
 */

export const SAMPLE_RATE = 16_000;
export const CHUNK = 1280; // 80 ms
const MEL_CONTEXT = 160 * 3; // extra samples the mel model needs per chunk
const MEL_BINS = 32;
const MEL_WINDOW = 76;
const EMBED_DIM = 96;
const MEL_MAX = 10 * 97; // ~10 s of mel frames, as the reference
const FEATURE_MAX = 120; // ~10 s of embeddings, as the reference

/** Runs one model: flat float32 input of `dims`, returns the flat output. */
export interface OwwRunner {
  melspectrogram(audio: Float32Array): Promise<Float32Array>;
  embedding(mel: Float32Array): Promise<Float32Array>;
  wakeword(features: Float32Array): Promise<Float32Array>;
  /** Embeddings the wake-word model looks at (16 for standard models). */
  readonly featureFrames: number;
}

export class OwwPipeline {
  private raw = new Float32Array(0);
  private pending: number[] = [];
  /** Mel frames, flattened rows of 32. Seeded with ones like the reference. */
  private mel: Float32Array = new Float32Array(MEL_WINDOW * MEL_BINS).fill(1);
  /** Embeddings, flattened rows of 96. */
  private features: Float32Array = new Float32Array(0);
  /** Real embeddings produced so far; scores are meaningless until the window is full. */
  private produced = 0;

  constructor(private runner: OwwRunner) {}

  reset() {
    this.raw = new Float32Array(0);
    this.pending = [];
    this.mel = new Float32Array(MEL_WINDOW * MEL_BINS).fill(1);
    this.features = new Float32Array(0);
    this.produced = 0;
  }

  /** Whether enough audio has been seen for scores to mean anything. */
  get warm(): boolean {
    return this.produced >= this.runner.featureFrames;
  }

  /**
   * Feed samples in int16 scale (−32768..32767). Returns one score per
   * completed 80 ms chunk (often zero or one), or null while warming up.
   */
  async push(samples: ArrayLike<number>): Promise<(number | null)[]> {
    for (let i = 0; i < samples.length; i++) this.pending.push(samples[i]);
    const scores: (number | null)[] = [];
    while (this.pending.length >= CHUNK) {
      const chunk = this.pending.splice(0, CHUNK);
      scores.push(await this.step(chunk));
    }
    return scores;
  }

  private async step(chunk: number[]): Promise<number | null> {
    // Keep only the context the mel model needs: this chunk + 480 samples before it.
    const keep = CHUNK + MEL_CONTEXT;
    const next = new Float32Array(Math.min(keep, this.raw.length + CHUNK));
    const carry = next.length - CHUNK;
    next.set(this.raw.subarray(this.raw.length - carry), 0);
    next.set(chunk, carry);
    this.raw = next;

    const melOut = await this.runner.melspectrogram(this.raw);
    const frames = new Float32Array(melOut.length);
    for (let i = 0; i < melOut.length; i++) frames[i] = melOut[i] / 10 + 2;
    this.mel = appendRows(this.mel, frames, MEL_BINS, MEL_MAX);

    const melRows = this.mel.length / MEL_BINS;
    if (melRows < MEL_WINDOW) return null;
    const window = this.mel.subarray((melRows - MEL_WINDOW) * MEL_BINS);
    const emb = await this.runner.embedding(window);
    this.features = appendRows(this.features, emb.subarray(0, EMBED_DIM), EMBED_DIM, FEATURE_MAX);
    this.produced++;

    if (!this.warm) return null;
    const n = this.runner.featureFrames;
    const rows = this.features.length / EMBED_DIM;
    const input = this.features.slice((rows - n) * EMBED_DIM);
    const out = await this.runner.wakeword(input);
    return out[0];
  }
}

function appendRows(buf: Float32Array, rows: Float32Array, width: number, maxRows: number): Float32Array {
  const total = buf.length + rows.length;
  const keep = Math.min(total, maxRows * width);
  const out = new Float32Array(keep);
  const fromOld = keep - rows.length;
  if (fromOld > 0) out.set(buf.subarray(buf.length - fromOld), 0);
  out.set(fromOld >= 0 ? rows : rows.subarray(-keep), Math.max(0, fromOld));
  return out;
}

/**
 * Turns a stream of scores into wake events: fires when the score crosses the
 * threshold, then ignores further hits for `debounceMs` so one "hey BEV"
 * triggers once.
 */
export class WakeDetector {
  private lastFire = -Infinity;
  constructor(
    public threshold: number,
    private debounceMs = 2000
  ) {}

  hit(score: number | null, now: number): boolean {
    if (score === null || score < this.threshold) return false;
    if (now - this.lastFire < this.debounceMs) return false;
    this.lastFire = now;
    return true;
  }
}

/** Sensitivity slider (0.1..1, higher = easier to trigger) → score threshold. */
export function thresholdFor(sensitivity: number): number {
  const s = Math.min(1, Math.max(0.1, sensitivity));
  return Math.round((0.9 - 0.8 * s) * 100) / 100;
}
