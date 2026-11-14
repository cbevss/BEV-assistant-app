// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-web";
import { OwwPipeline, WakeDetector, thresholdFor, CHUNK } from "./pipeline";
import { createOrtRunner } from "./runner";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const bytes = (p: string) => new Uint8Array(readFileSync(here(p)));
ort.env.wasm.numThreads = 1;

/** 16-bit mono 16 kHz WAV → int16 samples (reads the data chunk). */
function readWav(p: string): Int16Array {
  const buf = readFileSync(here(p));
  let off = 12;
  while (off < buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return new Int16Array(buf.buffer.slice(buf.byteOffset + off + 8, buf.byteOffset + off + 8 + size));
    off += 8 + size;
  }
  throw new Error("no data chunk");
}

/** Same padding and chunking as the reference predict_clip(padding=1). */
async function scoreClip(clip: string): Promise<(number | null)[]> {
  const runner = await createOrtRunner(ort, {
    melspectrogram: bytes("./models/melspectrogram.onnx"),
    embedding: bytes("./models/embedding_model.onnx"),
    wakeword: bytes("./__fixtures__/alexa_v0.1.onnx"),
  });
  const pipe = new OwwPipeline(runner);
  const audio = readWav(clip);
  const padded = new Int16Array(audio.length + 32000);
  padded.set(audio, 16000);
  const scores: (number | null)[] = [];
  for (let i = 0; i + CHUNK < padded.length; i += CHUNK) {
    scores.push(...(await pipe.push(padded.subarray(i, i + CHUNK))));
  }
  await runner.release();
  return scores;
}

const reference = JSON.parse(readFileSync(here("./__fixtures__/reference_scores.json"), "utf8")) as Record<
  string,
  number[]
>;

describe("openWakeWord pipeline matches the Python reference", () => {
  it.each(["alexa_test.wav", "hey_jane.wav"])("%s", async (clip) => {
    const ours = await scoreClip(`./__fixtures__/${clip}`);
    const ref = reference[clip];
    let maxDiff = 0;
    expect(ours).toHaveLength(ref.length);
    // Before 16 real embeddings exist the reference scores against random
    // noise; from then on both see identical inputs and must agree.
    for (let i = 15; i < ref.length; i++) {
      expect(ours[i]).not.toBeNull();
      expect(Math.abs((ours[i] as number) - ref[i])).toBeLessThan(0.02);
      maxDiff = Math.max(maxDiff, Math.abs((ours[i] as number) - ref[i]));
    }
    if (process.env.OWW_DEBUG) console.log(clip, "max |diff|", maxDiff.toExponential(2));
  }, 60_000);

  it("detects the wake word in the positive clip and not in the other speech", async () => {
    const pos = (await scoreClip("./__fixtures__/alexa_test.wav")).filter((s): s is number => s !== null);
    const neg = (await scoreClip("./__fixtures__/hey_jane.wav")).filter((s): s is number => s !== null);
    expect(Math.max(...pos)).toBeGreaterThan(0.9);
    expect(Math.max(...neg)).toBeLessThan(0.1);
  }, 60_000);
});

describe("loading a model file", () => {
  it("rejects a file that isn't a wake-word model with a readable message", async () => {
    await expect(
      createOrtRunner(ort, {
        melspectrogram: bytes("./models/melspectrogram.onnx"),
        embedding: bytes("./models/embedding_model.onnx"),
        // The embedding model is a valid .onnx, just not a wake-word model.
        wakeword: bytes("./models/embedding_model.onnx"),
      })
    ).rejects.toThrow(/doesn't look like an openWakeWord model/);
  });

  it("rejects bytes that aren't an ONNX file at all", async () => {
    await expect(
      createOrtRunner(ort, {
        melspectrogram: bytes("./models/melspectrogram.onnx"),
        embedding: bytes("./models/embedding_model.onnx"),
        wakeword: new TextEncoder().encode("not a model"),
      })
    ).rejects.toThrow();
  });
});

describe("WakeDetector", () => {
  it("fires once per utterance and again after the debounce", () => {
    const d = new WakeDetector(0.5, 2000);
    expect(d.hit(null, 0)).toBe(false);
    expect(d.hit(0.4, 0)).toBe(false);
    expect(d.hit(0.9, 100)).toBe(true);
    expect(d.hit(0.95, 180)).toBe(false);
    expect(d.hit(0.9, 2200)).toBe(true);
  });

  it("maps sensitivity to a sensible threshold", () => {
    expect(thresholdFor(0.5)).toBe(0.5);
    expect(thresholdFor(1)).toBe(0.1);
    expect(thresholdFor(0)).toBe(0.82);
  });
});
