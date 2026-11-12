import { useEffect, useRef, useState } from "react";
import { useSettings } from "@/state/settings";
import { MicInput } from "@/voice/wakeword";
import { WebSpeechSynthesizer } from "@/voice/webspeech";
import { PageHeader, Section, Field, Select, Slider, Toggle, Button, TextInput } from "../components/Form";

export function VoiceAudio() {
  const { settings, update } = useSettings();
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  const [micErr, setMicErr] = useState<string | null>(null);

  useEffect(() => {
    const refresh = async () => {
      try {
        // Labels are only exposed after a permission grant; request briefly.
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
        const all = await navigator.mediaDevices.enumerateDevices();
        setMics(all.filter((d) => d.kind === "audioinput"));
        setMicErr(null);
      } catch (e) {
        setMicErr(e instanceof Error ? e.message : String(e));
      }
    };
    refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    new WebSpeechSynthesizer().listVoices().then(setVoices).catch(() => setVoices([]));
    return () => navigator.mediaDevices.removeEventListener("devicechange", refresh);
  }, []);

  return (
    <div>
      <PageHeader title="Voice & Audio" subtitle="Microphone, wake word and BEV's voice." />

      <Section title="Microphone">
        {micErr && <p className="text-sm text-bev-danger">Microphone unavailable: {micErr}</p>}
        <Field label="Input device" hint="BEV reconnects automatically if the device is unplugged and returns.">
          <Select
            ariaLabel="Microphone"
            value={settings.micDeviceId}
            onChange={(micDeviceId) => update({ micDeviceId })}
            options={[
              { value: "", label: "System default" },
              ...mics.map((m, i) => ({ value: m.deviceId, label: m.label || `Microphone ${i + 1}` })),
            ]}
          />
        </Field>
        <MicTest deviceId={settings.micDeviceId} />
      </Section>

      <Section title="Wake word & conversation">
        <Field label="Wake-word sensitivity" hint="Higher catches quieter speech but risks false triggers from speakers.">
          <Slider
            ariaLabel="Wake sensitivity"
            min={0.1}
            max={1}
            step={0.05}
            value={settings.wakeSensitivity}
            onChange={(wakeSensitivity) => update({ wakeSensitivity })}
            format={(v) => `${Math.round(v * 100)}%`}
          />
        </Field>
        <Field label="Follow-up window" hint="How long BEV keeps listening after replying, so you don't need to say 'BEV' again.">
          <Slider
            ariaLabel="Conversation timeout"
            min={3000}
            max={20000}
            step={500}
            value={settings.conversationTimeoutMs}
            onChange={(conversationTimeoutMs) => update({ conversationTimeoutMs })}
            format={(v) => `${(v / 1000).toFixed(1)}s`}
          />
        </Field>
        <Field label="Push-to-talk shortcut" hint="Applied on next launch. Tauri accelerator format.">
          <TextInput
            value={settings.pushToTalkShortcut}
            onChange={(e) => update({ pushToTalkShortcut: e.target.value })}
          />
        </Field>
        <Field label="Interface sounds">
          <Toggle label="Interface sounds" checked={settings.interfaceSounds} onChange={(interfaceSounds) => update({ interfaceSounds })} />
        </Field>
      </Section>

      <Section title="BEV's voice">
        <Field label="Voice" hint="Windows neural voices appear here when installed (Settings → Time & language → Speech).">
          <Select
            ariaLabel="Voice"
            value={settings.voiceId}
            onChange={(voiceId) => update({ voiceId })}
            options={[{ value: "", label: "Default" }, ...voices.map((v) => ({ value: v.id, label: v.name }))]}
          />
        </Field>
        <Field label="Speaking speed">
          <Slider ariaLabel="Speed" min={0.6} max={1.6} step={0.02} value={settings.speakRate} onChange={(speakRate) => update({ speakRate })} format={(v) => `${v.toFixed(2)}×`} />
        </Field>
        <Field label="Voice volume">
          <Slider ariaLabel="Voice volume" min={0} max={1} step={0.05} value={settings.speakVolume} onChange={(speakVolume) => update({ speakVolume })} format={(v) => `${Math.round(v * 100)}%`} />
        </Field>
        <div className="flex justify-end">
          <Button
            variant="ghost"
            onClick={() =>
              new WebSpeechSynthesizer({
                voiceId: settings.voiceId || undefined,
                rate: settings.speakRate,
                volume: settings.speakVolume,
              })
                .speak("Alright. Everything's running smoothly. What's the plan?")
                .catch(() => {})
            }
          >
            Test voice
          </Button>
        </div>
      </Section>
    </div>
  );
}

/** Live meter from the real mic so the user can confirm input works. */
function MicTest({ deviceId }: { deviceId: string }) {
  const [on, setOn] = useState(false);
  const [level, setLevel] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const mic = useRef<MicInput | null>(null);

  useEffect(() => {
    if (!on) return;
    const m = new MicInput();
    mic.current = m;
    m.onLevel(setLevel);
    m.start(deviceId || undefined).catch((e) => {
      setErr(String(e));
      setOn(false);
    });
    return () => {
      m.stop();
      setLevel(0);
    };
  }, [on, deviceId]);

  return (
    <Field label="Test input" hint={err ?? "Speak — the bar should move."}>
      <div className="flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded bg-white/5">
          <div
            className="h-full rounded bg-gradient-to-r from-bev-cyan to-bev-violet transition-[width] duration-75"
            style={{ width: `${Math.round(level * 100)}%` }}
          />
        </div>
        <Button variant="ghost" onClick={() => setOn((v) => !v)}>
          {on ? "Stop" : "Test"}
        </Button>
      </div>
    </Field>
  );
}
