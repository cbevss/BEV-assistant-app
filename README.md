<div align="center">

# BEV

**A futuristic, always-available AI voice assistant for Windows 11.**

Deep-charcoal holographic overlay · local wake word · provider-agnostic AI brain · real PC control.

Built with Tauri 2 · Rust · React · TypeScript · Tailwind.

</div>

---

> **Status: v1.0.0 foundation — working vertical slice, not yet a signed release.**
> The core is real and compiles: live system telemetry, Windows volume control, app launching, window management, SQLite memory, OS-keyring secrets, the animated overlay + state machine, the provider-agnostic AI brain with structured tool-calling, and a working text/voice chat path. An on-device "hey BEV" wake word is available once you train a model (free, in Colab). See [`CHECKLIST.md`](CHECKLIST.md) for the exact live / partial / unverified / future breakdown — nothing here is claimed done that wasn't built.

## What works today

- **Real system telemetry** — CPU %, RAM used/total, core count, uptime, top processes. Live `sysinfo` readings, polled every 2s. No invented numbers.
- **Real PC control** — Windows master volume + mute via Core Audio; launch/close apps by friendly name; enumerate and focus windows. Every command validates its arguments and **fails closed** — it never reports success the OS didn't confirm.
- **Provider-agnostic AI brain** — Anthropic Claude, OpenAI-style, and local Ollama behind one interface, with **structured tool-calling**, a multi-step orchestration loop, interruption via `AbortSignal`, and action logging.
- **Permission gating** — sensitive tools (e.g. closing an app) raise an **Approve / Cancel** modal before anything runs. API keys live in the **Windows Credential Manager**, never in SQLite, logs, or the UI.
- **The overlay** — a transparent, always-on-top, click-through holographic orb with eight animated states (idle → activating → listening → thinking → speaking → executing → completed → error) and a **voice-reactive** waveform driven by real mic/TTS level.
- **Voice path** — working speech-in/speech-out via the WebView2 Speech APIs out of the box (British English), with an on-device openWakeWord "hey BEV" wake word ([`docs/WAKE_WORD.md`](docs/WAKE_WORD.md)) and Whisper/ElevenLabs as upgrades.
- **Memory** — SQLite-backed `remember` / `recall` tools the model can call; inspectable and deletable.
- **Tray + background** — close-to-tray, tray menu (Open / Toggle listening / Privacy mode / Quit), autostart plugin.

## Architecture

```
src/                      React + TS frontend
  state/assistant.ts      shared state machine (single source of truth)
  overlay/                transparent overlay window + animated orb + waveform
  ai/                     provider-agnostic brain
    types.ts              AiProvider / Tool contracts
    providers/            anthropic · ollama (· openai next)
    tools.ts              validated, permission-gated tool registry
    orchestrator.ts       multi-step loop + approval + timeouts
  voice/                  wake word · STT · TTS · controller (the glue)
  ui/                     main window: sidebar router, pages, components
  lib/native.ts          typed bridge to Rust commands
src-tauri/                Rust backend
  src/audio.rs            Core Audio volume/mute
  src/apps.rs             app launch/close (no arbitrary shell)
  src/sysmon.rs           live telemetry
  src/windows_mgmt.rs     window enumerate/focus
  src/overlay.rs          overlay show/hide/clickthrough/position
  src/db.rs               SQLite memory + action log
  src/secrets.rs          Windows Credential Manager
  src/tray.rs             system tray
```

Clean seams everywhere: providers, speech engines, and tools are swappable behind interfaces.

## System requirements

- Windows 11 (x64). Developed against Ryzen 7 7700 / RX 9060 XT / 32 GB.
- [Node 20+](https://nodejs.org), [Rust stable](https://rustup.rs), and the WebView2 runtime (ships with Win11).
- Optional: an Anthropic/OpenAI API key **or** [Ollama](https://ollama.com) for a fully local brain; optionally a "hey BEV" model trained in Google Colab for the on-device wake word.

## Run from source

```bash
npm install
npm run tauri:dev
```

## Build the installer

```bash
npm run tauri:build
```

Produces `src-tauri/target/release/bundle/nsis/BEV_1.0.0_x64-setup.exe` (CI publishes it as `BEV-Setup.exe`). CI (`.github/workflows/build.yml`) builds + tests on every push and attaches the installer; tagging `v1.0.0` publishes a GitHub Release with it.

## First-run setup

1. Launch BEV → onboarding wizard.
2. Pick a microphone and AI provider; paste your API key (stored in Credential Manager) or point at Ollama.
3. Choose a voice, review mic/automation permissions, done.

See [`docs/SETUP.md`](docs/SETUP.md) for keys, [`docs/WAKE_WORD.md`](docs/WAKE_WORD.md) for the on-device wake word, and [`docs/VOICE.md`](docs/VOICE.md) for the voice pipeline.

## Security

Runs as a normal user. No admin. No arbitrary shell execution by the model — only validated, allowlisted tools. Destructive and sensitive actions require explicit approval. Mic/screen access is visible and killable (Privacy mode). Full model in [`docs/SECURITY.md`](docs/SECURITY.md).

## Tests

```bash
npm test          # vitest — tool validation + registry
npm run typecheck # tsc --noEmit
```

## Licence

MIT — see [`LICENSE`](LICENSE).
