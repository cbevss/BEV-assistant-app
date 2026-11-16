import { SpeechRecognizer, SpeechSynthesizer } from "./types";

/**
 * Working voice path using the browser SpeechRecognition + SpeechSynthesis
 * APIs available in the WebView2 runtime. This gives BEV a functional voice
 * out of the box; Whisper/ElevenLabs can replace these via Settings.
 */

type SR = typeof window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

/** A speech-recognition failure the user should see (no internet, mic blocked…). */
export class SttError extends Error {
  constructor(readonly code: string) {
    super(sttErrorText(code));
  }
}

export function sttErrorText(code: string): string {
  switch (code) {
    case "network":
      return "Speech recognition needs the internet and couldn't reach it.";
    case "audio-capture":
      return "No microphone found. Check the input device in Voice & Audio.";
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked. Allow it in Windows Settings → Privacy → Microphone.";
    case "language-not-supported":
      return "Speech recognition doesn't support the selected language.";
    default:
      return `Speech recognition failed (${code}).`;
  }
}

/** How long a pause ends what you're saying. Short pauses mid-sentence don't. */
export const END_OF_SPEECH_MS = 1300;
/** Hard limit on one utterance, in case the recogniser never goes quiet. */
const MAX_UTTERANCE_MS = 30_000;

export class WebSpeechRecognizer implements SpeechRecognizer {
  readonly id = "webspeech";
  constructor(
    private lang = "en-GB",
    private endOfSpeechMs = END_OF_SPEECH_MS
  ) {}

  /**
   * One utterance. Continuous mode with our own end-of-speech timer: the
   * built-in single-shot mode stops at the first short pause, which cut people
   * off mid-sentence. Resolves "" for silence; rejects with SttError for real
   * failures; rejects with AbortError when aborted.
   */
  listenOnce(opts: { signal?: AbortSignal; onPartial?: (t: string) => void }): Promise<string> {
    const w = window as SR;
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return Promise.reject(new Error("SpeechRecognition unavailable in this runtime"));

    return new Promise((resolve, reject) => {
      const rec = new Ctor();
      rec.lang = this.lang;
      rec.continuous = true;
      rec.interimResults = true;
      let finalText = "";
      let interim = "";
      let quiet: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const cap = setTimeout(() => stop(), MAX_UTTERANCE_MS);

      const stop = () => {
        try {
          rec.stop();
        } catch {
          /* already stopped */
        }
      };
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(quiet);
        clearTimeout(cap);
        opts.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => {
        finish(() => reject(new DOMException("aborted", "AbortError")));
        try {
          rec.abort();
        } catch {
          /* ignore */
        }
      };

      rec.onresult = (e) => {
        // e.results holds every result since start: rebuild, don't append,
        // or earlier phrases get repeated.
        let f = "";
        let i2 = "";
        for (let i = 0; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) f += r[0].transcript;
          else i2 += r[0].transcript;
        }
        finalText = f;
        interim = i2;
        opts.onPartial?.(join(finalText, interim));
        clearTimeout(quiet);
        quiet = setTimeout(stop, this.endOfSpeechMs);
      };
      rec.onerror = (e) => {
        // Silence and our own stop/abort aren't failures.
        if (e.error === "no-speech" || e.error === "aborted") return;
        finish(() => reject(new SttError(e.error)));
      };
      // Stopped before the last words were finalised: keep them anyway.
      rec.onend = () => finish(() => resolve(join(finalText, interim)));

      if (opts.signal?.aborted) return onAbort();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      rec.start();
    });
  }
}

function join(a: string, b: string): string {
  return `${a} ${b}`.replace(/\s+/g, " ").trim();
}

export class WebSpeechSynthesizer implements SpeechSynthesizer {
  readonly id = "webspeech";

  constructor(
    private opts: { voiceId?: string; rate?: number; volume?: number; pitch?: number } = {}
  ) {}

  async listVoices() {
    const load = () =>
      speechSynthesis.getVoices().map((v) => ({ id: v.voiceURI, name: `${v.name} (${v.lang})` }));
    let voices = load();
    if (voices.length === 0) {
      await new Promise<void>((r) => {
        speechSynthesis.onvoiceschanged = () => r();
        setTimeout(r, 500);
      });
      voices = load();
    }
    return voices;
  }

  speak(text: string, opts?: { signal?: AbortSignal; onLevel?: (l: number) => void }): Promise<void> {
    return new Promise((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = this.opts.rate ?? 1.02;
      u.volume = this.opts.volume ?? 1;
      u.pitch = this.opts.pitch ?? 0.95; // slightly low = calm/masculine default
      if (this.opts.voiceId) {
        const v = speechSynthesis.getVoices().find((x) => x.voiceURI === this.opts.voiceId);
        if (v) u.voice = v;
      }

      // Approximate a speaking level from boundary events for the visualiser.
      let pulse = 0;
      u.onboundary = () => {
        pulse = pulse > 0.5 ? 0.3 : 0.8;
        opts?.onLevel?.(pulse);
      };
      u.onend = () => {
        opts?.onLevel?.(0);
        resolve();
      };
      u.onerror = (e) => {
        opts?.onLevel?.(0);
        // A cancel (user interrupt / "BEV, stop") is not a failure.
        if (e.error === "canceled" || e.error === "interrupted") resolve();
        else reject(new Error(`tts: ${e.error}`));
      };

      opts?.signal?.addEventListener("abort", () => this.cancel(), { once: true });
      speechSynthesis.speak(u);
    });
  }

  cancel() {
    speechSynthesis.cancel();
  }
}
