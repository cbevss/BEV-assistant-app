import { splitForSpeech } from "./sentences";

/** One synthesised chunk: mono samples, or encoded audio (mp3) to decode. */
export type ChunkAudio = { samples: Float32Array; rate: number } | { encoded: ArrayBuffer };

export type SynthesiseChunk = (text: string, signal: AbortSignal) => Promise<ChunkAudio>;

/** Thrown when synthesis fails part-way: what's left can go to another engine. */
export class SpeakError extends Error {
  constructor(
    readonly cause: unknown,
    /** The text not yet spoken (from the failed chunk on). */
    readonly remaining: string
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

let sharedCtx: AudioContext | null = null;
const audioContext = () => (sharedCtx ??= new AudioContext());

/**
 * Speaks `text` chunk by chunk: synthesises the next chunk while the current
 * one plays, so there's no gap and the first words come quickly. Reports a
 * live level (for the orb) and stops cleanly on abort.
 */
export async function speakChunked(
  text: string,
  synth: SynthesiseChunk,
  opts: { signal?: AbortSignal; onLevel?: (l: number) => void; volume?: number } = {}
): Promise<void> {
  const chunks = splitForSpeech(text);
  if (chunks.length === 0) return;
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  opts.signal?.addEventListener("abort", abort, { once: true });

  const ctx = audioContext();
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});
  const gain = ctx.createGain();
  gain.gain.value = opts.volume ?? 1;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  gain.connect(analyser).connect(ctx.destination);
  const levelBuf = new Float32Array(analyser.fftSize);
  const meter = setInterval(() => {
    analyser.getFloatTimeDomainData(levelBuf);
    let sum = 0;
    for (const v of levelBuf) sum += v * v;
    opts.onLevel?.(Math.min(1, Math.sqrt(sum / levelBuf.length) * 4));
  }, 60);

  const toBuffer = async (a: ChunkAudio): Promise<AudioBuffer> => {
    if ("encoded" in a) return ctx.decodeAudioData(a.encoded);
    const buf = ctx.createBuffer(1, a.samples.length, a.rate);
    buf.copyToChannel(a.samples as Float32Array<ArrayBuffer>, 0);
    return buf;
  };
  const prepare = (i: number) => synth(chunks[i], ctl.signal).then(toBuffer);

  try {
    let next: Promise<AudioBuffer> | null = prepare(0);
    for (let i = 0; i < chunks.length; i++) {
      let buffer: AudioBuffer;
      try {
        buffer = await next!;
      } catch (e) {
        if (ctl.signal.aborted) return;
        throw new SpeakError(e, chunks.slice(i).join(" "));
      }
      // Start the next chunk now so it's ready when this one finishes.
      next = i + 1 < chunks.length ? prepare(i + 1) : null;
      next?.catch(() => {}); // surfaced when awaited
      if (ctl.signal.aborted) return;
      await play(ctx, buffer, gain, ctl.signal);
      if (ctl.signal.aborted) return;
    }
  } finally {
    clearInterval(meter);
    opts.onLevel?.(0);
    opts.signal?.removeEventListener("abort", abort);
    ctl.abort(); // cancel any prefetch still running
    gain.disconnect();
    analyser.disconnect();
  }
}

function play(ctx: AudioContext, buffer: AudioBuffer, out: AudioNode, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(out);
    const done = () => {
      signal.removeEventListener("abort", stop);
      src.disconnect();
      resolve();
    };
    const stop = () => {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    };
    src.onended = done;
    signal.addEventListener("abort", stop, { once: true });
    src.start();
  });
}
