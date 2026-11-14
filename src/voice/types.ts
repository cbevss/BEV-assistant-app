/** Swappable voice-engine contracts. Each has a working default and an
 *  optional premium implementation configured in Settings. */

export interface WakeWordEngine {
  readonly id: string;
  /** Begin listening for the wake word. Calls onWake when detected. */
  start(onWake: () => void): Promise<void>;
  stop(): void;
  /** Live input level 0..1 for the overlay visualiser. */
  onLevel(cb: (level: number) => void): void;
  /** Stop reacting while a conversation uses the mic, and pick up afterwards. */
  pauseListening(): void;
  resumeListening(): void;
  /** Called when listening stops for good (mic blocked, missing, model failed). */
  onFatal?: (error: string) => void;
}

export interface SpeechRecognizer {
  readonly id: string;
  /** Record + transcribe one utterance, ending on silence (VAD). */
  listenOnce(opts: { signal?: AbortSignal; onPartial?: (t: string) => void }): Promise<string>;
}

export interface SpeechSynthesizer {
  readonly id: string;
  speak(text: string, opts?: { signal?: AbortSignal; onLevel?: (l: number) => void }): Promise<void>;
  cancel(): void;
  listVoices(): Promise<{ id: string; name: string }[]>;
}
