# BEV — voice pipeline

```
wake word ──▶ activating ──▶ listening (STT + VAD) ──▶ thinking/executing (AI + tools) ──▶ speaking (TTS) ──▶ follow-up window ──▶ idle
```

Everything is orchestrated by `src/voice/controller.ts` and driven by the shared state machine in `src/state/assistant.ts`. The overlay reads that state and the live audio level.

## Engines (swappable)
| Stage | Default (works today) | Upgrade |
|---|---|---|
| Wake word | WebView2 `SpeechRecognition` listening for "BEV", plus Ctrl+Alt+B / tray | **openWakeWord** on-device ("hey BEV"), see [`WAKE_WORD.md`](WAKE_WORD.md) |
| STT | WebView2 `SpeechRecognition` (en-GB) | Whisper (local) / cloud |
| TTS | WebView2 `SpeechSynthesis` | ElevenLabs / Azure neural |

## Wake word engines
Both implement `WakeWordEngine` (`src/voice/types.ts`) and are chosen in Voice & Audio:

- `WebSpeechWakeWord` (`src/voice/wakeword.ts`): continuous speech recognition, matching "BEV" in the transcript. Zero setup.
- `OnDeviceWakeWord` (`src/voice/oww/engine.ts`): openWakeWord models in WebAssembly, fed by an AudioWorklet. Needs a model trained with `training/train_hey_bev.ipynb`.

The controller falls back to speech recognition if the on-device engine has no model or fails to start, and reports why on the Voice & Audio page. Full details: [`WAKE_WORD.md`](WAKE_WORD.md).

## VAD & follow-ups
`listenOnce` resolves on the recognizer's silence (`onend`), and the controller races it against an 8s conversation timeout. After a reply, it loops back to `listening` without a new wake word; silence ends the conversation. "BEV, stop" aborts via `AbortSignal` and cancels TTS.

## Barge-in
While BEV speaks, the controller holds an `AbortController`; calling `interrupt()` cancels the TTS and the in-flight model turn so the user can talk over it.


## Conversation and turn-taking

- **When you've finished a sentence:** BEV waits a little less after a sentence that sounds finished ("open Spotify please") and longer when you trail off ("open Spotify and…", "um"), so it neither cuts you off nor makes you wait. (Windows speech engine; the on-device Whisper engine uses a fixed pause.)
- **After BEV replies** (Voice & microphone → After BEV replies):
  - **Smart** (default): BEV keeps listening for the full follow-up window only when it asked you something. Otherwise it listens for about 4 seconds, and checks that what it hears is meant for it. Quick rules catch the obvious cases ("BEV…", "yeah go on", "bro did you see that"); anything unclear gets a quick yes/no from the fast model (under 2 seconds). If you've turned to friends on a call, BEV stops quietly without answering.
  - **Keep listening:** the old behaviour; everything in the window is for BEV.
  - **Stop:** one request per "Hey BEV".
- **Ending it yourself:** press the talk shortcut again, or say "that's all", "stop" or "I wasn't talking to you".
- Talking over BEV (with "Interrupt by talking" on) keeps the conversation open for your reply.
