import { emit } from "@tauri-apps/api/event";
import { endIntent, DISMISS_REPLY } from "./intents";
import { AssistantState, useAssistant } from "@/state/assistant";
import { native } from "@/lib/native";
import { useSettings } from "@/state/settings";
import { makeProvider } from "@/ai/factory";
import { Orchestrator } from "@/ai/orchestrator";
import { WebSpeechRecognizer } from "./webspeech";
import type { SpeechSynthesizer } from "./types";
import { ChainSynthesizer, ELEVEN_SECRET, type VoiceNote } from "./tts";
import { notify } from "@/lib/notify";
import { WebSpeechWakeWord } from "./wakeword";
import type { WakeWordEngine } from "./types";
import { activeWakeModels } from "./oww/wake-models";
import { showOverlayUnlessGaming } from "@/lib/overlayGate";
import { thresholdFor } from "./oww/pipeline";
import { useRoutines, matchRoutine } from "@/routines/store";
import { runRoutine, summariseRun } from "@/routines/engine";
import { playChime } from "./sounds";
import { SttError } from "./webspeech";
import type { SpeechRecognizer } from "./types";
import { WhisperRecognizer } from "./stt/whisper";
import { effectiveMic } from "./mic";
import { listenForBargeIn } from "./bargein";

/** Below this Windows-recogniser confidence, a short request is checked with the user. */
const LOW_CONFIDENCE = 0.35;

/**
 * After BEV speaks, wait before listening: speakers (Bluetooth especially)
 * are still playing the last of BEV's words, and the recogniser would hear them.
 */
const ECHO_GAP_MS = 350;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));


const settings = () => useSettings.getState().settings;

function micErrorText(error: string): string {
  if (error === "audio-capture") return "No microphone found. Check the input device in Voice & Audio.";
  if (error === "not-allowed" || error === "service-not-allowed")
    return "Microphone access is blocked. Allow it in Windows Settings → Privacy → Microphone.";
  return `Wake word stopped: ${error}`;
}

/** "stop", "BEV stop", "cancel", "shut up" end the conversation silently. */
export function isStopPhrase(utterance: string): boolean {
  return endIntent(utterance) === "stop";
}

/**
 * The conversation runtime. Owns the wake-word engine, recognizer, synthesizer
 * and orchestrator and drives the shared assistant state machine + overlay.
 *
 * Flow: wake → activating → listening (STT) → thinking/executing (AI+tools) →
 * speaking (TTS) → listening (follow-up window) → idle.
 */
export class VoiceController {
  /** The live wake-word engine (read by Voice & Audio for live tuning). */
  wake?: WakeWordEngine;
  private stt = new WebSpeechRecognizer("en-GB");
  private whisper: WhisperRecognizer | null = null;
  private whisperKey = "";
  /** The mic actually in use ("" = Windows default) and whether that's a fallback. */
  private mic = { deviceId: "", fallback: false, label: "" };
  private tts: SpeechSynthesizer = this.makeTts();
  /** Set by a dismissal ("that's all") so the popup closes without the "done" step. */
  private closeQuietly = false;
  /** Notes already shown, so a fallback isn't announced on every reply. */
  private shownVoiceNotes = new Set<string>();
  private orchestrator: Orchestrator;
  private abort?: AbortController;
  private active = false;

  constructor() {
    this.orchestrator = new Orchestrator(makeProvider(settings()), {
      onState: (s) => this.setState(s),
      onAssistantText: (t) => this.pushAssistant(t),
      onToolResult: (name, ok, result) =>
        useAssistant.getState().pushMessage({ role: "tool", content: result, toolName: name, ok }),
      requestApproval: (_call, description) => this.approve(description),
      onPlan: (plan) => useAssistant.getState().setPlan(plan),
    });
  }

  /** Rebuild provider + voice from current settings (called at the start of each conversation). */
  private applySettings() {
    const s = settings();
    this.orchestrator.setProvider(makeProvider(s));
    this.tts = this.makeTts();
  }

