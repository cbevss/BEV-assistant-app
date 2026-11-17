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
| C. Voice | Mic hot-plug + default-device tracking, calibration (level, clipping, noise floor), Whisper option for STT, barge-in while speaking | **Done in 1.1.10** |
| D. Vision & control | UI Automation tree reading + invoke, OCR (Windows.Media.Ocr), keyboard/mouse fallback, hands-on troubleshooting flows | **Done in 1.1.11** |
| — Diagnostics | Read-only performance, network, event-log stability and mic checks | **Done in 1.1.11** (services/devices/drivers later) |
| E. Second brain | Conversation history, semantic memory (local embeddings), duplicates/contradictions, knowledge vault with sources | **Done in 1.1.12** |
| F. Advanced AI | Plan → act → verify loop, background tasks with progress/cancel, model routing per workload | **Done in 1.1.13** |
| G. Interface | Design-system tokens doc, HUD with real data, state visuals | **Done in 1.1.14** |
| H. Integrations | Connector framework + MCP; Gmail/Calendar/GitHub/Spotify/Home Assistant | **Done in 1.1.15** |
| I. Proactive | Desktop background monitoring (crashes, device loss, resource spikes), briefings (cloud side exists) | **Done in 1.1.16** |

## What 1.1.17 changed (research and device diagnostics)

- **Web research**: `web_search` uses Claude's built-in web search (`web_search_20250305`, on the fast model) when the provider is Anthropic, with no extra key. Otherwise it uses a Brave Search API key, which also serves as a fallback. `read_web_page` reads public pages through a Rust fetcher: GET only, http/https, at most 3 MB, no credentials in URLs. It resolves the host and refuses loopback, private, link-local, CGNAT and multicast addresses on every redirect hop, so injected content can't reach the router or local services. Page text is extracted locally (main/article first; scripts, nav and footers dropped). Both outputs count as outside content, and the persona answers with sources and offers to save notes. Background tasks can now do real research.
- **Device diagnostics** (`diagnose_pc` area "devices", fixed read-only script): present devices with Device Manager errors, in plain words (unplugged ones ignored); key auto-start services that aren't running (audio, networking, WMI, updates and so on); and graphics drivers over a year old.
- Browsers themselves are operated through UI Automation, OCR and keys (1.1.11).

## What 1.1.16 changed (Phase I)

- **Notices pipeline** (`src/proactive/notices.ts`): every proactive alert is de-duplicated with a cooldown and held back while a fullscreen game (exclusive or borderless) is in front or quiet mode is on. Afterwards it's delivered, as one summary if several piled up. The last six hours of notices go into the AI's prompt so BEV can bring them up when relevant, and they show on the Dashboard ("BEV noticed").
- **Watchers** (under Settings → Keep an eye on the PC, each switchable):
  - CPU/RAM thresholds (now routed through the pipeline);
  - app crashes and freezes, blue screens and unexpected shutdowns, from a 15-minute event-log window every 10 minutes, plus the last 24 hours at start-up;
  - the internet dropping (two misses in a row) and coming back, with the time it was down;
  - disks under 5% / 5 GB free, at most daily.
  - Device loss: the microphone fallback/return notices from 1.1.10 remain.
- **Daily briefing**: at a chosen time (due for three hours, once a day, so a sleeping PC still gets it), a quiet background task gathers whatever is connected (calendar, important unread email, tracked tasks, PC notices). It then posts the briefing to Chat, notifies, and speaks it if BEV is idle and quiet mode is off. Phone briefings remain on BEV Cloud.

## What 1.1.15 changed (Phase H)

- **Framework**: connector tools are added to the registry at call time from Integrations settings (`allTools` / `getTool`), so revoking, approvals, routines and the Security list all cover them. HTTP goes through `integration_fetch` in Rust. It allows only the fixed public API hosts plus origins the user saved in settings; the AI can't add hosts, and credentials in URLs are refused. Tokens live in the OS keyring.
- **OAuth** (Spotify, Google): PKCE with a one-shot 127.0.0.1 listener, the system browser, state check, and refresh. Spotify uses a fixed port (43117) because its dashboard needs the exact redirect URI.
- **Home Assistant**: find entities, control them (state read back afterwards), history. Locks, alarms and opening garage covers always need approval.
- **GitHub**: notifications, issues/PRs, PR checks; creating an issue needs approval.
- **Spotify**: now playing, controls, play by search or the user's playlists.
- **Gmail and Calendar**: search, read, drafts only (never sends), list and add events (no guests).
- **MCP**: stdio servers run as child processes started from user settings only, plus Streamable HTTP with session ids and SSE replies. Tools appear as `mcp_<server>_<tool>`. All output is untrusted; actions need approval unless the server is trusted or the tool is read-only.
- Setup guide: `docs/INTEGRATIONS.md`.
- **Discord** (1.1.17): the user's own bot token; list channels, read messages; posting needs approval and suppresses @mentions.
- **Not verified here**: no live calls to any of these services were possible from this environment. Payload shapes follow the public API docs; the pure helpers (matching, service mapping, MIME, SSE parsing, PKCE against the RFC 7636 vector) are unit-tested.

## What 1.1.14 changed (Phase G)

