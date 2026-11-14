import { useCallback, useEffect, useRef, useState } from "react";
import { useSettings } from "@/state/settings";
import { MicInput } from "@/voice/wakeword";
import { WebSpeechSynthesizer } from "@/voice/webspeech";
import { native, OutputDevice } from "@/lib/native";
import { PageHeader, Section, Field, Select, Slider, Toggle, Button, TextInput, StatusPill } from "../components/Form";
import { useAssistant } from "@/state/assistant";
import { restartListening, getController } from "@/voice/bootstrap";
import { thresholdFor } from "@/voice/oww/pipeline";
import {
  loadWakeModel,
  saveWakeModel,
  clearWakeModel,
  toBase64,
  fromBase64,
  StoredWakeModel,
} from "@/voice/oww/model-store";
import type { OnDeviceWakeWord } from "@/voice/oww/engine";

export function VoiceAudio() {
  const { settings, update } = useSettings();
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  const [micErr, setMicErr] = useState<string | null>(null);
  const [voiceErr, setVoiceErr] = useState<string | null>(null);

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
      <PageHeader title="Voice & Audio" subtitle="Microphone, output device, wake word and BEV's voice." />

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

      <OutputDeviceSection />

      <WakeWordSection />

      <Section title="Conversation">
        <Field
          label="Wake-word sensitivity"
          hint="Higher catches quieter or less clear wake words, but risks false triggers from speakers. Applies to the on-device wake word."
        >
          <Slider
            ariaLabel="Wake sensitivity"
            min={0.1}
            max={1}
            step={0.05}
            value={settings.wakeSensitivity}
            onChange={(wakeSensitivity) => {
              update({ wakeSensitivity });
              getOnDevice()?.setThreshold(thresholdFor(wakeSensitivity));
            }}
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
        <Field label="Interface sounds" hint="A short chime when BEV wakes up and when it finishes.">
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
        {voiceErr && <p className="text-sm text-bev-danger">Voice failed: {voiceErr}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => native.openSettingsPage("speech").catch(() => {})}>
            Add voices
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              new WebSpeechSynthesizer({
                voiceId: settings.voiceId || undefined,
                rate: settings.speakRate,
                volume: settings.speakVolume,
              })
                .speak("Alright. Everything's running smoothly. What's the plan?")
                .then(() => setVoiceErr(null))
                .catch((e) => setVoiceErr(e instanceof Error ? e.message : String(e)))
            }
          >
            Test voice
          </Button>
        </div>
      </Section>
    </div>
  );
}

/**
 * Output picker. BEV speaks through the system speech engine, which always
 * plays to the Windows default device, so choosing a device here switches that
 * default. Windows stays the source of truth: nothing is stored in settings,
 * and the list follows changes made elsewhere (taskbar, plugging in a headset).
 */
