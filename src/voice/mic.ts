/**
 * Microphone management: which mic BEV records from, what Windows thinks of
 * it (default? muted? level?), and what to do when devices come and go.
 *
 * The webview and Windows name devices separately, so they're matched by
 * label. Pure helpers are exported for tests.
 */
import { invoke } from "@tauri-apps/api/core";

export interface WinInput {
  id: string;
  name: string;
  is_default: boolean;
  muted: boolean | null;
  volume: number | null;
}

export const winMics = {
  list: () => invoke<WinInput[]>("list_input_devices"),
  setDefault: (id: string) => invoke<void>("set_default_input_device", { id }),
  setLevel: (id: string, volume?: number, muted?: boolean) => invoke<void>("set_input_device_level", { id, volume, muted }),
};

/** "Default - Microphone (Realtek(R) Audio) (0bda:0567)" → "microphone (realtek(r) audio)". */
export function normaliseLabel(label: string): string {
  return label
    .replace(/^(default|communications)\s*-\s*/i, "")
    .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "")
    .trim()
    .toLowerCase();
}

/** The Windows endpoint for a webview mic label. */
export function matchEndpoint(label: string, endpoints: WinInput[]): WinInput | undefined {
  const n = normaliseLabel(label);
  if (!n) return undefined;
  return (
    endpoints.find((e) => normaliseLabel(e.name) === n) ??
    endpoints.find((e) => {
      const en = normaliseLabel(e.name);
      return en.includes(n) || n.includes(en);
    })
  );
}

export interface EffectiveMic {
  /** deviceId to pass to getUserMedia ("" = system default). */
  deviceId: string;
  label: string;
  /** The chosen mic isn't connected, so the default is used instead. */
  fallback: boolean;
}

/** Which mic to actually use, given the preference and what's connected. */
export function effectiveMic(preferredId: string, devices: Pick<MediaDeviceInfo, "deviceId" | "label">[]): EffectiveMic {
  const real = devices.filter((d) => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications");
  const def = devices.find((d) => d.deviceId === "default");
  const defaultLabel = normaliseLabel(def?.label ?? real[0]?.label ?? "") || "the system default";
  if (!preferredId) return { deviceId: "", label: defaultLabel, fallback: false };
  const chosen = real.find((d) => d.deviceId === preferredId);
  return chosen ? { deviceId: chosen.deviceId, label: chosen.label, fallback: false } : { deviceId: "", label: defaultLabel, fallback: true };
}

export type MicProblem =
  | { kind: "blocked"; message: string }
  | { kind: "missing"; message: string }
  | { kind: "busy"; message: string }
  | { kind: "muted"; message: string; endpoint: WinInput }
  | { kind: "low_level"; message: string; endpoint: WinInput }
  | { kind: "not_default"; message: string; endpoint: WinInput };

/** A getUserMedia failure in plain words. */
export function micErrorProblem(e: unknown): MicProblem {
  const name = e instanceof DOMException || e instanceof Error ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return {
      kind: "blocked",
      message:
        "Windows is blocking the microphone. Open Settings → Privacy & security → Microphone and turn on “Let desktop apps access your microphone”.",
    };
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return { kind: "missing", message: "No microphone found. Plug one in, or pick another in Voice & Audio." };
  if (name === "NotReadableError" || name === "AbortError")
    return { kind: "busy", message: "The microphone couldn't be opened: another app may be using it exclusively, or its driver failed." };
  return { kind: "missing", message: `The microphone couldn't be used (${e instanceof Error ? e.message : String(e)}).` };
}

/**
 * Problems Windows can tell us about the mic BEV uses: muted, level very low,
 * or (when speech recognition is the Windows engine) not the default device,
 * which that engine always records from.
 */
export function endpointProblems(label: string, endpoints: WinInput[], recognizerUsesDefault: boolean): MicProblem[] {
  const ep = matchEndpoint(label, endpoints) ?? endpoints.find((e) => e.is_default);
  if (!ep) return [];
  const out: MicProblem[] = [];
  if (ep.muted) out.push({ kind: "muted", message: `“${ep.name}” is muted in Windows.`, endpoint: ep });
  if (ep.volume !== null && ep.volume < 0.3)
    out.push({ kind: "low_level", message: `“${ep.name}” is set to ${Math.round(ep.volume * 100)}% in Windows, which is usually too quiet for speech recognition.`, endpoint: ep });
  if (recognizerUsesDefault && !ep.is_default) {
    const def = endpoints.find((e) => e.is_default);
    out.push({
      kind: "not_default",
      message: `Windows speech recognition always listens through the Windows default mic${def ? ` (“${def.name}”)` : ""}, not “${ep.name}”, so BEV hears your requests through a different mic than its wake word.`,
      endpoint: ep,
    });
  }
  return out;
}

/** Calls `onChange` when microphones are plugged in or removed. */
export function watchMics(onChange: (devices: MediaDeviceInfo[]) => void): () => void {
  const md = navigator.mediaDevices;
  if (!md?.addEventListener) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const handler = () => {
    // Windows fires several events per plug; settle first.
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const all = await md.enumerateDevices().catch(() => []);
      onChange(all.filter((d) => d.kind === "audioinput"));
    }, 600);
  };
  md.addEventListener("devicechange", handler);
  return () => {
    clearTimeout(timer);
    md.removeEventListener("devicechange", handler);
  };
}
