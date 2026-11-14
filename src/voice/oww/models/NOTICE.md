# Third-party models

`melspectrogram.onnx` and `embedding_model.onnx` are the shared feature models from
[openWakeWord](https://github.com/dscripka/openWakeWord) release v0.5.1, unmodified.

- openWakeWord code: Apache License 2.0.
- openWakeWord's pre-trained models are licensed under
  [Creative Commons Attribution-NonCommercial-ShareAlike 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
- The embedding model is a re-implementation of Google's
  [speech_embedding](https://tfhub.dev/google/speech_embedding/1) model (Apache License 2.0).

They are included for BEV's non-commercial, personal use. Using BEV commercially would
need these models replaced or separately licensed.

`../__fixtures__/alexa_v0.1.onnx` (openWakeWord pre-trained "alexa" model, CC BY-NC-SA 4.0)
and the two test clips from openWakeWord's test suite are used only by the unit tests.
