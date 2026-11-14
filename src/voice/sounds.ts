import { useSettings } from "@/state/settings";

/**
 * Short interface chimes (Voice & Audio → Interface sounds), synthesised with
 * Web Audio so there are no sound files to ship. They play on the Windows
 * default output, like BEV's voice.
 */
let ctx: AudioContext | null = null;

function tone(freq: number, startAt: number, duration: number, gain = 0.08) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  amp.gain.setValueAtTime(0, startAt);
  amp.gain.linearRampToValueAtTime(gain, startAt + 0.01);
  amp.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(amp).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

export function playChime(kind: "wake" | "done") {
  if (!useSettings.getState().settings.interfaceSounds) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const t = ctx.currentTime + 0.01;
    if (kind === "wake") {
      tone(660, t, 0.12);
      tone(880, t + 0.09, 0.16);
    } else {
      tone(880, t, 0.1);
      tone(660, t + 0.08, 0.14);
    }
  } catch {
    /* audio unavailable: chimes are optional */
  }
}
