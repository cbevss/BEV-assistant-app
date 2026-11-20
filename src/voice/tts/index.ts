import type { SpeechSynthesizer } from "../types";
import { pronounce } from "../pronounce";
import type { Settings } from "@/state/settings";
import { WebSpeechSynthesizer } from "../webspeech";
import { KokoroSynthesizer, kokoroStatus, preloadKokoro, setKokoroGpu } from "./kokoro";
import { ElevenLabsSynthesizer, ElevenLabsUnavailable } from "./elevenlabs";
import { SpeakError } from "./player";

export type TtsEngine = "windows" | "kokoro" | "elevenlabs";
export const ELEVEN_SECRET = "elevenlabs_key";

/** A message for the user about the voice (shown once per cause). */
export interface VoiceNote {
  text: string;
  /** Worth a Windows notification (e.g. credits ran out), not just a status line. */
  important: boolean;
}

/*
 * Engines that failed recently are skipped until `until` (ms timestamp), so a
 * reply isn't delayed by retrying something known to be down. Cleared when the
 * user changes voice settings.
 */
const down = new Map<string, { until: number; reason: string }>();
const HOUR = 3_600_000;

export function resetVoiceFallbacks() {
  down.clear();
}

function markDown(engine: string, err: unknown): VoiceNote {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof ElevenLabsUnavailable) {
    const ms = { quota: 6 * HOUR, auth: 24 * HOUR, rate: 60_000, network: 2 * 60_000 }[err.reason];
    down.set(engine, { until: Date.now() + ms, reason: err.reason });
    return {
      text:
        err.reason === "quota"
          ? "ElevenLabs credits are used up for this month, so BEV is using the free voice until they reset."
          : `${msg} Using the free voice for now.`,
      important: err.reason === "quota" || err.reason === "auth",
    };
  }
  down.set(engine, { until: Date.now() + 5 * 60_000, reason: "error" });
  return { text: `${engine === "kokoro" ? "The free voice" : "The voice"} failed (${msg}). Using the next one.`, important: false };
}

const isDown = (engine: string) => {
  const d = down.get(engine);
  if (d && d.until > Date.now()) return true;
  down.delete(engine);
  return false;
};

/**
 * Speaks with the chosen engine and falls back down the chain
 * (ElevenLabs → Kokoro → Windows) when one is unavailable, continuing from
 * where the failed one stopped. Windows always works, so BEV never goes silent.
 */
export class ChainSynthesizer implements SpeechSynthesizer {
  readonly id: string;
  private current: SpeechSynthesizer | null = null;

  constructor(
    private s: Settings,
    private getElevenKey: () => Promise<string | null>,
    private onNote: (n: VoiceNote) => void = () => {}
  ) {
    this.id = s.ttsEngine;
    setKokoroGpu(s.kokoroUseGpu);
  }

  private windows() {
    return new WebSpeechSynthesizer({ voiceId: this.s.voiceId || undefined, rate: this.s.speakRate, volume: this.s.speakVolume });
  }

  private kokoro() {
    return new KokoroSynthesizer({ voice: this.s.kokoroVoice, rate: this.s.speakRate, volume: this.s.speakVolume });
  }

  private async chain(): Promise<{ name: string; make: () => SpeechSynthesizer }[]> {
    const out: { name: string; make: () => SpeechSynthesizer }[] = [];
    if (this.s.ttsEngine === "elevenlabs") {
      const key = (await this.getElevenKey().catch(() => null)) ?? "";
      out.push({
        name: "elevenlabs",
        make: () =>
          new ElevenLabsSynthesizer({ apiKey: key, voiceId: this.s.elevenVoiceId, rate: this.s.speakRate, volume: this.s.speakVolume }),
      });
    }
    if (this.s.ttsEngine !== "windows") out.push({ name: "kokoro", make: () => this.kokoro() });
    out.push({ name: "windows", make: () => this.windows() });
    return out;
  }

  async speak(text: string, opts?: { signal?: AbortSignal; onLevel?: (l: number) => void }) {
    // "16 GB" → "16 gigabytes" and so on, for every voice.
    let remaining = pronounce(text);
    let lastErr: unknown = null;
    for (const { name, make } of await this.chain()) {
      if (opts?.signal?.aborted) return;
      if (name !== "windows" && isDown(name)) continue;
      if (name === "kokoro" && kokoroStatus().state !== "ready") {
        // First use: the model is still downloading. Don't keep the user
        // waiting; speak with the next engine and fetch it in the background.
        const st = kokoroStatus();
        if (st.state === "idle" || st.state === "error") {
          preloadKokoro().catch(() => {});
          this.onNote({ text: "Downloading the free natural voice. BEV uses the Windows voice until it's ready.", important: false });
        }
        continue;
      }
      try {
        this.current = make();
        await this.current.speak(remaining, opts);
        return;
      } catch (e) {
        if (opts?.signal?.aborted) return;
        lastErr = e;
        if (e instanceof SpeakError) remaining = e.remaining || remaining;
        const cause = e instanceof SpeakError ? e.cause : e;
        if (name === "windows") break;
        this.onNote(markDown(name, cause));
      } finally {
        this.current = null;
      }
    }
    if (lastErr) throw lastErr instanceof SpeakError ? lastErr.cause : lastErr;
  }

  cancel() {
    this.current?.cancel();
  }

  async listVoices() {
    return this.windows().listVoices();
  }
}
