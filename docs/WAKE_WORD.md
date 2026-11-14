# On-device wake word ("hey BEV")

BEV can listen for its wake word in two ways (Voice & Audio → Wake word → Engine):

| Engine | Setup | Where the listening happens |
|---|---|---|
| **Speech recognition** (default) | None | The WebView2 speech service. Responds to "BEV", "hey BEV", "yo BEV" |
| **On-device (openWakeWord)** | Train a model once (about an hour, free) | Entirely on your PC. Responds to "hey BEV" |

If on-device is selected but no model is loaded, or the model fails to start, BEV falls back to speech recognition and says so on the Voice & Audio page, so the wake word never just goes dead.

## Train your model

1. Open the notebook in Google Colab:
   **[train_hey_bev.ipynb](https://colab.research.google.com/github/cbevss/BEV-assistant-app/blob/main/training/train_hey_bev.ipynb)**
2. **Runtime → Change runtime type → T4 GPU** (free), then Save.
3. **Runtime → Run all.** It takes roughly an hour; keep the tab open.
4. Step 9 prints how many "hey BEV" clips the model catches and how many sound-alikes ("hey Ben", "hey Beth"…) it wrongly triggers on.
5. Step 10 downloads `hey_bev.onnx`.

The notebook needs a free Google account and nothing else. It generates thousands of synthetic voices saying "hey BEV", mixes them with room echo and background noise, and trains a small detector against about 2,000 hours of ordinary audio so everyday speech and TV don't set it off.

## Load it into BEV

1. **Voice & Audio → Wake word → Engine: On-device (openWakeWord)**.
2. **Load model** and pick `hey_bev.onnx`. BEV checks the file before saving it.
3. Press **Test** and say "hey BEV" a few times. The bar shows the model's score live; the white line is the trigger point.
4. Adjust **Wake-word sensitivity** (in the Conversation section):
   - Missing you? Raise it.
   - Going off from the TV or music? Lower it.
   50% is a trigger point of 0.5; 100% is 0.1; 10% is 0.82.

## Why "hey BEV" and not "BEV"

Short, one-syllable wake words match too many everyday sounds, so detectors built on them fire by accident. Two syllables is about the minimum for a reliable on-device wake word. To train something else (for example "okay BEV"), change `WAKE_PHRASE` in step 1 of the notebook.

## How it works

- `src/voice/oww/capture-worklet.js`: an AudioWorklet reads the mic and hands over 16 kHz chunks of 80 ms (it resamples itself if the browser can't).
- `src/voice/oww/pipeline.ts`: a port of openWakeWord's streaming pipeline. Each chunk goes through the melspectrogram model, then the speech-embedding model, and the last 16 embeddings go to your wake-word model, which returns a 0–1 score. A test checks it against scores from the official Python implementation (they agree to within 0.00001).
- `src/voice/oww/engine.ts`: runs the models with onnxruntime-web (WebAssembly, loaded from BEV's own files, never a CDN) and reports a wake when the score crosses the threshold, at most once every 2 seconds.

## Credits and licences

- [openWakeWord](https://github.com/dscripka/openWakeWord) by David Scripka. The code is Apache-2.0. The bundled `melspectrogram.onnx` and `embedding_model.onnx` feature models are distributed by that project, whose pre-trained models are licensed CC BY-NC-SA 4.0; the embedding model derives from Google's Apache-2.0 [speech_embedding](https://tfhub.dev/google/speech_embedding/1). See `src/voice/oww/models/NOTICE.md`.
- [piper-sample-generator](https://github.com/rhasspy/piper-sample-generator) (MIT) generates the training voices.
- Training data used by the notebook: MIT environmental impulse responses, AudioSet, the Free Music Archive and openWakeWord's pre-computed ACAV100M features, each under its own licence.

Picovoice Porcupine was the original plan for this. Picovoice ended its free tier on 30 June 2026, and its engine won't start without a valid paid key, so BEV uses openWakeWord instead.
