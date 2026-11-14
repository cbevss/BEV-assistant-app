import type { SpeechSynthesizer } from "../types";
import { speakChunked } from "./player";

const API = "https://api.elevenlabs.io/v1";
/** Flash: lowest latency, and half a credit per character, so the free plan lasts twice as long. */
export const ELEVEN_MODEL = "eleven_flash_v2_5";

/** Why ElevenLabs can't be used right now; drives the automatic fallback. */
export class ElevenLabsUnavailable extends Error {
  constructor(
    readonly reason: "quota" | "auth" | "rate" | "network",
    message: string
  ) {
    super(message);
  }
}

export interface ElevenVoice {
  id: string;
  name: string;
  /** e.g. "british · male · calm" from the voice's labels. */
  description: string;
}

export interface ElevenUsage {
  used: number;
  limit: number;
  tier: string;
  resetsAt: Date | null;
}

async function call(key: string, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      signal,
      headers: { "xi-api-key": key, ...(init.headers ?? {}) },
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ElevenLabsUnavailable("network", "Couldn't reach ElevenLabs. Check your internet connection.");
  }
  if (res.ok) return res;

  // Error bodies look like {"detail":{"status":"quota_exceeded","message":"…"}}.
  let status = "";
  let message = `ElevenLabs error ${res.status}`;
  try {
    const body = await res.json();
    status = body?.detail?.status ?? body?.detail?.code ?? "";
    message = body?.detail?.message ?? (typeof body?.detail === "string" ? body.detail : message);
  } catch {
    /* not JSON */
  }
  if (status === "quota_exceeded" || res.status === 402) {
    throw new ElevenLabsUnavailable("quota", "Your ElevenLabs credits for this month are used up.");
  }
  if (res.status === 401 || res.status === 403 || status === "invalid_api_key") {
    throw new ElevenLabsUnavailable(
      "auth",
      status === "missing_permissions"
        ? "This ElevenLabs API key doesn't have the permission needed. Create a key with Text to Speech (and Voices: read) access."
        : "ElevenLabs rejected the API key. Check it in Voice & Audio."
    );
  }
  if (res.status === 429) throw new ElevenLabsUnavailable("rate", "ElevenLabs is busy (too many requests). Try again shortly.");
  throw new Error(message);
}

/** The voices this key can use (your account's voices plus ElevenLabs' defaults). */
export async function listElevenVoices(key: string): Promise<ElevenVoice[]> {
  const res = await call(key, "/voices");
  const body = (await res.json()) as {
    voices: { voice_id: string; name: string; labels?: Record<string, string>; category?: string }[];
  };
  const order = (v: { labels?: Record<string, string> }) => (/brit/i.test(v.labels?.accent ?? "") ? 0 : 1);
  return body.voices
    .slice()
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
    .map((v) => ({
      id: v.voice_id,
      name: v.name,
      description: [v.labels?.accent, v.labels?.gender, v.labels?.description ?? v.labels?.descriptive, v.labels?.age]
        .filter(Boolean)
        .join(" · "),
    }));
}

/** Credits used this month. Needs a key with "User: read"; returns null otherwise. */
export async function elevenUsage(key: string): Promise<ElevenUsage | null> {
  try {
    const res = await call(key, "/user/subscription");
    const s = (await res.json()) as {
      character_count: number;
      character_limit: number;
      tier: string;
      next_character_count_reset_unix?: number;
    };
    return {
      used: s.character_count,
      limit: s.character_limit,
      tier: s.tier,
      resetsAt: s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000) : null,
    };
  } catch {
    return null;
  }
}

export class ElevenLabsSynthesizer implements SpeechSynthesizer {
  readonly id = "elevenlabs";
  private ctl: AbortController | null = null;

  constructor(private opts: { apiKey: string; voiceId: string; rate?: number; volume?: number }) {}

  async listVoices() {
    return (await listElevenVoices(this.opts.apiKey)).map((v) => ({ id: v.id, name: v.name }));
  }

  async speak(text: string, opts?: { signal?: AbortSignal; onLevel?: (l: number) => void }) {
    if (!this.opts.apiKey) throw new ElevenLabsUnavailable("auth", "No ElevenLabs API key saved.");
    if (!this.opts.voiceId) throw new ElevenLabsUnavailable("auth", "No ElevenLabs voice chosen.");
    this.ctl?.abort();
    const ctl = (this.ctl = new AbortController());
    opts?.signal?.addEventListener("abort", () => ctl.abort(), { once: true });
    // ElevenLabs accepts speed 0.7–1.2.
    const speed = Math.min(1.2, Math.max(0.7, this.opts.rate ?? 1));
    await speakChunked(
      text,
      async (chunk, signal) => {
        const res = await call(
          this.opts.apiKey,
          `/text-to-speech/${encodeURIComponent(this.opts.voiceId)}?output_format=mp3_44100_128`,
          {
            method: "POST",
            headers: { "content-type": "application/json", accept: "audio/mpeg" },
            body: JSON.stringify({
              text: chunk,
              model_id: ELEVEN_MODEL,
              voice_settings: { stability: 0.5, similarity_boost: 0.75, speed },
            }),
          },
          signal
        );
        return { encoded: await res.arrayBuffer() };
      },
      { signal: ctl.signal, onLevel: opts?.onLevel, volume: this.opts.volume }
    );
  }

  cancel() {
    this.ctl?.abort();
  }
}
