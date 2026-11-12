import { emit } from "@tauri-apps/api/event";
import { AssistantState, useAssistant } from "@/state/assistant";
import { native } from "@/lib/native";
import { useSettings } from "@/state/settings";
import { makeProvider } from "@/ai/factory";
import { Orchestrator } from "@/ai/orchestrator";
import { WebSpeechRecognizer, WebSpeechSynthesizer } from "./webspeech";
import { PorcupineWakeWord } from "./wakeword";
import { useRoutines, matchRoutine } from "@/routines/store";
import { runRoutine, summariseRun } from "@/routines/engine";

export interface ControllerConfig {
  picovoiceKey?: string;
}

const settings = () => useSettings.getState().settings;

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
  private wake?: PorcupineWakeWord;
  private stt = new WebSpeechRecognizer("en-GB");
  private tts = new WebSpeechSynthesizer();
  private orchestrator: Orchestrator;
  private abort?: AbortController;
  private active = false;

  constructor(private cfg: ControllerConfig) {
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
    this.wake = new PorcupineWakeWord({
      accessKey: this.cfg.picovoiceKey,
      deviceId: settings().micDeviceId || undefined,
      sensitivity: settings().wakeSensitivity,
    });
    this.wake.onLevel((l) => {
      if (useAssistant.getState().state === "listening") this.setAudio(l);
    });
    useAssistant.getState().setMic(true);
    await this.wake.start(() => this.onWake()).catch((e) => {
      // Surface the setup requirement rather than silently doing nothing.
      useAssistant.getState().setState("error", String(e instanceof Error ? e.message : e));
      useAssistant.getState().setMic(false);
    });
  }

  disableListening() {
    this.wake?.stop();
    useAssistant.getState().setMic(false);
    this.setState("idle");
  }

  /** Manual activation (push-to-talk / shortcut) without the wake word. */
  async onWake() {
    if (this.active) return;
    this.active = true;
    this.applySettings();
    await native.showOverlay().catch(() => {});
    this.setState("activating");
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
      await new Promise((r) => setTimeout(r, 900));
    }
    this.setState("idle", "");
    await native.hideOverlay().catch(() => {});
    this.active = false;
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