  private makeTts(): SpeechSynthesizer {
    return new ChainSynthesizer(settings(), () => native.getSecret(ELEVEN_SECRET), (n) => this.voiceNote(n));
  }

  private voiceNote(n: VoiceNote) {
    useAssistant.getState().setVoiceNote(n.text);
    if (n.important && !this.shownVoiceNotes.has(n.text)) {
      this.shownVoiceNotes.add(n.text);
      notify("BEV voice", n.text);
    }
  }

  /** Begin background wake-word monitoring. Refuses while privacy mode is on. */
  async enableListening() {
    if (useAssistant.getState().privacyMode) {
      useAssistant.getState().setState("error", "Privacy mode is on — turn it off to enable the microphone.");
      return;
    }
    this.wake?.stop();
    const { engine, note } = await this.makeWakeEngine();
    this.wake = engine;
    useAssistant.getState().setMic(true);
    try {
      await this.startEngine(engine);
      this.reportWake(note);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (engine.id !== "openwakeword") return this.listeningFailed(msg);
      // Don't leave BEV deaf because the model or audio setup failed: drop
      // back to the speech wake word and say why.
      engine.stop();
      this.wake = this.speechEngine();
      try {
        await this.startEngine(this.wake);
        this.reportWake(`On-device wake word failed (${msg}). Using speech recognition instead.`);
      } catch (e2) {
        this.listeningFailed(e2 instanceof Error ? e2.message : String(e2));
      }
    }
  }

  private async startEngine(w: WakeWordEngine) {
    w.onFatal = (error) => {
      useAssistant.getState().setMic(false);
      useAssistant.getState().setWake(null);
      useAssistant.getState().setState("error", micErrorText(error));
    };
    w.onLevel((l) => {
      if (useAssistant.getState().state === "listening") this.setAudio(l);
    });
    await w.start(() => this.onWake());
  }

  private reportWake(note: string | null) {
    useAssistant.getState().setWake({ engine: this.wake?.id === "openwakeword" ? "on-device" : "speech", note });
  }

  private listeningFailed(msg: string) {
    useAssistant.getState().setState("error", msg);
    useAssistant.getState().setMic(false);
    useAssistant.getState().setWake(null);
  }

  /**
   * Work out which mic to use: the chosen one if it's plugged in, else the
   * Windows default (announced once, and switched back when it returns).
   */
  /** Is a conversation going on? (Don't swap mics mid-sentence.) */
  get busy() {
    return this.active;
  }

  /** Re-check the mic; true if a different device should now be used. */
  async micChanged(): Promise<boolean> {
    const before = this.mic.deviceId;
    await this.refreshMic();
    return this.mic.deviceId !== before;
  }

  async refreshMic(): Promise<void> {
    const devices = await navigator.mediaDevices?.enumerateDevices().catch(() => []) ?? [];
    const next = effectiveMic(settings().micDeviceId, devices.filter((d) => d.kind === "audioinput"));
    if (next.fallback && !this.mic.fallback) notify("BEV microphone", `Your chosen microphone isn't connected, so BEV is using ${next.label}.`);
    if (!next.fallback && this.mic.fallback) notify("BEV microphone", `Back on ${next.label}.`);
    this.mic = next;
  }

  /** The recogniser chosen in Voice & Audio. */
  private recognizer(): SpeechRecognizer {
    const s = settings();
    if (s.sttEngine !== "whisper") return this.stt;
    const key = `${s.whisperSize}|${s.kokoroUseGpu}`;
    if (!this.whisper || key !== this.whisperKey) {
      this.whisperKey = key;
      this.whisper = new WhisperRecognizer({
        size: s.whisperSize,
        allowGpu: s.kokoroUseGpu,
        capture: () => ({ deviceId: this.mic.deviceId || undefined, noiseSuppression: settings().noiseSuppression, echoCancellation: true }),
      });
    }
    return this.whisper;
  }

  private speechEngine(): WakeWordEngine {
    return new WebSpeechWakeWord({ deviceId: this.mic.deviceId || undefined });
  }

