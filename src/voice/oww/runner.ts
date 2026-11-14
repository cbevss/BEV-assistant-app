import type * as Ort from "onnxruntime-web";
import type { OwwRunner } from "./pipeline";

type ModelSource = string | Uint8Array;

/**
 * Builds an OwwRunner on onnxruntime. The ort module is passed in so the app
 * uses the WebAssembly build and tests can use the same code under Node.
 */
export async function createOrtRunner(
  ort: typeof Ort,
  models: { melspectrogram: ModelSource; embedding: ModelSource; wakeword: ModelSource }
): Promise<OwwRunner & { release(): Promise<void> }> {
  const opts: Ort.InferenceSession.SessionOptions = { executionProviders: ["wasm"] };
  const open = (src: ModelSource) =>
    typeof src === "string"
      ? ort.InferenceSession.create(src, opts)
      : ort.InferenceSession.create(src, opts);
  const [mel, emb, wake] = await Promise.all([
    open(models.melspectrogram),
    open(models.embedding),
    open(models.wakeword),
  ]);

  const featureFrames = wakewordFrames(wake);

  const run = async (s: Ort.InferenceSession, data: Float32Array, dims: number[]) => {
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", data, dims) });
    return out[s.outputNames[0]].data as Float32Array;
  };

  return {
    featureFrames,
    melspectrogram: (audio) => run(mel, audio, [1, audio.length]),
    embedding: (m) => run(emb, m, [1, 76, 32, 1]),
    wakeword: (f) => run(wake, f, [1, featureFrames, 96]),
    release: async () => {
      await Promise.all([mel.release(), emb.release(), wake.release()]);
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
