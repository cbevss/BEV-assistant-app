# BEV codebase audit and evolution roadmap

Audited 17 Nov 2026 against the "BEV — The Next Evolution" specification.
Baseline: `main` @ `afec703` (v1.1.6), plus open PRs #11 (speech fixes, 1.1.7)
and #12 (BEV Cloud, 1.1.8). This document is the feature inventory the spec
asks for and the plan the work follows.

## Stack

| Layer | What it is |
|---|---|
| Shell | Tauri 2 (Rust), single instance, tray, auto-updater (signed releases) |
| UI | React 18 + TypeScript + Tailwind, zustand stores, Vite |
| AI | Provider-neutral orchestrator (`src/ai`), Claude / OpenAI / Ollama, tool loop |
| Voice | Wake word: WebView2 speech or on-device openWakeWord (ONNX, AudioWorklet). STT: WebView2 Web Speech. TTS: ElevenLabs → Kokoro (WebGPU/CPU worker) → Windows voices |
| Native | `src-tauri/src/*.rs`: apps, windows, audio (Core Audio), screen (xcap), Steam games, files, power, sysinfo |
| Storage | SQLite (memories, action log), tauri-plugin-store (settings), Windows Credential Manager (keys) |
| Cloud | `cloud/` Cloudflare Worker: Telegram, tracked tasks, urgent calls (PR #12) |
| Tests | 146 desktop (vitest), 35 cloud, 11 Rust unit tests; Windows CI build on every PR |

## Feature inventory

### Implemented and working
- Voice loop: wake word → listen → AI → speak, with follow-ups, "that's all" dismissal, barge-in by voice ("stop"), mute hotkey, push-to-talk hotkey.
- On-device wake word (built-in "hey BEV", several phrases, test meter, sensitivity).
- Natural TTS chain with fallback; output-device selection.
- Screen awareness: screenshot tool (overlay excluded), foreground window in context.
- Steam game launch with online/offline launch options.
- Routines (scheduled / manual), automation editor, open file/folder step.
- Memory: key/value memories with categories, edit/delete UI.
- Approval prompts for sensitive tools; per-tool revocation; action audit log.
- Game-aware popup (never steals focus; hidden over exclusive fullscreen).
- Auto-release on version bump; signed auto-updates.

### Partial
- **App launching**: hard-coded alias table (12 names) + `cmd /C start <name>`. Can't open Microsoft Store apps by name (e.g. AntiMicro), doesn't know what's installed, can't disambiguate, and reports success without checking anything opened.
- **Close app**: `taskkill /F` on a guessed image name: force-kills (unsaved work lost), often the wrong image.
- **Memory**: exact key/value; no semantic search, duplicate detection, conversation history or sources.
- **System monitoring**: CPU/RAM live; GPU usage and temperatures unavailable.
- **Mic handling**: input device choice and level meter exist; no hot-plug detection, clipping/noise diagnosis or calibration.
- **Agent loop**: sequential tool calls with one provider retry; no plan/verify step, no background tasks, fixed 15 s timeout for every tool.

### Broken / risky
- **Prompt injection with "Trust my requests" on**: auto-approve applies even when the instruction came from screen/web/file content, so untrusted content could trigger a sensitive action without asking.
- **No task recovery**: nothing records an in-progress task, so after a crash BEV doesn't know what it was doing.
- Launch "success" is the exit code of `cmd start`, not evidence an app opened.

### Missing
- Application discovery/index (Start apps, Store packages, shortcuts, App Paths), resolution and verified execution.
- UI Automation, OCR, mouse/keyboard control (vision is screenshot → model only).
- Diagnostics (event logs, services, devices, drivers, network tests).
- Browser control beyond "open URL"; web research pipeline on the desktop.
- Semantic memory / knowledge vault; conversation search.
- Integrations (Gmail, Calendar, GitHub, Spotify, Discord, Home Assistant, MCP).
- Design system documentation; HUD.

### Security posture
- Good: keys in Credential Manager; no arbitrary shell from the AI; `open_path` uses explorer with a single argument; screen/web text labelled as data in the prompt; approvals for power/close/programs.
- Gaps: injection-tainted auto-approval (above); `launch_app` builds a `cmd` line (mitigated by a character blacklist, but a structured launcher removes the class entirely); force-kill on close.

### Performance
- Idle: on-device wake word is the main steady cost (ONNX per 80 ms frame); everything else is event-driven.
- No continuous vision or polling loops. The Kokoro model loads lazily.

## Roadmap (spec phases mapped to this codebase)

Order follows the spec's rule: build the underlying systems first, then connect the AI.

| Phase | Scope | Status |
|---|---|---|
| A. Foundation | Safety layer (untrusted-content guard, risk levels), task journal + crash recovery, per-tool timeouts | **Done in 1.1.9** |
| B. Windows intelligence | App discovery + persistent index, resolver (aliases, ranking, ambiguity, not-installed), execution (Store activation, Win32, shortcuts, URIs), launch verification, graceful close, default browser | **Done in 1.1.9** (browser page control → D) |
| C. Voice | Mic hot-plug + default-device tracking, calibration (level, clipping, noise floor), Whisper option for STT, barge-in while speaking | Next |
| D. Vision & control | UI Automation tree reading + invoke, OCR (Windows.Media.Ocr), keyboard/mouse fallback, hands-on troubleshooting flows | Next |
| — Diagnostics | Read-only event log, services, devices, drivers, network tools | With D |
| E. Second brain | Conversation history, semantic memory (local embeddings), duplicates/contradictions, knowledge vault with sources | Later |
| F. Advanced AI | Plan → act → verify loop, background tasks with progress/cancel, model routing per workload | Later |
| G. Interface | Design-system tokens doc, HUD with real data, state visuals | Later |
| H. Integrations | Connector framework + MCP; Gmail/Calendar/GitHub/Spotify/Home Assistant | Later |
| I. Proactive | Desktop background monitoring (crashes, device loss, resource spikes), briefings (cloud side exists) | Later |

## What 1.1.9 changed (Phases A and B)

**App engine** (`src-tauri/src/appengine/`), replacing the 12-name table and `cmd /C start`:
- `discover`: one hidden PowerShell scan collects Start apps (AUMIDs, as `Get-StartApps`), Store packages (family, install dir, exe from `AppxManifest.xml`), Start Menu and desktop shortcuts, App Paths, and the default browser / music player.
- `model`: merges these into one index. It resolves known-folder AppIDs, follows Squirrel `Update.exe --processStart`, drops uninstallers and duplicates, and adds 20 Windows tools (Device Manager, Event Viewer, sound settings…).
- `resolve`: normalising, aliases, vendor-less names, word prefix, acronym and typo scoring. Outcomes are found, ambiguous (BEV asks) or not installed (with a Store link where known, e.g. Antimicro).
- `launchplan`: Store apps → `IApplicationActivationManager`; exe / shortcut / URI / tool → `ShellExecuteEx`; Start entry with no exe → `shell:AppsFolder`. Unsafe AppIDs are refused.
- `launch`: if the app is already open, it's brought to the front instead of starting a duplicate. After launch BEV watches for the new window (by PID, image name or hosted-window title) and reports opened / starting / unverified / failed. Close asks the app to close (WM_CLOSE). Force-closing is separate and needs approval.
- `engine`: the index is saved to disk and loaded instantly. It rescans in the background when older than 12 h, on request, and once on a miss (to catch just-installed apps).

**Safety:** results from the screen, other apps' window titles and web-derived task results are fenced as untrusted data. While such content is in the conversation, sensitive actions always ask, even with "Trust my requests" on.

**Task journal:** each request, its steps and its outcome are stored in SQLite. Runs left "running" are marked interrupted at the next start, and BEV is told once. Dashboard → Recent tasks.

**Tested here:** 18 Rust unit tests (merge, resolve, launch plans, window matching, engine flows with a fake scanner/launcher, journal on real SQLite) and 156 desktop tests (including the injection guard, verified to fail when the guard is removed).
**Not testable here:** the Windows calls themselves (the scan, activation, ShellExecuteEx, window watching). They compile in Windows CI but need checking on a real PC (see the PR's test list).
