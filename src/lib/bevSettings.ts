/**
 * BEV's own settings it may change when asked ("talk slower", "call me
 * Charlie", "turn off screen time"). A fixed list: anything to do with
 * security, accounts or phone control isn't here and stays in Settings.
 */
import type { Settings } from "@/state/settings";

type Def = { label: string; describe: (s: Settings) => string; apply: (s: Settings, v: string) => Partial<Settings> };

const onOff = (v: string): boolean => {
  const t = v.trim().toLowerCase();
  if (/^(on|true|yes|enable|enabled|1)$/.test(t)) return true;
  if (/^(off|false|no|disable|disabled|0)$/.test(t)) return false;
  throw new Error('say "on" or "off"');
};
const bool = (key: keyof Settings, label: string): Def => ({
  label,
  describe: (s) => (s[key] ? "on" : "off"),
  apply: (_s, v) => ({ [key]: onOff(v) }) as Partial<Settings>,
});

/** "faster", "slower", "1.2", "normal" → a new speech rate. */
export function nextRate(cur: number, v: string): number {
  const t = v.trim().toLowerCase();
  const r = t === "faster" ? cur + 0.15 : t === "slower" ? cur - 0.15 : t === "normal" || t === "default" ? 1.02 : Number(t.replace(/x$/, ""));
  if (!Number.isFinite(r)) throw new Error('say "faster", "slower", "normal" or a speed like 1.2');
  return Math.round(Math.min(1.8, Math.max(0.6, r)) * 100) / 100;
}

/** "louder", "quieter", "60" (percent) → a new volume 0..1. */
export function nextVolume(cur: number, v: string): number {
  const t = v.trim().toLowerCase().replace(/%$/, "");
  const r = t === "louder" ? cur + 0.15 : t === "quieter" || t === "softer" ? cur - 0.15 : t === "max" ? 1 : Number(t) / (Number(t) > 1 ? 100 : 1);
  if (!Number.isFinite(r)) throw new Error('say "louder", "quieter" or a percentage');
  return Math.round(Math.min(1, Math.max(0.1, r)) * 100) / 100;
}

export const BEV_SETTINGS: Record<string, Def> = {
  speech_speed: { label: "how fast BEV talks", describe: (s) => `${s.speakRate}x`, apply: (s, v) => ({ speakRate: nextRate(s.speakRate, v) }) },
  speech_volume: { label: "how loud BEV talks", describe: (s) => `${Math.round(s.speakVolume * 100)}%`, apply: (s, v) => ({ speakVolume: nextVolume(s.speakVolume, v) }) },
  call_me: { label: "what BEV calls you", describe: (s) => (s.addressAs ? `"${s.addressAs}"` : "nothing"), apply: (_s, v) => ({ addressAs: /^(nothing|none|no one|off)$/i.test(v.trim()) ? "" : v.trim().slice(0, 30) }) },
  follow_up: {
    label: "listening for a reply after BEV speaks",
    describe: (s) => s.followUpMode,
    apply: (_s, v) => {
      const t = v.trim().toLowerCase();
      if (t !== "smart" && t !== "always" && t !== "off") throw new Error('follow_up is "smart", "always" or "off"');
      return { followUpMode: t };
    },
  },
  interface_sounds: bool("interfaceSounds", "chimes and sounds"),
  auto_gaming_mode: bool("autoGamingMode", "going quiet when a game starts"),
  quiet_mode: bool("gamingQuietMode", "quiet mode"),
  screen_time: bool("screenTime", "screen time tracking"),
  proactive: bool("proactiveMonitoring", "BEV keeping an eye on the PC"),
  stream_replies: bool("streamReplies", "speaking while still writing"),
  learn_tasks: bool("learnTasks", "learning tasks"),
  quiet_actions: bool("quietActions", "short confirmations instead of describing what I did"),
  reduced_motion: bool("reducedMotion", "reduced animations"),
  home_town: { label: "home town for weather", describe: (s) => s.homePlace || "not set", apply: (_s, v) => ({ homePlace: v.trim().slice(0, 60) }) },
};

export const describeAll = (s: Settings) =>
  Object.entries(BEV_SETTINGS)
    .map(([k, d]) => `${k} (${d.label}): ${d.describe(s)}`)
    .join("\n");
