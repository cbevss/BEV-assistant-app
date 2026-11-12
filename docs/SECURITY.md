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
10. **Prompt-injection posture.** Web/screen content fed to the model is data, not commands; tool execution is gated by the validated registry + approval, so page text can't trigger an unapproved sensitive action.

## Not present (by design)
No remote-access, no telemetry/analytics, no auto-updates that run code without the user, no bypassing Windows security. Screen awareness and file tools ship **after** their explicit permission UI.