function OutputDeviceSection() {
  const [outputs, setOutputs] = useState<OutputDevice[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setOutputs(await native.listOutputDevices());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    // Catch a default changed from the Windows taskbar while BEV was in the background.
    window.addEventListener("focus", refresh);
    return () => {
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  const current = outputs.find((o) => o.is_default)?.id ?? "";

  const choose = async (id: string) => {
    if (!id || id === current) return;
    setBusy(true);
    try {
      await native.setOutputDevice(id);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      // Re-read either way so the dropdown shows what Windows is really using.
      await refresh();
      setBusy(false);
    }
  };

  return (
    <Section title="Output">
      {err && <p className="text-sm text-bev-danger">Couldn't change output: {err}</p>}
      <Field
        label="Output device"
        hint="Where BEV's voice plays. This switches the Windows default output, so other apps' sound moves with it."
      >
        <Select
          ariaLabel="Output device"
          value={current}
          onChange={choose}
          disabled={busy || outputs.length === 0}
          options={
            outputs.length === 0
              ? [{ value: "", label: err ? "Unavailable" : "No output devices found" }]
              : [
                  ...(current ? [] : [{ value: "", label: "Choose a device…" }]),
                  ...outputs.map((o) => ({ value: o.id, label: o.name })),
                ]
          }
        />
      </Field>
    </Section>
  );
}

/** The live on-device engine, if that's what is listening (for live threshold changes). */
function getOnDevice(): OnDeviceWakeWord | null {
  const w = getController()?.wake;
  return w?.id === "openwakeword" ? (w as OnDeviceWakeWord) : null;
}

const TRAINING_GUIDE = "https://github.com/cbevss/BEV-assistant-app/blob/main/docs/WAKE_WORD.md";

/**
 * Wake word engine choice. "On-device" runs the user's trained openWakeWord
 * model locally; audio never leaves the PC. Speech recognition stays the
 * default, and the fallback whenever on-device isn't set up or fails.
 */
function WakeWordSection() {
  const { settings, update } = useSettings();
  const wake = useAssistant((s) => s.wake);
  const micEnabled = useAssistant((s) => s.micEnabled);
  const [model, setModel] = useState<StoredWakeModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadWakeModel().then(setModel);
  }, []);

  const chooseEngine = async (wakeEngine: "speech" | "on-device") => {
    await update({ wakeEngine });
    await restartListening();
  };

  const loadFile = async (file: File) => {
    setBusy(true);
    setMsg(null);
    try {
      if (!file.name.toLowerCase().endsWith(".onnx")) {
        throw new Error("Pick the .onnx file from the training notebook (not the .tflite).");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Open it once to be sure it's a valid openWakeWord model before saving.
      const { openRunner } = await import("@/voice/oww/engine");
      const runner = await openRunner(bytes);
      await runner.release();
      const stored = { name: file.name, base64: toBase64(bytes), addedAt: Date.now() };
      await saveWakeModel(stored);
      setModel(stored);
      setMsg({ ok: true, text: `Loaded ${file.name}.` });
      if (settings.wakeEngine === "on-device") await restartListening();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const remove = async () => {
    await clearWakeModel();
    setModel(null);
    setMsg(null);
    if (settings.wakeEngine === "on-device") await restartListening();
  };

  const live =
    !micEnabled || !wake
      ? { ok: null, label: "not listening" }
      : wake.engine === "on-device"
        ? { ok: true, label: "listening on-device" }
        : { ok: settings.wakeEngine === "speech" ? true : false, label: "listening via speech recognition" };

  return (
    <Section title="Wake word" aside={<StatusPill ok={live.ok} label={live.label} />}>
      <Field
        label="Engine"
        hint="Speech recognition works with no setup. On-device runs your own “hey BEV” model on this PC, so audio never leaves it."
      >
        <Select
          ariaLabel="Wake word engine"
          value={settings.wakeEngine}
          onChange={chooseEngine}
          options={[
            { value: "speech", label: "Speech recognition (default)" },
            { value: "on-device", label: "On-device (openWakeWord)" },
          ]}
        />
      </Field>
      {wake?.note && <p className="text-sm text-amber-400">{wake.note}</p>}

      {settings.wakeEngine === "on-device" && (
        <>
          <Field
            label="Wake word model"
            hint={
              model
                ? `${model.name}, added ${new Date(model.addedAt).toLocaleDateString("en-GB")}.`
                : "No model loaded yet. Train one with the guide, then load the .onnx file here."
            }
          >
            <div className="flex justify-end gap-2">
              <input
                ref={fileRef}
                type="file"
                accept=".onnx"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])}
              />
              <Button variant="ghost" onClick={() =>
                  import("@tauri-apps/plugin-shell")
                    .then(({ open }) => open(TRAINING_GUIDE))
                    .catch(() => {})
                }>
                Training guide
              </Button>
              {model && (
                <Button variant="danger" onClick={remove} disabled={busy}>
                  Remove
                </Button>
              )}
              <Button onClick={() => fileRef.current?.click()} disabled={busy}>
                {busy ? "Checking…" : model ? "Replace" : "Load model"}
              </Button>
            </div>
          </Field>
          {msg && <p className={`text-sm ${msg.ok ? "text-bev-ok" : "text-bev-danger"}`}>{msg.text}</p>}
          {model && <WakeTest model={model} deviceId={settings.micDeviceId} sensitivity={settings.wakeSensitivity} />}
        </>
      )}
    </Section>
  );
}

/**
 * Live score meter for the loaded model, so the user can see how strongly
 * "hey BEV" registers and tune sensitivity. Runs its own engine instance.
 */
function WakeTest({ model, deviceId, sensitivity }: { model: StoredWakeModel; deviceId: string; sensitivity: number }) {
  const [on, setOn] = useState(false);
  const [score, setScore] = useState(0);
  const [hits, setHits] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const threshold = thresholdFor(sensitivity);
  const engine = useRef<OnDeviceWakeWord | null>(null);

  useEffect(() => {
    engine.current?.setThreshold(threshold);
  }, [threshold]);

  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    (async () => {
      try {
        const { OnDeviceWakeWord } = await import("@/voice/oww/engine");
        const e = new OnDeviceWakeWord({ model: fromBase64(model.base64), deviceId: deviceId || undefined, threshold });
        engine.current = e;
        e.onScore((s) => !cancelled && setScore(s));
        e.onFatal = (m) => setErr(m);
        await e.start(() => {
          setHits((h) => h + 1);
          // Keep testing after a detection.
          setTimeout(() => e.resumeListening(), 300);
        });
        if (cancelled) e.stop();
        setErr(null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        setOn(false);
      }
    })();
    return () => {
      cancelled = true;
      engine.current?.stop();
      engine.current = null;
      setScore(0);
    };
    // threshold changes are applied live above; don't restart for them
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, model, deviceId]);

  return (
    <Field
      label="Test wake word"
      hint={err ?? `Say “hey BEV”. Detections: ${hits}. Trigger point ${Math.round(threshold * 100)}%.`}
    >
      <div className="flex items-center gap-3">
        <div className="relative h-2 flex-1 overflow-hidden rounded bg-white/5">
          <div
            className={`h-full rounded transition-[width] duration-75 ${score >= threshold ? "bg-bev-ok" : "bg-gradient-to-r from-bev-cyan to-bev-violet"}`}
            style={{ width: `${Math.round(score * 100)}%` }}
          />
          <div className="absolute top-0 h-full w-0.5 bg-white/60" style={{ left: `${threshold * 100}%` }} />
        </div>
        <Button variant="ghost" onClick={() => setOn((v) => !v)}>
          {on ? "Stop" : "Test"}
        </Button>
      </div>
    </Field>
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
