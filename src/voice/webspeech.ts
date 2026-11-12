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

export class WebSpeechRecognizer implements SpeechRecognizer {
  readonly id = "webspeech";
  constructor(private lang = "en-GB") {}

  listenOnce(opts: { signal?: AbortSignal; onPartial?: (t: string) => void }): Promise<string> {
    const w = window as SR;
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return Promise.reject(new Error("SpeechRecognition unavailable in this runtime"));

    return new Promise((resolve, reject) => {
      const rec = new Ctor();
      rec.lang = this.lang;
      rec.continuous = false;
      rec.interimResults = true;
      let finalText = "";

      rec.onresult = (e) => {
        let interim = "";
        for (let i = 0; i < e.results.length; i++) {
          const r = e.results[i];
          const txt = r[0].transcript;
          if (r.isFinal) finalText += txt;
          else interim += txt;
        }
        opts.onPartial?.(finalText + interim);
      };
      rec.onerror = (e) => reject(new Error(`stt: ${e.error}`));
      rec.onend = () => resolve(finalText.trim());

      opts.signal?.addEventListener("abort", () => rec.abort(), { once: true });
      rec.start();
    });
  }
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
