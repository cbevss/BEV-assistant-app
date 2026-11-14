# BEV — implementation status

Honest state of every feature. **Live** = built + logic verifiable. **Partial** = backend wired, UI/polish remaining. **Unverified** = code complete but not yet run on hardware here (no npm/cargo build executed in this environment). **Future** = scheduled, not started.

> **Build status (verified on the target PC, 2026-11-12):** `npx tsc --noEmit` clean · `npm test` 20/20 pass · `cargo check` clean (no warnings) · `vite build` succeeds · the app launches and runs. So "Unverified" below now means **compiles and the app runs, but this specific feature hasn't been exercised end-to-end on hardware** (needs a mic, an API key, or a real monitor), not "never built".

## Phase 2 additions (this session)
| Feature | State |
|---|---|
| Persistent settings store (survives restart) | Live |
| Personality styles + response length + memory-in-prompt | Live |
| OpenAI provider + unified provider factory | Live |
| Tool-call history pairing (fixes provider 400s) + tests | Live |
| Integrations page (provider pick, key save/remove, live connection test) | Live (test needs a key/Ollama) |
| Voice & Audio page (mic list, live input meter, voice list + test, sliders) | Live (needs mic grant) |
| Memory page (search/add/edit/export/delete + sensitive-data filter + tests) | Live |
| Routines engine (steps, conditions, delays, retries, approval, cancel) | Live |
| create/run/list routine tools + instant voice fast-path | Live |
| Automation Centre UI (run with live per-step status, editor, schedule field) | Live |
| Security page (per-tool permission toggles, action log viewer, privacy kill-switch) | Live |
| Appearance page (accent, overlay placement via native cmd, reduced motion) | Live (overlay move is real; full theming incremental) |
| Settings page (start-with-Windows, personality, proactive thresholds, reset) | Live |
| First-run onboarding wizard (7 steps, real mic/provider/voice tests) | Live |
| Extra Windows tools: lock, power, screenshot, settings pages, monitors | Unverified (compiles; exercise on hardware) |
| Scheduled routines firing on their own (minute scheduler, day-of-week, once-per-minute guard, tray notification, approval surfacing) | Live |
| GPU usage / brightness on this desktop | Partial — honest n/a (no sensor bridge / monitor doesn't expose WMI brightness) |

## Phase 1 — Foundation
| Feature | State |
|---|---|
| Tauri 2 + React + TS + Tailwind project | Unverified (needs `npm install`) |
| Two-window setup (main + transparent overlay) | Unverified |
| Rust command layer + typed TS bridge | Unverified |
| SQLite store (memories + action log) | Unverified |
| OS keyring secret storage | Unverified |
| System tray + menu + close-to-tray | Unverified |
| Structured logging (tauri-plugin-log) | Unverified |

## Phase 2 — Interface
| Feature | State |
|---|---|
| Sci-fi theme (charcoal/cyan/violet, glass panels) | Live |
| Animated orb + rotating rings + glow | Live |
| 8 assistant states + transitions | Live |
| Voice-reactive waveform (real audio level) | Live |
| Sidebar router + 9 sections | Live (Dashboard + Chat full; others wired-placeholder) |
| Live Dashboard (real telemetry) | Unverified (logic complete) |
| Approval modal | Live |

## Phase 3 — Voice
| Feature | State |
|---|---|
| Mic capture + RMS level for visualiser | Unverified |
| Web Speech STT (British English, VAD via silence) | Unverified |
| Web Speech TTS (calm/masculine default) | Unverified |
| Conversation loop + follow-up window | Unverified (logic complete) |
| "BEV, stop" interrupt + barge-in | Unverified (logic complete) |
| **On-device "hey BEV" wake word (openWakeWord)** | Engine verified in Chrome against reference audio and the Python reference scores; needs a model trained with `training/train_hey_bev.ipynb` (`docs/WAKE_WORD.md`). Unverified on a real PC/WebView2. |
| Whisper STT / ElevenLabs TTS upgrade | Future |

## Phase 4 — Intelligence
| Feature | State |
|---|---|
| Provider interface (Anthropic/OpenAI/Ollama) | Live |
| Anthropic provider (tool-calling) | Unverified (needs API key) **FILL:** `anthropic_api_key` |
| Ollama provider (local, tool-calling) | Unverified (needs Ollama running) |
| OpenAI provider | Future (interface ready) |
| Multi-step orchestration + context | Live |
| Structured tool calling | Live |
| Memory tools (remember/recall) | Unverified (logic complete) |
| Action verification (never fake success) | Live |

## Phase 5 — Desktop control
| Feature | State |
|---|---|
| Volume set/get/mute (Core Audio) | Unverified (logic complete, Windows-only) |
| App launch/close (no arbitrary shell) | Unverified |
| Window enumerate/focus | Unverified |
| System info tools | Unverified |
| Open website / web search | Unverified |
| Permission gating on sensitive tools | Live |
| GPU usage | Partial — honest `n/a` until an AMD ADLX bridge is added. **FILL:** ADLX SDK integration |
| Brightness / Wi-Fi / Bluetooth / screenshot / lock / power | Future (tool seams planned) |
| File management tools | Future |

## Phase 6 — Advanced
| Feature | State |
|---|---|
| Routines / automation engine + editor | Future (Automation page is the entry) |
| Screen awareness (vision) | Future |
| Gaming Mode | Future |
| Proactive event monitoring (temp/RAM thresholds) | Future |

## Phase 7 — Polish & release
| Feature | State |
|---|---|
| Error handling / fail-closed | Live |
| NSIS installer config (CI renames output to `BEV-Setup.exe`) | Unverified (needs `tauri:build`) |
| GitHub Actions build + test + release | Live (file present; runs on push) |
| App icons | **FILL:** add `src-tauri/icons/*` (run `npm run tauri icon ./logo.png`) |
| README + docs | Live |

## Acceptance tests (section 20) — how to verify
All require a real build on your PC; none could be executed in this environment.

1. **Wake word** — say "BEV" (speech recognition), or load a trained model and say "hey BEV" (on-device). Fallback: trigger via shortcut.
2. **Conversation** — set API key, open Chat, ask a question → spoken reply via TTS.
3. **PC control** — "set my volume to 30%" → check Windows volume mixer.
4. **App launch** — "open Notepad" → Notepad opens.
5. **Follow-up context** — speak a follow-up within the 8s window.
6. **Visual states** — watch the orb through a command.
7. **Privacy** — tray → Privacy mode → mic stops.
8. **Permissions** — "close Spotify" → Approve/Cancel modal appears.
9. **Voice output** — reply plays on the selected device.
10. **Background** — focus another app, trigger BEV.
11. **Persistence** — add a memory, restart, confirm it survives (SQLite).
12. **Failure recovery** — pull network, send a chat → readable error, no crash.

## Immediate next files (ordered)
1. `src-tauri/icons/*` + `logo.png` (required before `tauri:build`).
2. ~~Wake-word engine wiring~~ done: openWakeWord on-device engine (`src/voice/oww`).
3. Settings/Integrations UI: provider + key entry (calls `native.storeSecret`).
4. Voice & Audio page: device enumeration (`navigator.mediaDevices`), voice list, sensitivity.
5. Memory page UI over `native.memoryList/Delete`.
6. Routines engine + Automation editor.
7. OpenAI provider (interface already defined).
8. First-run onboarding wizard.
