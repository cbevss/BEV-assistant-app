import { useCallback, useEffect, useRef, useState } from "react";
import { useSettings } from "@/state/settings";
import { MicInput } from "@/voice/wakeword";
import { WebSpeechSynthesizer } from "@/voice/webspeech";
import { ChainSynthesizer, ELEVEN_SECRET, resetVoiceFallbacks, type TtsEngine } from "@/voice/tts";
import {
  KOKORO_VOICES,
  kokoroStatus,
  onKokoroStatus,
  preloadKokoro,
  kokoroGpuProblem,
  resetKokoroGpu,
  setKokoroGpu,
  type KokoroStatus,
} from "@/voice/tts/kokoro";
import { listElevenVoices, elevenUsage, type ElevenVoice, type ElevenUsage } from "@/voice/tts/elevenlabs";
import { native, OutputDevice } from "@/lib/native";
import { PageHeader, Section, Field, Select, Slider, Toggle, Button, TextInput, StatusPill } from "../components/Form";
import { useAssistant } from "@/state/assistant";
import { restartListening, getController } from "@/voice/bootstrap";
import { thresholdFor } from "@/voice/oww/pipeline";
import {
  loadWakeModels,
  addWakeModel,
  removeWakeModel,
  phraseFromFile,
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

      <VoiceSection voices={voices} />
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

const TEST_LINE = "Alright. Everything's running smoothly. What's the plan?";
const ELEVEN_KEYS_PAGE = "https://elevenlabs.io/app/settings/api-keys";

const openLink = (url: string) =>
  import("@tauri-apps/plugin-shell").then(({ open }) => open(url)).catch(() => {});

/**
 * BEV's voice: Windows (built-in), Kokoro (free, natural, runs on this PC) or
 * ElevenLabs (most natural, uses credits). Whatever is chosen falls back down
 * that list automatically, so BEV never goes silent.
 */
function VoiceSection({ voices }: { voices: { id: string; name: string }[] }) {
  const { settings, update } = useSettings();
  const voiceNote = useAssistant((s) => s.voiceNote);
  const [testErr, setTestErr] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const change = async (patch: Parameters<typeof update>[0]) => {
    await update(patch);
    resetVoiceFallbacks(); // give a fixed key/voice a fresh chance
    useAssistant.getState().setVoiceNote(null);
  };

  const test = async () => {
    setTesting(true);
    setTestErr(null);
    useAssistant.getState().setVoiceNote(null);
    try {
      await new ChainSynthesizer(
        useSettings.getState().settings,
        () => native.getSecret(ELEVEN_SECRET),
        (n) => useAssistant.getState().setVoiceNote(n.text)
      ).speak(TEST_LINE);
    } catch (e) {
      setTestErr(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Section title="BEV's voice">
      <Field label="Voice engine" hint="If the chosen one isn't available, BEV falls back to the next: ElevenLabs → free voice → Windows.">
        <Select<TtsEngine>
          ariaLabel="Voice engine"
          value={settings.ttsEngine}
          onChange={(ttsEngine) => {
            change({ ttsEngine });
            if (ttsEngine === "kokoro") {
              setKokoroGpu(useSettings.getState().settings.kokoroUseGpu);
              preloadKokoro().catch(() => {});
            }
          }}
          options={[
            { value: "kokoro", label: "Natural, free, on this PC (Kokoro)" },
            { value: "elevenlabs", label: "ElevenLabs (most natural, uses credits)" },
            { value: "windows", label: "Windows voices (built-in)" },
          ]}
        />
      </Field>

      {settings.ttsEngine === "kokoro" && <KokoroOptions onChange={change} />}
      {settings.ttsEngine === "elevenlabs" && <ElevenLabsOptions onChange={change} />}
      {settings.ttsEngine === "windows" && (
        <Field label="Voice" hint="Windows neural voices appear here when installed (Settings → Time & language → Speech).">
          <div className="flex gap-2">
            <Select
              ariaLabel="Windows voice"
              value={settings.voiceId}
              onChange={(voiceId) => change({ voiceId })}
              options={[{ value: "", label: "Default" }, ...voices.map((v) => ({ value: v.id, label: v.name }))]}
            />
            <Button variant="ghost" onClick={() => native.openSettingsPage("speech").catch(() => {})}>
              Add voices
            </Button>
          </div>
        </Field>
      )}

      <Field label="Speaking speed" hint={settings.ttsEngine === "elevenlabs" ? "ElevenLabs supports 0.7× to 1.2×." : undefined}>
        <Slider ariaLabel="Speed" min={0.6} max={1.6} step={0.02} value={settings.speakRate} onChange={(speakRate) => update({ speakRate })} format={(v) => `${v.toFixed(2)}×`} />
      </Field>
      <Field label="Voice volume">
        <Slider ariaLabel="Voice volume" min={0} max={1} step={0.05} value={settings.speakVolume} onChange={(speakVolume) => update({ speakVolume })} format={(v) => `${Math.round(v * 100)}%`} />
      </Field>
      {voiceNote && <p className="text-sm text-amber-400">{voiceNote}</p>}
      {testErr && <p className="text-sm text-bev-danger">Voice failed: {testErr}</p>}
      <div className="flex justify-end">
        <Button variant="ghost" onClick={test} disabled={testing}>
          {testing ? "Speaking…" : "Test voice"}
        </Button>
      </div>
    </Section>
  );
}

function useKokoroStatus(): KokoroStatus {
  const [st, setSt] = useState<KokoroStatus>(kokoroStatus());
  useEffect(() => onKokoroStatus(setSt), []);
  return st;
}

function KokoroOptions({ onChange }: { onChange: (p: Partial<ReturnType<typeof useSettings.getState>["settings"]>) => Promise<void> }) {
  const settings = useSettings((s) => s.settings);
  const st = useKokoroStatus();
  const [gpuProblem, setGpuProblem] = useState(kokoroGpuProblem());
  useEffect(() => setGpuProblem(kokoroGpuProblem()), [st]);

  const statusText =
    st.state === "ready"
      ? st.device === "webgpu"
        ? "Ready, running on your graphics card."
        : "Ready, running on the processor."
      : st.state === "downloading"
        ? `Downloading the voice model… ${st.percent}% (one-time; ${settings.kokoroUseGpu && !gpuProblem ? "up to 310" : "88"} MB)`
        : st.state === "error"
          ? `Couldn't load: ${st.message}`
          : "Not downloaded yet. It downloads once, then works offline.";

  return (
    <>
      <Field label="Voice" hint="British and American voices. George and Emma are good places to start.">
        <Select
          ariaLabel="Kokoro voice"
          value={settings.kokoroVoice}
          onChange={(kokoroVoice) => onChange({ kokoroVoice })}
          options={KOKORO_VOICES.map((v) => ({ value: v.id, label: v.name }))}
        />
      </Field>
      <Field label="Voice model" hint={statusText}>
        <div className="flex justify-end">
          {(st.state === "idle" || st.state === "error") && (
            <Button onClick={() => preloadKokoro().catch(() => {})}>Download now</Button>
          )}
        </div>
      </Field>
      <Field
        label="Use graphics card"
        hint={
          gpuProblem
            ? `Turned off automatically after a problem (${gpuProblem}). Using the processor.`
            : "Much faster replies. Turn off if you see glitches or crashes."
        }
      >
        <div className="flex items-center justify-end gap-2">
          {gpuProblem && (
            <Button
              variant="ghost"
              onClick={() => {
                resetKokoroGpu();
                setGpuProblem(null);
              }}
            >
              Try again
            </Button>
          )}
          <Toggle
            checked={settings.kokoroUseGpu && !gpuProblem}
            onChange={(kokoroUseGpu) => {
              setKokoroGpu(kokoroUseGpu);
              onChange({ kokoroUseGpu });
            }}
          />
        </div>
      </Field>
    </>
  );
}

function ElevenLabsOptions({ onChange }: { onChange: (p: Partial<ReturnType<typeof useSettings.getState>["settings"]>) => Promise<void> }) {
  const settings = useSettings((s) => s.settings);
  const [key, setKey] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [voices, setVoices] = useState<ElevenVoice[]>([]);
  const [usage, setUsage] = useState<ElevenUsage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (k: string | null) => {
    setErr(null);
    if (!k) {
      setVoices([]);
      setUsage(null);
      return;
    }
    try {
      const [v, u] = await Promise.all([listElevenVoices(k), elevenUsage(k)]);
      setVoices(v);
      setUsage(u);
      // First time: pick a British voice if there is one, so it speaks straight away.
      const s = useSettings.getState().settings;
      if (!s.elevenVoiceId && v[0]) onChange({ elevenVoiceId: v[0].id, elevenVoiceName: v[0].name });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [onChange]);

  useEffect(() => {
    native
      .getSecret(ELEVEN_SECRET)
      .then((k) => {
        setKey(k);
        load(k);
      })
      .catch(() => setKey(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    const k = keyInput.trim();
    if (!k) return;
    setBusy(true);
    try {
      await listElevenVoices(k); // check it works before saving
      await native.storeSecret(ELEVEN_SECRET, k);
      setKey(k);
      setKeyInput("");
      resetVoiceFallbacks();
      await load(k);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await native.deleteSecret(ELEVEN_SECRET).catch(() => {});
    setKey(null);
    load(null);
  };

  const fmt = (n: number) => n.toLocaleString("en-GB");

  return (
    <>
      <Field
        label="API key"
        hint={key ? "Saved in Windows Credential Manager." : "Free at elevenlabs.io: Developers → API Keys. Give it Text to Speech and Voices (read) access."}
      >
        <div className="flex gap-2">
          {key ? (
            <Button variant="danger" onClick={remove}>
              Remove key
            </Button>
          ) : (
            <>
              <TextInput type="password" placeholder="paste API key" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
              <Button variant="ghost" onClick={() => openLink(ELEVEN_KEYS_PAGE)}>
                Get a key
              </Button>
              <Button onClick={save} disabled={busy || !keyInput.trim()}>
                {busy ? "Checking…" : "Save"}
              </Button>
            </>
          )}
        </div>
      </Field>
      {key && (
        <Field label="Voice" hint={voices.length ? "British voices are listed first." : "Loading voices…"}>
          <div className="flex gap-2">
            <Select
              ariaLabel="ElevenLabs voice"
              value={settings.elevenVoiceId}
              onChange={(id) => onChange({ elevenVoiceId: id, elevenVoiceName: voices.find((v) => v.id === id)?.name ?? "" })}
              options={
                voices.length
                  ? voices.map((v) => ({ value: v.id, label: v.description ? `${v.name} · ${v.description}` : v.name }))
                  : [{ value: settings.elevenVoiceId, label: settings.elevenVoiceName || "—" }]
              }
            />
            <Button variant="ghost" onClick={() => load(key)}>
              Refresh
            </Button>
          </div>
        </Field>
      )}
      {usage && (
        <Field
          label="Credits this month"
          hint={`${usage.tier} plan${usage.resetsAt ? `, resets ${usage.resetsAt.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}. BEV uses the Flash model: half a credit per character. When credits run out it switches to the free voice.`}
        >
          <div className="flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded bg-white/5">
              <div
                className={`h-full rounded ${usage.used / usage.limit > 0.9 ? "bg-bev-danger" : "bg-gradient-to-r from-bev-cyan to-bev-violet"}`}
                style={{ width: `${Math.min(100, (usage.used / Math.max(1, usage.limit)) * 100)}%` }}
              />
            </div>
            <span className="font-mono text-xs text-slate-400">
              {fmt(usage.used)} / {fmt(usage.limit)}
            </span>
          </div>
        </Field>
      )}
      {err && <p className="text-sm text-bev-danger">{err}</p>}
    </>
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
  const [models, setModels] = useState<StoredWakeModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadWakeModels().then(setModels);
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
      const replaced = models.some((m) => m.name === file.name);
      setModels(await addWakeModel(stored));
      setMsg({
        ok: true,
        text: `${replaced ? "Updated" : "Added"} “${phraseFromFile(file.name)}”.${phraseFromFile(file.name).toLowerCase() === "bev" ? " A one-word wake phrase triggers by accident more often; lower the sensitivity if it does." : ""}`,
      });
      if (settings.wakeEngine === "on-device") await restartListening();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const remove = async (name: string) => {
    setModels(await removeWakeModel(name));
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
        hint="Speech recognition works with no setup and answers to “BEV”, “hey BEV”, “yo BEV” and “OK BEV”. On-device runs your own trained phrases on this PC, so audio never leaves it."
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
            label="Wake phrases"
            hint={
              models.length
                ? `BEV wakes when it hears any of these. Add one .onnx model per phrase, e.g. “hey BEV” and “yo BEV”.`
                : "No model loaded yet. Train one with the guide, then add the .onnx file here."
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
              <Button onClick={() => fileRef.current?.click()} disabled={busy}>
                {busy ? "Checking…" : models.length ? "Add phrase" : "Load model"}
              </Button>
            </div>
          </Field>
          {models.length > 0 && (
            <ul className="divide-y divide-white/5 rounded-lg border border-white/5">
              {models.map((m) => (
                <li key={m.name} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm text-slate-200">“{phraseFromFile(m.name)}”</div>
                    <div className="truncate text-xs text-slate-500">
                      {m.name}, added {new Date(m.addedAt).toLocaleDateString("en-GB")}
                    </div>
                  </div>
                  <Button variant="danger" onClick={() => remove(m.name)} disabled={busy}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {msg && <p className={`text-sm ${msg.ok ? "text-bev-ok" : "text-bev-danger"}`}>{msg.text}</p>}
          {models.length > 0 && (
            <WakeTest models={models} deviceId={settings.micDeviceId} sensitivity={settings.wakeSensitivity} />
          )}
        </>
      )}
    </Section>
  );
}

/**
 * Live score meter for the loaded model, so the user can see how strongly
 * "hey BEV" registers and tune sensitivity. Runs its own engine instance.
 */
function WakeTest({
  models,
  deviceId,
  sensitivity,
}: {
  models: StoredWakeModel[];
  deviceId: string;
  sensitivity: number;
}) {
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
        const e = new OnDeviceWakeWord({
          models: models.map((m) => fromBase64(m.base64)),
          deviceId: deviceId || undefined,
          threshold,
        });
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
  }, [on, models, deviceId]);

  return (
    <Field
      label="Test wake word"
      hint={
        err ??
        `Say ${models.map((m) => `“${phraseFromFile(m.name)}”`).join(" or ")}. Detections: ${hits}. Trigger point ${Math.round(threshold * 100)}%.`
      }
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
