import { emit } from "@tauri-apps/api/event";
import { AssistantState, useAssistant } from "@/state/assistant";
import { native } from "@/lib/native";
import { useSettings } from "@/state/settings";
import { makeProvider } from "@/ai/factory";
import { Orchestrator } from "@/ai/orchestrator";
import { WebSpeechRecognizer, WebSpeechSynthesizer } from "./webspeech";
import { WebSpeechWakeWord } from "./wakeword";
import type { WakeWordEngine } from "./types";
import { loadWakeModel, fromBase64 } from "./oww/model-store";
import { thresholdFor } from "./oww/pipeline";
import { useRoutines, matchRoutine } from "@/routines/store";
import { runRoutine, summariseRun } from "@/routines/engine";
import { playChime } from "./sounds";


const settings = () => useSettings.getState().settings;

function micErrorText(error: string): string {
  if (error === "audio-capture") return "No microphone found. Check the input device in Voice & Audio.";
  if (error === "not-allowed" || error === "service-not-allowed")
    return "Microphone access is blocked. Allow it in Windows Settings → Privacy → Microphone.";
  return `Wake word stopped: ${error}`;
}

/** "stop", "BEV stop", "cancel", "never mind", "shut up" end the conversation. */
export function isStopPhrase(utterance: string): boolean {
  const u = utterance
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .replace(/^(hey |yo )?bev /, "")
    .trim();
  return /^(stop|cancel|never ?mind|nevermind|shut up|be quiet|thats all|forget it)( (it|that|bev))?$/.test(u);
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
  private tts = new WebSpeechSynthesizer();
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
    });
  }

  /** Rebuild provider + voice from current settings (called at the start of each conversation). */
  private applySettings() {
    const s = settings();
    this.orchestrator.setProvider(makeProvider(s));
    this.tts = new WebSpeechSynthesizer({
      voiceId: s.voiceId || undefined,
      rate: s.speakRate,
      volume: s.speakVolume,
    });
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

  private speechEngine(): WakeWordEngine {
    return new WebSpeechWakeWord({ deviceId: settings().micDeviceId || undefined });
  }

  /** The engine chosen in Voice & Audio, or speech if on-device isn't set up. */
  private async makeWakeEngine(): Promise<{ engine: WakeWordEngine; note: string | null }> {
    const s = settings();
    if (s.wakeEngine !== "on-device") return { engine: this.speechEngine(), note: null };
    const model = await loadWakeModel();
    if (!model) {
      return {
        engine: this.speechEngine(),
        note: "On-device wake word is selected but no model is loaded. Using speech recognition instead.",
      };
    }
    // Loaded lazily: the ONNX runtime is only fetched when this engine is used.
    const { OnDeviceWakeWord } = await import("./oww/engine");
    return {
      engine: new OnDeviceWakeWord({
        model: fromBase64(model.base64),
        deviceId: s.micDeviceId || undefined,
        threshold: thresholdFor(s.wakeSensitivity),
      }),
      note: null,
    };
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
    await native.showOverlay().catch(() => {});
    this.setState("activating");
    playChime("wake");
    if (!settings().gamingQuietMode) await this.tts.speak("Yeah?").catch(() => {});
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
      return await this.stt.listenOnce({
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
    try {
      while (this.active) {
        this.setState("listening", "");
        this.abort = new AbortController();
        const utterance = (await this.listenWithTimeout(this.abort.signal).catch(() => "")).trim();

        if (!utterance) break; // silence → end conversation

        if (isStopPhrase(utterance)) {
          this.tts.cancel();
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
          await this.tts.speak(reply, {
            signal: this.abort.signal,
            onLevel: (l) => this.setAudio(l),
          });
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
    // Keep an error visible long enough to read; otherwise show a brief "done".
    if (useAssistant.getState().state === "error") {
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
