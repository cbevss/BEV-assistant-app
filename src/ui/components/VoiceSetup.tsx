/**
 * Microphone diagnosis, calibration and speech-recognition settings.
 * Everything shown is measured on this PC: no made-up numbers.
 */
import { useEffect, useRef, useState } from "react";
import { useSettings } from "@/state/settings";
import { winMics, endpointProblems, matchEndpoint, type WinInput, type MicProblem } from "@/voice/mic";
import { record } from "@/voice/capture";
import { analyseCalibration, wordAccuracy, dbfs, TEST_SENTENCES, type CalibrationReport } from "@/voice/audio-analysis";
import { WebSpeechRecognizer } from "@/voice/webspeech";
import { transcribe, preloadWhisper, onWhisperStatus, whisperStatus, WHISPER_MODELS, type WhisperStatus } from "@/voice/stt/whisper";
import { cleanTranscript } from "@/voice/stt/clean";
import { restartListening } from "@/voice/bootstrap";
import { Section, Field, Select, Toggle, Button, StatusPill } from "./Form";

/** The label of the mic BEV is set to use (or the Windows default). */
function useMicLabel(): string {
  const { settings } = useSettings();
  const [label, setLabel] = useState("");
  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) => {
        const mics = all.filter((d) => d.kind === "audioinput");
        const chosen = mics.find((d) => d.deviceId === settings.micDeviceId);
        setLabel((chosen ?? mics.find((d) => d.deviceId === "default") ?? mics[0])?.label ?? "");
      })
      .catch(() => {});
  }, [settings.micDeviceId]);
  return label;
}

// ---------------------------------------------------------------------------

