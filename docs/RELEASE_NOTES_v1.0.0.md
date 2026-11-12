# BEV v1.0.0

The first stable build of **BEV** — a futuristic, always-available AI voice assistant for Windows 11.

## Install
Download **BEV-Setup.exe** below and run it. It installs per-user (no admin needed). Windows 11 already includes the WebView2 runtime BEV uses.

On first launch, a setup wizard walks you through microphone, AI provider and voice. You'll need either an API key (Anthropic or OpenAI) or a local model via [Ollama](https://ollama.com).

## Features
- **Holographic overlay** — a transparent, always-on-top animated core with eight live states (idle → listening → thinking → speaking → executing → done), reacting to real microphone and speech audio.
- **Natural voice conversations** — British-English speech in/out, follow-up questions without repeating the wake word, and "BEV, stop" to interrupt. Press **Ctrl+Alt+B** or add a free Picovoice key to say "BEV".
- **Real PC control** — set volume, launch/close apps, manage windows, read live CPU/RAM, lock/sleep/restart, screenshots, open Windows settings. Every action is validated and never faked.
- **Provider-agnostic AI brain** — Anthropic Claude, OpenAI, or fully-local Ollama, with structured tool-calling and multi-step tasks.
- **Routines** — build multi-step automations (Gaming/Focus/Streaming/Shutdown/Morning), trigger them by voice, and schedule them to fire on their own.
- **Memory** — BEV remembers preferences you approve, with a filter that refuses passwords and keys.
- **Security first** — sensitive actions need Approve/Cancel; API keys live in Windows Credential Manager; a privacy mode kills the mic instantly; every action is logged locally.

## Known limitations
- **Wake word** needs a free [Picovoice](https://console.picovoice.ai) key + a trained "BEV" keyword; until then, use Ctrl+Alt+B. 
- **GPU usage** and **monitor brightness** show as unavailable on hardware that doesn't expose them (most desktops).
- Scheduled routines fire while BEV is running (including minimised to tray), not while the app is closed.
- Screen-awareness (vision) and browser automation are planned for a later release.

## Build from source
Requires Node 20+, Rust stable, and VS C++ Build Tools.
```powershell
npm install
npm run tauri:dev     # run
npm run tauri:build   # build the installer
```

MIT licensed.
