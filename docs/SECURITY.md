# BEV — security model

1. **Normal user privileges.** No admin, ever, for ordinary function.
2. **No arbitrary shell from the model.** The AI selects a *named* tool and passes arguments. `src/ai/tools.ts` validates every argument before any native call; `apps.rs` rejects shell metacharacters and launches via the shell's App-Paths resolver, not a raw command line.
3. **Fail closed.** Every Rust command returns `Result`; a bad input yields `Err`, never a fabricated success. The orchestrator surfaces the error and never tells the user an action happened unless the tool confirmed it.
4. **Permission gating.** Tools marked `sensitive` (e.g. `close_app`) raise an Approve/Cancel modal before running. More destructive tools (file delete, shutdown) will register as sensitive as they're added.
5. **Secrets in the OS keyring.** API keys go to the Windows Credential Manager via `secrets.rs`. They are never written to SQLite, the Tauri store, logs, or the frontend state.
6. **Execution timeouts.** Each tool call is bounded (15s) and cancellable via `AbortSignal` ("BEV, stop").
7. **Audit log.** Every tool call (name, args, result, ok) is written to the SQLite `action_log` for a local, inspectable history.
8. **CSP + HTTP allowlist.** `tauri.conf.json` restricts `connect-src` to the three AI hosts; the HTTP capability allowlists exactly those URLs.
9. **Mic/screen visibility + kill switch.** The overlay + sidebar always show mic state; Privacy mode (tray) instantly stops wake-word processing and mic capture.
9d. **AI keys go only to their own provider.** Each provider's key is read from Windows Credential Manager per request and sent only to that provider's API (chat and its model list); the app can only reach the provider addresses listed in `src-tauri/capabilities/default.json`. When BEV falls back to a backup AI, the conversation goes to that provider instead.
9c. **Accounts are end-to-end encrypted.** When accounts are switched on, memories, notes and the profile are encrypted on the device (AES-256-GCM, key wrapped by the passphrase via PBKDF2 and by a recovery key) before syncing; the accounts service stores only ciphertext, opaque record ids and minimal account data. Sign-in is Discord OAuth through the service with a PKCE-bound one-time code on a loopback redirect; session tokens are stored hashed. See [ACCOUNTS.md](ACCOUNTS.md).
9b. **Hands-on control keeps its limits.** BEV can click, type, press keys, scroll, hover and drag to do tasks on screen, but it refuses terminals, the Run box, Start search, password boxes and fullscreen games, never enters passwords or payment details, doesn't get past captchas or security checks, and asks before pressing a form's final Submit/Send/Pay unless told to submit. Dragging onto the Recycle Bin needs approval. None of the screen-control tools run in routines or unattended background tasks.
9a. **Screen replay is opt-in and in memory only.** Off until the user switches it on in Privacy & security. While on, BEV keeps the last 15 minutes of the display the mouse is on, downscaled and JPEG-encoded in RAM: two frames a second for the last minute, one every 5 seconds before that (about 25 MB), dropping frames older than 15 minutes. Nothing is written to disk. Frames go to the AI provider only when the user asks BEV to look back (`look_back`), and only the handful picked for that question. Privacy mode, revoking `look_back`, or turning the setting off stops capture and clears the buffer. Routines and background tasks can't use it, and the system bar shows REPLAY while it runs.
10. **Prompt-injection posture.** Web/screen content fed to the model is data, not commands; tool execution is gated by the validated registry + approval, so page text can't trigger an unapproved sensitive action.

## Teaching BEV tasks

- **"Show BEV how" recording** uses low-level Windows mouse and keyboard hooks only while you've pressed Start, and stops by itself after 5 minutes. Events stay in memory on your PC, are turned into steps you review, and are thrown away; nothing is uploaded. Typing into password boxes is dropped before you see the steps, and clicks inside BEV itself are ignored.
- **Learned tasks** are only kept from turns where every step succeeded without needing your approval, and never from clicks at screen positions. Replays go through the normal approval checks, so a sensitive button still asks first. A task that fails three times in a row is forgotten.
- **Hands-on routines** (taught or learned) can click and type, so they only run when you ask; they can't be scheduled, and background jobs can't use `use_named_control`.

## Files

- BEV's file tools never touch Windows, Program Files, ProgramData, AppData, `$Recycle.Bin` or `System Volume Information`, and refuse paths with `..`. These checks are in the native code (`filemgr.rs`), so the AI can't talk its way past them.
- A drive, your user folder and main folders like Downloads or Documents can be looked in and moved into, but never moved, renamed or deleted themselves.
- Nothing is overwritten (clashes become "name (2)"), and deleting only sends things to the Recycle Bin. Deleting always asks first, as do moves of more than 10 items and tidy-ups (you see what will go where).
- Moves, renames, copies and tidy-ups can be undone with "undo that" until BEV restarts.
- File and folder names are treated as untrusted text: while they're in the conversation, sensitive actions need your explicit approval.

## Not present (by design)
No remote-access, no telemetry/analytics, no auto-updates that run code without the user, no bypassing Windows security. Screen awareness and file tools ship **after** their explicit permission UI.
