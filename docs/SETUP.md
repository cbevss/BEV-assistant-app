# BEV — setup

## 1. Toolchain
- **Node 20+** — https://nodejs.org
- **Rust (stable)** — https://rustup.rs
- **WebView2** — preinstalled on Windows 11.
- Visual Studio Build Tools with the **Desktop development with C++** workload (for the Rust MSVC linker).

```bash
npm install
npm run tauri:dev
```

## 2. App icons (required before building the installer)
Drop a square PNG at the repo root as `logo.png`, then:
```bash
npm run tauri icon ./logo.png
```
This generates `src-tauri/icons/*` referenced by `tauri.conf.json`.

## 3. AI provider (pick one)
**Anthropic / OpenAI** — paste your key in **Settings → Integrations**. It is stored in the Windows Credential Manager under `com.cbevss.bev` (keys: `anthropic_api_key`, `openai_api_key`). Never committed.

**Ollama (fully local)** —
```bash
ollama pull llama3.1
ollama serve        # exposes http://localhost:11434
```
Then select *Ollama (local)* in Chat / Settings.

## 4. Wake word
Saying "BEV" works out of the box through speech recognition, and so do the **Ctrl+Alt+B** shortcut and the tray.

For a wake word that runs entirely on your PC, train a free "hey BEV" model in Google Colab and load it in Voice & Audio. See [`WAKE_WORD.md`](WAKE_WORD.md).

## 5. Build the installer
```bash
npm run tauri:build
# → src-tauri/target/release/bundle/nsis/BEV_1.0.0_x64-setup.exe
```
