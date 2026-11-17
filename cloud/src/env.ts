/** Bindings and secrets. Secrets are set by the deploy workflow from GitHub secrets. */
export interface Env {
  DB: D1Database;
  AI: Ai;
  TIMEZONE: string;

  /** Protects /admin and the desktop API. Also seeds the Telegram webhook secret. */
  ADMIN_KEY: string;
  TELEGRAM_BOT_TOKEN: string;

  AI_PROVIDER?: "anthropic" | "openai";
  AI_API_KEY: string;
  AI_MODEL?: string;

  /** Voice notes and phone calls in BEV's voice. Optional. */
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;

  /** Urgent phone calls. All optional; calls are off until they're set. */
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_PHONE_NUMBER?: string;
  MY_PHONE_NUMBER?: string;
  /** LLM the phone agent uses (ElevenLabs-hosted). */
  CALL_AGENT_LLM?: string;
}

export const DEFAULT_MODEL = { anthropic: "claude-sonnet-5-5", openai: "gpt-4.1-mini" } as const;

export function callsConfigured(env: Env): boolean {
  return Boolean(
    env.ELEVENLABS_API_KEY &&
      env.ELEVENLABS_VOICE_ID &&
      env.TWILIO_ACCOUNT_SID &&
      env.TWILIO_AUTH_TOKEN &&
      env.TWILIO_PHONE_NUMBER &&
      env.MY_PHONE_NUMBER
  );
}