  /** The engine chosen in Voice & Audio, or speech if on-device isn't set up. */
  private async makeWakeEngine(): Promise<{ engine: WakeWordEngine; note: string | null }> {
    const s = settings();
    await this.refreshMic();
    if (s.wakeEngine !== "on-device") return { engine: this.speechEngine(), note: null };
    let models: Uint8Array[];
    try {
      models = await activeWakeModels(s.builtInWakeModel);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return { engine: this.speechEngine(), note: `On-device wake word couldn't load (${why}). Using speech recognition instead.` };
    }
    if (!models.length) {
      return {
        engine: this.speechEngine(),
        note: "On-device wake word is selected but no phrases are loaded. Using speech recognition instead.",
      };
    }
    // Loaded lazily: the ONNX runtime is only fetched when this engine is used.
    const { OnDeviceWakeWord } = await import("./oww/engine");
    return {
      engine: new OnDeviceWakeWord({
        models,
        deviceId: this.mic.deviceId || undefined,
        threshold: thresholdFor(s.wakeSensitivity),
      }),
      note: null,
    };
  }

  /** The mute hotkey: mic off (ending any conversation) or back on. */
  async toggleMute() {
    if (useAssistant.getState().micEnabled) {
      if (this.active) {
        this.closeQuietly = true;
        this.interrupt();
      }
      this.disableListening();
      playChime("mute", true);
    } else {
      await this.enableListening();
      if (useAssistant.getState().micEnabled) playChime("unmute", true);
    }
  }

  disableListening() {
    this.wake?.stop();
    useAssistant.getState().setMic(false);
    useAssistant.getState().setWake(null);
    this.setState("idle");
  }

  /** Manual activation (push-to-talk / shortcut) without the wake word. */
  async onWake() {
    if (this.active) return;
    this.active = true;
    // Free the mic for the conversation recogniser (only one at a time).
    this.wake?.pauseListening();
    this.applySettings();
    await showOverlayUnlessGaming();
    this.setState("activating");
    playChime("wake");
    if (!settings().gamingQuietMode) {
      await this.tts.speak("Yeah?").catch(() => {});
      await pause(ECHO_GAP_MS);
    }
    await this.conversationTurn();
  }