- `docs/DESIGN.md` documents the system: palette and semantic state colours, type roles and scale, surfaces, motion, writing and accessibility rules. `src/ui/design.ts` is the single source for state colours and words, used by the overlay orb, the sidebar and the Dashboard.
- **Dashboard status line**: what BEV is doing in words, a live mic/voice level trace in the state colour (only while listening or speaking), the current plan step, and live facts (wake engine, speech engine, reply models including routing, background tasks). Every value comes from live state.
- The sidebar's fixed "assistant online" text now shows the real state (privacy mode, mic off, or the current state).
- All-caps tracked labels became sentence case; live numbers use tabular figures. Keyboard focus is visible everywhere, and `prefers-reduced-motion` turns motion off.

## What 1.1.13 changed (Phase F)

- **Plan → act → verify**: `update_plan` keeps a visible step list (pending / in progress / done / failed / skipped, with evidence notes), shown live in Chat and on background tasks. If the model tries to finish with open steps, the orchestrator sends one check-back listing them. A planned task gets up to 20 tool rounds (8 otherwise), and running out is reported with what's left instead of ending silently.
- **Background tasks**: `start_background_task` runs a self-contained goal in its own orchestrator (own history, plan, AbortController), at most two at once. Progress, step log and result show on the Dashboard with Cancel, and a Windows notification fires on finish. Background runs get no screen, keyboard or mouse tools, never prompt; anything needing approval is refused and listed for the user. They also skip conversation history.
- **Model routing**: each round is classified quick / complex / vision. Quick rounds go to a faster model (default Claude Haiku 5.5 or GPT-4.1 nano; none for Ollama unless set), with a fallback to the main model on any error. Planned, multi-step, failing, background and screenshot rounds stay on the main model. There's a toggle and fast-model field in Integrations.
- **Not verified here**: no live provider calls were made; routing and the loop are tested with scripted providers.

## What 1.1.12 changed (Phase E)

- **Conversation history** (`brain.rs`): what the user and BEV said is kept in SQLite with an FTS5 index (porter stemming), grouped into conversations (new after 30 minutes' quiet or a cleared chat). Screenshots, tool output and web content are not stored, and text that looks like a key or card number is replaced. There's an on/off switch and a retention setting (default 90 days, pruned at start-up). `search_conversations` lets BEV look back; the Memory page can browse, search and delete.
- **Semantic memory**: all-MiniLM-L6-v2 (q8, ~23 MB) runs in a worker on the CPU; vectors are stored with each memory and note and backfilled in the background. Search ranks by meaning and words together and falls back to words alone when the model isn't available. With more than 40 memories, the prompt carries the ones relevant to the current request plus the most recent.
- **Duplicates and contradictions**: `remember` spots an existing memory with the same or a similar key (or a close meaning) and won't overwrite it silently. BEV asks, then saves with `replaces` or `distinct`. Updates report the old value.
- **Notes vault**: notes with title, body, tags and a source (URL, file or "conversation"), with full-text plus semantic search, and `save_note` / `search_notes` / `read_note` / `delete_note`. Note text is treated as outside content when read back.
- **Not verified here**: the embedding model couldn't be downloaded in this environment, so semantic ranking has only been tested with stand-in vectors. The SQL (FTS5, triggers, pruning, embeddings) is unit-tested against real SQLite.

## What 1.1.11 changed (Phase D)

**Control** (`src-tauri/src/control/`):
- `uia`: one worker thread owns the UI Automation client. `read_app_controls` fetches a window's control tree in one cached call, keeps interactive controls and readable text (capped, reading order, password values never read), and `use_control` operates them through Invoke/Toggle/SelectionItem/ExpandCollapse/Value patterns, reading the state back to verify. It falls back to a real click only when a control has no pattern, and says that result isn't confirmed.
- `ocr`: Windows.Media.Ocr on the front window, its display, or all displays, entirely on the PC, with word boxes mapped to desktop pixels (`read_screen_text`, `click_on_screen` by text).
- `input`: SendInput keys, Unicode typing and clicks; the pointer is put back afterwards. Screenshot points are mapped back to the desktop with the geometry of the last capture.
- `guard` (native hard limits): no typing or keys into terminals, the Run box, Start search, the Registry Editor or UAC prompts; never into password boxes; no Win+R / Win+X; no input while an exclusive-fullscreen game is in front; never BEV's own window.
- Approval (`sensitiveCheck`, live): clicking anything labelled delete/send/buy/install/sign out/allow…, Enter in messaging apps, and Shift+Delete ask first, saying why. Control tools are forbidden in routines.

**Diagnostics** (`src-tauri/src/diagnostics.rs`, `src/lib/diagnose.ts`): CPU/memory with the biggest users grouped by app, disk space, uptime, pending-restart updates; internet vs DNS vs blocked-traffic tests; a week of app crashes/freezes, blue screens and unexpected shutdowns from the event log (fixed script); microphone state. `diagnose_pc` reports plain findings with fixes, and the persona troubleshoots check → explain → fix with consent.

**Not verified on a real PC**: the UI Automation, OCR, input and event-log code is compiled by Windows CI only. Pure logic (key parsing, guards, element shaping, coordinate mapping, risk labels, findings) is unit-tested.

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
