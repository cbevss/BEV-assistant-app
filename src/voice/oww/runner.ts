import type * as Ort from "onnxruntime-web";
import type { OwwRunner } from "./pipeline";

type ModelSource = string | Uint8Array;

/**
 * Builds an OwwRunner on onnxruntime. The ort module is passed in so the app
 * uses the WebAssembly build and tests can use the same code under Node.
 */
export async function createOrtRunner(
  ort: typeof Ort,
  models: {
    melspectrogram: ModelSource;
    embedding: ModelSource;
    /** One model per wake phrase ("hey BEV", "yo BEV"…); any of them can wake BEV. */
    wakeword: ModelSource | ModelSource[];
  }
): Promise<OwwRunner & { release(): Promise<void>; wakewordCount: number }> {
  const opts: Ort.InferenceSession.SessionOptions = { executionProviders: ["wasm"] };
  const open = (src: ModelSource) =>
    typeof src === "string"
      ? ort.InferenceSession.create(src, opts)
      : ort.InferenceSession.create(src, opts);
  const wakeSources = Array.isArray(models.wakeword) ? models.wakeword : [models.wakeword];
  if (wakeSources.length === 0) throw new Error("No wake-word model to load.");
  const [mel, emb, ...wakes] = await Promise.all([
    open(models.melspectrogram),
    open(models.embedding),
    ...wakeSources.map(open),
  ]);

  let frames: number[];
  try {
    frames = wakes.map(wakewordFrames);
  } catch (e) {
    await Promise.all([mel, emb, ...wakes].map((x) => x.release().catch(() => {})));
    throw e;
  }
  // The pipeline keeps enough feature rows for the longest model; shorter
  // models read just their most recent rows.
  const featureFrames = Math.max(...frames);

  const run = async (s: Ort.InferenceSession, data: Float32Array, dims: number[]) => {
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", data, dims) });
    return out[s.outputNames[0]].data as Float32Array;
  };

  return {
    featureFrames,
    melspectrogram: (audio) => run(mel, audio, [1, audio.length]),
    embedding: (m) => run(emb, m, [1, 76, 32, 1]),
    wakewordCount: wakes.length,
    // Highest score across the phrase models: whichever phrase was said wins.
    wakeword: async (f) => {
      let best = 0;
      for (let i = 0; i < wakes.length; i++) {
        const n = frames[i];
        const input = n === featureFrames ? f : f.subarray((featureFrames - n) * 96);
        const out = await run(wakes[i], input, [1, n, 96]);
        if (out[0] > best) best = out[0];
      }
      return new Float32Array([best]);
    },
    release: async () => {
      await Promise.all([mel, emb, ...wakes].map((x) => x.release()));
    },
  };
}

/**
 * Checks a wake-word model has the openWakeWord shape (1 × N × 96 in, one
 * score out) and returns N. Throws a readable error for anything else, e.g.
 * someone loading the wrong .onnx file.
 */
export function wakewordFrames(s: Ort.InferenceSession): number {
  if (s.inputNames.length !== 1 || s.outputNames.length < 1) {
    throw new Error("This doesn't look like an openWakeWord model (expected one input and one output).");
  }
  const meta = s.inputMetadata?.[0];
  const shape = meta && "shape" in meta ? (meta.shape as (number | string)[]) : null;
  if (!shape) return 16;
  const [, frames, dim] = shape;
  if (shape.length !== 3 || dim !== 96) {
    throw new Error(
      `This doesn't look like an openWakeWord model (input shape is [${shape.join(", ")}], expected [1, 16, 96]).`
    );
  }
  return typeof frames === "number" && frames > 0 ? frames : 16;
}