  /**
   * Listen for one utterance. The follow-up timeout only applies while the user
   * is silent: the first partial transcript cancels it, so long sentences are
   * never cut off. On timeout the recogniser is aborted (not left running).
   */
  private async listenWithTimeout(signal: AbortSignal): Promise<string> {
    const ctl = new AbortController();
    const onOuterAbort = () => ctl.abort();
    signal.addEventListener("abort", onOuterAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => ctl.abort(),
      settings().conversationTimeoutMs
    );
    try {
      return await this.recognizer().listenOnce({
        signal: ctl.signal,
        onPartial: (t) => {
          if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }
          useAssistant.getState().setState("listening", t);
        },
      });
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onOuterAbort);
    }
  }

  private async conversationTurn() {
    let askedRepeat = false;
    try {
      while (this.active) {
        this.setState("listening", "");
        this.abort = new AbortController();
        let utterance: string;
        try {
          utterance = (await this.listenWithTimeout(this.abort.signal)).trim();
        } catch (e) {
          // Show real recogniser failures (no internet, mic blocked) instead of
          // quietly ending; a timeout/abort is just silence.
          if (e instanceof SttError) {
            this.setState("error", e.message);
            await pause(2500);
          }
          break;
        }

        if (!utterance) break; // silence → end conversation

        // The Windows recogniser wasn't sure about a short request: check
        // rather than act on a guess (once per turn).
        if (settings().sttEngine !== "whisper" && !askedRepeat) {
          const conf = this.stt.lastConfidence;
          if (conf > 0 && conf < LOW_CONFIDENCE && utterance.split(/\s+/).length <= 8) {
            askedRepeat = true;
            this.setState("speaking");
            await this.tts.speak("Sorry, I didn't quite catch that. Say it again?", { signal: this.abort.signal, onLevel: (l) => this.setAudio(l) }).catch(() => {});
            await pause(ECHO_GAP_MS);
            continue;
          }
        }
        askedRepeat = false;

        const intent = endIntent(utterance);
        if (intent === "stop") {
          this.tts.cancel();
          break;
        }
        if (intent === "dismiss") {
          // "That's all" / "I wasn't talking to you": don't wait for more,
          // don't send it to the AI. Say goodbye, close, and start fresh next time.
          this.tts.cancel();
          this.setState("speaking");
          await this.tts
            .speak(DISMISS_REPLY, { signal: this.abort.signal, onLevel: (l) => this.setAudio(l) })
            .catch(() => {});
          this.orchestrator.reset();
          this.closeQuietly = true;
          break;
        }

        useAssistant.getState().pushMessage({ role: "user", content: utterance });

        // Fast path: if the whole utterance IS a routine trigger ("gaming mode"),
        // run it directly — instant and offline, no AI round-trip.
        const routine = matchRoutine(utterance, useRoutines.getState().routines);
        let reply: string;
        if (routine) {
          this.setState("executing", `Running ${routine.name}`);
          const report = await runRoutine(routine, { requestApproval: (d) => this.approve(d) });
          useRoutines.getState().markRun(routine.id);
          reply = summariseRun(report);
          useAssistant.getState().pushMessage({ role: "assistant", content: reply });
        } else {
          reply = await this.orchestrator.send(utterance, this.abort.signal);
        }

        if (reply) {
          this.setState("speaking");
          // Barge-in: talking over BEV stops it and goes straight to listening.
          const barge = settings().bargeIn ? new AbortController() : null;
          let interrupted = false;
          const watching = barge
            ? listenForBargeIn({ deviceId: this.mic.deviceId || undefined, noiseSuppression: settings().noiseSuppression }, barge.signal).then((hit) => {
                if (hit) {
                  interrupted = true;
                  this.tts.cancel();
                }
              })
            : null;
          try {
            await this.tts.speak(reply, { signal: this.abort.signal, onLevel: (l) => this.setAudio(l) });
          } catch (e) {
            if (!interrupted) throw e;
          } finally {
            barge?.abort();
            await watching;
          }
          if (!interrupted) await pause(ECHO_GAP_MS);
        }
        // loop: follow-up window without repeating the wake word
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        this.setState("error", e instanceof Error ? e.message : String(e));
      }
    } finally {
      this.endConversation();
    }
  }

  /** Interrupt the current turn ("BEV, stop" or user speaks over TTS). */
  interrupt() {
    this.abort?.abort();
    this.tts.cancel();
  }

  private async endConversation() {
    const quiet = this.closeQuietly;
    this.closeQuietly = false;
    // Keep an error visible long enough to read; otherwise show a brief "done".
    // After a dismissal the popup just goes: no "done" animation or chime.
    if (quiet) {
      // nothing to show
    } else if (useAssistant.getState().state === "error") {
      await new Promise((r) => setTimeout(r, 3500));
    } else {
      this.setState("completed");
      playChime("done");
      await new Promise((r) => setTimeout(r, 900));
    }
    this.setState("idle", "");
    await native.hideOverlay().catch(() => {});
    this.active = false;
    // Resume listening for the wake word, unless the mic was turned off.
    if (useAssistant.getState().micEnabled) this.wake?.resumeListening();
  }

  private async approve(description: string): Promise<boolean> {
    // Routed to the UI approval modal via a global resolver; see App.tsx.
    return useAssistant.getState().requestApproval?.(description) ?? Promise.resolve(false);
  }

  private setState(s: AssistantState, text?: string) {
    useAssistant.getState().setState(s, text);
    emit("bev://state", s).catch(() => {});
    if (text !== undefined) emit("bev://status", text).catch(() => {});
  }
  private pushAssistant(t: string) {
    useAssistant.getState().pushMessage({ role: "assistant", content: t });
  }
  private setAudio(l: number) {
    useAssistant.getState().setAudioLevel(l);
    emit("bev://audio-level", l).catch(() => {});
  }
}
