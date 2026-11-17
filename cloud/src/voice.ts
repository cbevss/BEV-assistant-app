/** BEV's voice (ElevenLabs) and hearing (Workers AI Whisper, free tier). */
import type { Env } from "./env";

/** Longest reply read aloud; longer ones are text only (saves voice credits). */
export const MAX_SPOKEN_CHARS = 700;

export async function speak(env: Env, text: string, fetcher: typeof fetch = fetch): Promise<ArrayBuffer | null> {
  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID || !text || text.length > MAX_SPOKEN_CHARS) return null;
  const res = await fetcher(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(env.ELEVENLABS_VOICE_ID)}?output_format=mp3_44100_64`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": env.ELEVENLABS_API_KEY, accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
    }
  );
  if (!res.ok) {
    // Voice is a nice-to-have: out of credits shouldn't stop the message.
    console.warn("elevenlabs tts", res.status, (await res.text().catch(() => "")).slice(0, 200));
    return null;
  }
  return res.arrayBuffer();
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Telegram voice note (OGG/Opus) → text. */
export async function transcribe(env: Env, audio: ArrayBuffer): Promise<string> {
  try {
    const r = (await env.AI.run("@cf/openai/whisper-large-v3-turbo" as never, {
      audio: toBase64(audio),
      language: "en",
    } as never)) as { text?: string };
    if (r?.text?.trim()) return r.text.trim();
  } catch (e) {
    console.warn("whisper-large-v3-turbo failed, trying whisper", e);
  }
  const r = (await env.AI.run("@cf/openai/whisper" as never, { audio: [...new Uint8Array(audio)] } as never)) as {
    text?: string;
  };
  return (r?.text ?? "").trim();
}