export function MicDiagnostics() {
  const { settings } = useSettings();
  const label = useMicLabel();
  const [eps, setEps] = useState<WinInput[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => winMics.list().then(setEps).catch(() => setEps([]));
  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  if (!eps || eps.length === 0) return null;
  const ep = matchEndpoint(label, eps) ?? eps.find((e) => e.is_default);
  const problems = endpointProblems(label, eps, settings.sttEngine === "windows");

  const fix = async (p: MicProblem) => {
    try {
      if (p.kind === "muted") await winMics.setLevel(p.endpoint.id, undefined, false);
      if (p.kind === "low_level") await winMics.setLevel(p.endpoint.id, 0.8);
      if (p.kind === "not_default") await winMics.setDefault(p.endpoint.id);
      setMsg("Done.");
      load();
      await restartListening();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const fixLabel: Partial<Record<MicProblem["kind"], string>> = { muted: "Unmute", low_level: "Set to 80%", not_default: "Make it the Windows default" };

  return (
    <div className="space-y-2">
      {ep && (
        <Field label="Windows sees" hint={`${ep.name}${ep.is_default ? " · Windows default" : ""}`}>
          <div className="text-right text-sm tabular-nums text-slate-300">
            {ep.muted ? "Muted" : ep.volume !== null ? `Level ${Math.round(ep.volume * 100)}%` : ""}
          </div>
        </Field>
      )}
      {problems.map((p) => (
        <div key={p.kind} className="flex items-center justify-between gap-3 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2">
          <p className="text-sm text-amber-200">{p.message}</p>
          {fixLabel[p.kind] && (
            <Button variant="ghost" onClick={() => fix(p)}>
              {fixLabel[p.kind]}
            </Button>
          )}
        </div>
      ))}
      {msg && <p className="text-xs text-slate-400">{msg}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

type Phase = { step: "idle" } | { step: "quiet" } | { step: "speak"; sentence: string } | { step: "thinking" } | { step: "done" };

interface Result {
  report: CalibrationReport;
  heard: string;
  accuracy: number | null;
  engine: string;
  noiseSuppression: boolean;
  sampleRate?: number;
  processing: string;
  level: number | null;
}

const fmtDb = (d: number) => `${d.toFixed(0)} dBFS`;

export function Calibration() {
  const { settings } = useSettings();
  const label = useMicLabel();
  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  const [level, setLevel] = useState(-100);
  const [results, setResults] = useState<Result[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const latest = results[0];

  useEffect(() => () => abort.current?.abort(), []);

  const run = async () => {
    setErr(null);
    const ctl = new AbortController();
    abort.current = ctl;
    const opts = { deviceId: settings.micDeviceId || undefined, noiseSuppression: settings.noiseSuppression, echoCancellation: false };
    const meter = (c: Float32Array) => setLevel(dbfs(c));
    const eps = await winMics.list().catch(() => [] as WinInput[]);
    const ep = matchEndpoint(label, eps) ?? eps.find((e) => e.is_default);
    try {
      setPhase({ step: "quiet" });
      const quiet = await record(3000, opts, meter, ctl.signal);
      const sentence = TEST_SENTENCES[Math.floor(Math.random() * TEST_SENTENCES.length)];
      setPhase({ step: "speak", sentence });

      // Recognise the sentence with the engine BEV is set to use.
      let heardP: Promise<string>;
      let engine: string;
      if (settings.sttEngine === "whisper") {
        engine = `Whisper (${settings.whisperSize})`;
        heardP = Promise.resolve(""); // transcribed from the recording below
      } else {
        engine = "Windows";
        const rec = new WebSpeechRecognizer("en-GB", 1500);
        const stop = new AbortController();
        heardP = rec.listenOnce({ signal: stop.signal }).catch(() => "");
        setTimeout(() => stop.abort(), 9000);
      }
      const spoken = await record(7000, opts, meter, ctl.signal);
      setPhase({ step: "thinking" });
      let heard: string;
      if (settings.sttEngine === "whisper") {
        heard = cleanTranscript(await transcribe(spoken.audio.slice(), settings.whisperSize, settings.kokoroUseGpu), 5000);
      } else {
        heard = await heardP;
      }
      const report = analyseCalibration(quiet.audio, spoken.audio, ep?.volume ?? null);
      const s = spoken.settings;
      setResults((r) => [
        {
          report,
          heard,
          accuracy: heard || report.issues.every((i) => i.kind !== "no_speech") ? wordAccuracy(sentence, heard).accuracy : null,
          engine,
          noiseSuppression: settings.noiseSuppression,
          sampleRate: s?.sampleRate,
          processing: [s?.echoCancellation ? "echo cancel" : "", s?.noiseSuppression ? "noise suppression" : "", s?.autoGainControl ? "auto gain" : ""].filter(Boolean).join(", ") || "none",
          level: ep?.volume ?? null,
        },
        ...r,
      ].slice(0, 8));
      setPhase({ step: "done" });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setErr(e instanceof Error ? e.message : String(e));
      setPhase({ step: "idle" });
    } finally {
      setLevel(-100);
    }
  };

  const applyLevel = async (v: number) => {
    const eps = await winMics.list().catch(() => [] as WinInput[]);
    const ep = matchEndpoint(label, eps) ?? eps.find((e) => e.is_default);
    if (!ep) return setErr("Couldn't find this microphone in Windows.");
    await winMics.setLevel(ep.id, v).catch((e) => setErr(String(e)));
    setErr(null);
  };

  const busy = phase.step === "quiet" || phase.step === "speak" || phase.step === "thinking";
  const pct = Math.max(0, Math.min(100, ((level + 70) / 70) * 100));
  return (
    <Section title="Microphone check" aside={latest && <StatusPill ok={latest.report.verdict === "good" ? true : latest.report.verdict === "poor" ? false : null} label={latest.report.verdict} />}>
      <p className="text-sm text-slate-400">
        Measures your mic and room, then how well BEV recognises you. Takes about 10 seconds. Run it again after changing a setting to compare.
      </p>

      {busy && (
        <div className="space-y-2 rounded-lg border border-white/10 p-3">
          <div className="text-sm text-slate-200">
            {phase.step === "quiet" && "Stay quiet for 3 seconds…"}
            {phase.step === "speak" && (
              <>
                Now read this out normally:
                <div className="mt-1 text-base text-white">“{phase.sentence}”</div>
              </>
            )}
            {phase.step === "thinking" && "Checking…"}
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-white/5" aria-label="Input level">
            <div className="h-full bg-bev-cyan transition-[width] duration-75" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {latest && !busy && (
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
            <Stat k="Your voice" v={fmtDb(latest.report.speechDb)} />
            <Stat k="Background" v={fmtDb(latest.report.noiseFloorDb)} />
            <Stat k="Voice above background" v={`${latest.report.snrDb.toFixed(0)} dB`} />
            <Stat k="Distortion" v={`${latest.report.clippingPct.toFixed(1)}%`} />
          </dl>
          <div className="text-xs text-slate-500">
            {latest.sampleRate ? `${(latest.sampleRate / 1000).toFixed(1)} kHz` : ""} · processing: {latest.processing}
            {latest.level !== null ? ` · Windows level ${Math.round(latest.level * 100)}%` : ""}
          </div>
          {latest.report.issues.map((i) => (
            <div key={i.kind} className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-sm">
              <div className="text-amber-200">{i.message}</div>
              <div className="flex items-center justify-between gap-3 text-slate-400">
                <span>{i.fix}</span>
                {(i.kind === "too_quiet" || i.kind === "clipping") && latest.report.suggestedLevel !== undefined && (
                  <Button variant="ghost" onClick={() => applyLevel(latest.report.suggestedLevel!)}>
                    Set level to {Math.round(latest.report.suggestedLevel * 100)}%
                  </Button>
                )}
              </div>
            </div>
          ))}
          {latest.report.issues.length === 0 && <p className="text-sm text-bev-ok">Your mic and room sound good for speech recognition.</p>}
          <div className="text-sm">
            <span className="text-slate-400">{latest.engine} heard: </span>
            <span className="text-slate-200">{latest.heard ? `“${latest.heard}”` : "nothing"}</span>
            {latest.accuracy !== null && <span className="ml-2 tabular-nums text-slate-400">({Math.round(latest.accuracy * 100)}% of words right)</span>}
          </div>
        </div>
      )}

      {results.length > 1 && (
        <table className="w-full text-left text-xs">
          <thead className="text-slate-500">
            <tr>
              <th className="py-1 font-normal">Engine</th>
              <th className="font-normal">Noise suppression</th>
              <th className="font-normal">Voice above background</th>
              <th className="font-normal">Words right</th>
            </tr>
          </thead>
          <tbody className="tabular-nums text-slate-300">
            {results.map((r, i) => (
              <tr key={i} className="border-t border-white/5">
                <td className="py-1">{r.engine}</td>
                <td>{r.noiseSuppression ? "On" : "Off"}</td>
                <td>{r.report.snrDb.toFixed(0)} dB</td>
                <td>{r.accuracy !== null ? `${Math.round(r.accuracy * 100)}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {err && <p className="text-sm text-bev-danger">{err}</p>}
      <div className="flex justify-end gap-2">
        {busy ? (
          <Button variant="ghost" onClick={() => abort.current?.abort()}>
            Cancel
          </Button>
        ) : (
          <Button onClick={run}>{results.length ? "Test again" : "Start test"}</Button>
        )}
      </div>
    </Section>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{k}</dt>
      <dd className="tabular-nums text-slate-200">{v}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function RecognitionSettings() {
  const { settings, update } = useSettings();
  const [ws, setWs] = useState<WhisperStatus>(whisperStatus());
  useEffect(() => onWhisperStatus(setWs), []);

  const setEngine = async (sttEngine: "windows" | "whisper") => {
    await update({ sttEngine });
    if (sttEngine === "whisper") preloadWhisper(settings.whisperSize, settings.kokoroUseGpu);
  };
  const setSize = async (whisperSize: "base" | "small") => {
    await update({ whisperSize });
    if (settings.sttEngine === "whisper") preloadWhisper(whisperSize, settings.kokoroUseGpu);
  };

  const wsLabel =
    ws.state === "downloading" ? `downloading ${ws.percent}%` : ws.state === "ready" ? `ready (${ws.device})` : ws.state === "error" ? "error" : "not loaded";
  return (
    <Section
      title="Speech recognition"
      aside={settings.sttEngine === "whisper" ? <StatusPill ok={ws.state === "ready" ? true : ws.state === "error" ? false : null} label={wsLabel} /> : undefined}
    >
      <Field
        label="Engine"
        hint={
          settings.sttEngine === "whisper"
            ? "Whisper runs on this PC: your voice never leaves it, and it uses the microphone chosen above."
            : "Windows' online speech recognition. It always uses the Windows default microphone."
        }
      >
        <Select
          ariaLabel="Speech recognition engine"
          value={settings.sttEngine}
          onChange={setEngine}
          options={[
            { value: "windows", label: "Windows (online)" },
            { value: "whisper", label: "Whisper (on this PC)" },
          ]}
        />
      </Field>
      {settings.sttEngine === "whisper" && (
        <Field label="Whisper model" hint="Downloaded once. Uses the graphics card if “use graphics card” is on for voices.">
          <Select
            ariaLabel="Whisper model"
            value={settings.whisperSize}
            onChange={setSize}
            options={(Object.keys(WHISPER_MODELS) as Array<keyof typeof WHISPER_MODELS>).map((k) => ({ value: k, label: WHISPER_MODELS[k].label }))}
          />
        </Field>
      )}
      {ws.state === "error" && settings.sttEngine === "whisper" && <p className="text-sm text-bev-danger">{ws.message}</p>}
      <Field
        label="Noise suppression"
        hint="Helps in noisy rooms, but can make a clean mic sound worse. Use the microphone check to compare."
      >
        <Toggle label="Noise suppression" checked={settings.noiseSuppression} onChange={(noiseSuppression) => update({ noiseSuppression })} />
      </Field>
      <Field label="Interrupt by talking" hint="Start speaking while BEV is talking and it stops to listen. Works best with headphones.">
        <Toggle label="Interrupt by talking" checked={settings.bargeIn} onChange={(bargeIn) => update({ bargeIn })} />
      </Field>
    </Section>
  );
}
