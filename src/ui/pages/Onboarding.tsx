import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useSettings, ProviderId } from "@/state/settings";
import { native } from "@/lib/native";
import { MicInput } from "@/voice/wakeword";
import { WebSpeechSynthesizer } from "@/voice/webspeech";
import { makeProvider, providerLabels, secretNameFor } from "@/ai/factory";
import { Button, TextInput, Select, StatusPill } from "../components/Form";

/** Guided first-run setup. Explains what works locally vs needs a key/model. */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const { settings, update } = useSettings();
  const [step, setStep] = useState(0);
  const steps = ["Welcome", "Microphone", "Wake word", "AI provider", "Voice", "Permissions", "Finish"];

  const next = () => setStep((s) => Math.min(steps.length - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));
  const finish = async () => {
    await update({ onboarded: true });
    onDone();
  };

  return (
    <div className="grid h-screen w-screen place-items-center p-8">
      <div className="glass w-[620px] rounded-2xl p-8">
        {/* progress */}
        <div className="mb-6 flex gap-1.5">
          {steps.map((_, i) => (
            <div key={i} className={`h-1 flex-1 rounded ${i <= step ? "bg-bev-cyan" : "bg-white/10"}`} />
          ))}
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="min-h-[300px]"
          >
            {step === 0 && <Welcome />}
            {step === 1 && <MicStep deviceId={settings.micDeviceId} onPick={(micDeviceId) => update({ micDeviceId })} />}
            {step === 2 && <WakeStep />}
            {step === 3 && <ProviderStep provider={settings.provider} onProvider={(provider) => update({ provider })} />}
            {step === 4 && <VoiceStep voiceId={settings.voiceId} onVoice={(voiceId) => update({ voiceId })} />}
            {step === 5 && <PermissionsStep />}
            {step === 6 && <FinishStep />}
          </motion.div>
        </AnimatePresence>

        <div className="mt-8 flex items-center justify-between">
          <Button variant="ghost" onClick={back} disabled={step === 0}>
            Back
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={finish}>
              Skip setup
            </Button>
            {step < steps.length - 1 ? (
              <Button onClick={next}>Next</Button>
            ) : (
              <Button onClick={finish}>Finish</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Welcome() {
  return (
    <div className="space-y-3">
      <div className="text-3xl font-semibold text-glow">Meet BEV</div>
      <p className="text-slate-300">
        Your always-available AI assistant for Windows. BEV listens for its wake word, talks back, and
        controls your PC — opening apps, setting volume, running routines and more.
      </p>
      <p className="text-sm text-slate-500">
        This quick setup takes a minute. Wake-word and voice run locally; the AI brain uses a provider
        you choose (cloud API key, or fully local via Ollama). Nothing is uploaded without your say-so.
      </p>
    </div>
  );
}

function MicStep({ deviceId, onPick }: { deviceId: string; onPick: (id: string) => void }) {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [level, setLevel] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const mic = useRef<MicInput | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
        setMics((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput"));
        const m = new MicInput();
        mic.current = m;
        m.onLevel(setLevel);
        await m.start(deviceId || undefined);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => mic.current?.stop();
  }, [deviceId]);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Choose your microphone</h2>
      {err ? (
        <p className="text-sm text-bev-danger">Microphone access failed: {err}. You can grant it later in Voice settings.</p>
      ) : (
        <>
          <Select
            ariaLabel="Microphone"
            value={deviceId}
            onChange={onPick}
            options={[{ value: "", label: "System default" }, ...mics.map((m, i) => ({ value: m.deviceId, label: m.label || `Microphone ${i + 1}` }))]}
          />
          <div>
            <div className="mb-1 text-xs text-slate-500">Speak — the bar should move:</div>
            <div className="h-2 overflow-hidden rounded bg-white/5">
              <div className="h-full rounded bg-gradient-to-r from-bev-cyan to-bev-violet transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function WakeStep() {
  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold">Waking BEV</h2>
      <p className="text-slate-300">Two ways to get BEV's attention:</p>
      <ul className="space-y-2 text-sm text-slate-300">
        <li>⌨ <b>Ctrl + Alt + B</b> — works right now, no setup.</li>
        <li>🎙 <b>Say “BEV”</b> — on-device wake word. Add a free Picovoice key in Integrations and train a “BEV” keyword to enable it.</li>
      </ul>
      <p className="text-sm text-slate-500">
        BEV only processes audio locally until you activate it. Nothing is streamed before the wake word.
      </p>
    </div>
  );
}

function ProviderStep({ provider, onProvider }: { provider: ProviderId; onProvider: (p: ProviderId) => void }) {
  const settings = useSettings((s) => s.settings);
  const secretName = secretNameFor[provider];
  const [keyInput, setKeyInput] = useState("");
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [check, setCheck] = useState<{ ok: boolean | null; msg: string }>({ ok: null, msg: "not tested" });

  useEffect(() => {
    if (secretName) native.getSecret(secretName).then((v) => setHasKey(!!v)).catch(() => setHasKey(false));
    else setHasKey(null);
  }, [secretName]);

  const test = async () => {
    setCheck({ ok: null, msg: "testing…" });
    try {
      const p = makeProvider(settings, provider);
      if (!(await p.isConfigured())) {
        setCheck({ ok: false, msg: provider === "ollama" ? "Ollama not reachable at localhost:11434" : "no key saved yet" });
        return;
      }
      const res = await p.chat({ system: "Reply with: ready", messages: [{ role: "user", content: "ping" }], tools: [], maxTokens: 10 });
      setCheck({ ok: true, msg: `connected — “${res.text.slice(0, 24)}”` });
    } catch (e) {
      setCheck({ ok: false, msg: e instanceof Error ? e.message.slice(0, 120) : String(e) });
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Pick an AI brain</h2>
      <Select<ProviderId>
        ariaLabel="Provider"
        value={provider}
        onChange={onProvider}
        options={(["anthropic", "openai", "ollama"] as ProviderId[]).map((p) => ({ value: p, label: providerLabels[p] }))}
      />
      {secretName ? (
        <div className="flex gap-2">
          <TextInput
            type="password"
            autoComplete="off"
            placeholder={hasKey ? "key saved — paste to replace" : "paste API key"}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <Button
            disabled={!keyInput.trim()}
            onClick={async () => {
              await native.storeSecret(secretName, keyInput.trim());
              setKeyInput("");
              setHasKey(true);
            }}
          >
            Save
          </Button>
        </div>
      ) : (
        <p className="text-sm text-slate-400">
          Ollama runs fully offline. Install it from ollama.com and run <span className="font-mono">ollama pull llama3.1</span>.
        </p>
      )}
      <div className="flex items-center justify-between">
        <StatusPill ok={check.ok} label={check.msg} />
        <Button variant="ghost" onClick={test}>
          Test connection
        </Button>
      </div>
    </div>
  );
}

function VoiceStep({ voiceId, onVoice }: { voiceId: string; onVoice: (id: string) => void }) {
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    new WebSpeechSynthesizer().listVoices().then(setVoices).catch(() => setVoices([]));
  }, []);
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">BEV's voice</h2>
      <Select
        ariaLabel="Voice"
        value={voiceId}
        onChange={onVoice}
        options={[{ value: "", label: "Default" }, ...voices.map((v) => ({ value: v.id, label: v.name }))]}
      />
      <Button variant="ghost" onClick={() => new WebSpeechSynthesizer({ voiceId: voiceId || undefined }).speak("Hi, I'm BEV. Everything's ready when you are.").catch(() => {})}>
        Test voice
      </Button>
      <p className="text-sm text-slate-500">
        More natural voices appear here if you install Windows neural voices (Settings → Time & language → Speech).
      </p>
    </div>
  );
}

function PermissionsStep() {
  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold">What BEV can do</h2>
      <ul className="space-y-2 text-sm text-slate-300">
        <li>✓ Open and close apps, set volume, read system stats, manage windows.</li>
        <li>✓ Run multi-step routines you create.</li>
        <li>🔒 Destructive actions (closing apps, shutdown) always ask for approval first.</li>
        <li>🔒 API keys are stored in Windows Credential Manager, never in plain files.</li>
        <li>🔒 You can revoke any capability, or hit Privacy mode to kill the mic, in Security.</li>
      </ul>
      <p className="text-sm text-slate-500">BEV runs as a normal app — no administrator rights required.</p>
    </div>
  );
}

function FinishStep() {
  return (
    <div className="space-y-3">
      <div className="text-2xl font-semibold text-glow">You're set</div>
      <p className="text-slate-300">
        Press <b>Ctrl + Alt + B</b> (or say “BEV” once the wake word is set up) and try:
      </p>
      <ul className="space-y-1 text-sm text-slate-400">
        <li>“What's my CPU doing?”</li>
        <li>“Open Notepad.”</li>
        <li>“Set my volume to 30%.”</li>
        <li>“Gaming mode.”</li>
      </ul>
    </div>
  );
}
