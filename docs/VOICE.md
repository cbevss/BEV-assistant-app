# BEV — voice pipeline

```
wake word ──▶ activating ──▶ listening (STT + VAD) ──▶ thinking/executing (AI + tools) ──▶ speaking (TTS) ──▶ follow-up window ──▶ idle
```

Everything is orchestrated by `src/voice/controller.ts` and driven by the shared state machine in `src/state/assistant.ts`. The overlay reads that state and the live audio level.

## Engines (swappable)
| Stage | Default (works today) | Upgrade |
|---|---|---|
| Wake word | Ctrl+Alt+B shortcut / tray | **Picovoice Porcupine** on-device ("BEV") |
| STT | WebView2 `SpeechRecognition` (en-GB) | Whisper (local) / cloud |
| TTS | WebView2 `SpeechSynthesis` | ElevenLabs / Azure neural |

## Wiring Porcupine (the remaining seam)
`src/voice/wakeword.ts` already captures the mic and exposes a live RMS level. To finish on-device detection:

```ts
import { Porcupine } from "@picovoice/porcupine-web";
// in PorcupineWakeWord.start():
const porcupine = await Porcupine.create(
  this.cfg.accessKey!,
  { publicPath: "/bev.ppn", label: "BEV" },
  (detection) => { if (detection.label === "BEV") onWake(); },
);
// feed 16kHz int16 frames from a WebVoiceProcessor into porcupine.process()
```

Install: `npm i @picovoice/porcupine-web @picovoice/web-voice-processor`. The code deliberately **does not fake** a detection — until this is wired, `start()` throws a clear setup message and the shortcut/tray path drives activation.

## VAD & follow-ups
`listenOnce` resolves on the recognizer's silence (`onend`), and the controller races it against an 8s conversation timeout. After a reply, it loops back to `listening` without a new wake word; silence ends the conversation. "BEV, stop" aborts via `AbortSignal` and cancels TTS.

## Barge-in
While BEV speaks, the controller holds an `AbortController`; calling `interrupt()` cancels the TTS and the in-flight model turn so the user can talk over it.
