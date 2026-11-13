# Publishing BEV to GitHub

The repo is already initialised and committed locally, with the remote set to
`https://github.com/cbevss/BEV-assistant-app.git` and a built installer ready.
Only **one interactive step** is needed from you: authenticating GitHub.

## One-time: authenticate
```powershell
gh auth login
```
Choose **GitHub.com → HTTPS → Login with a web browser**, and paste the one-time
code. (This is the step that can't be automated — it proves it's really you.)

## One-time: the update signing secret (for auto-updates)
The app auto-updates from signed releases. CI signs them with a private key that
must live in a GitHub secret (never committed — it's gitignored locally):
```powershell
gh secret set TAURI_SIGNING_PRIVATE_KEY < src-tauri/bev-update.key
```
Without this secret the release build fails to sign and auto-update won't work.
Keep `src-tauri/bev-update.key` safe — losing it means future updates can't be
signed and installed apps won't accept them.

## Publish v1.0.0 (two options)

### Option A — let GitHub Actions build + release (recommended)
Pushes the code and tags it; CI builds the installer on a clean Windows runner
and publishes the release with the `.exe` attached.
```powershell
cd C:\Users\cbevs\Projects\BEV
gh repo create cbevss/BEV-assistant-app --source . --public --remote origin --push
git tag v1.0.0
git push origin v1.0.0
```
Watch it: `gh run watch`. When it's green, the release is live at
`https://github.com/cbevss/BEV-assistant-app/releases`.

### Option B — publish the locally-built installer immediately
Uses the installer already built on this PC (path printed by the build).
```powershell
cd C:\Users\cbevs\Projects\BEV
gh repo create cbevss/BEV-assistant-app --source . --public --remote origin --push
gh release create v1.0.0 `
  "src-tauri\target\release\bundle\nsis\BEV_1.0.0_x64-setup.exe#BEV-Setup.exe" `
  --title "BEV v1.0.0" `
  --notes-file docs\RELEASE_NOTES_v1.0.0.md
```

## If the repo already exists
Skip `gh repo create` and just:
```powershell
git push -u origin main
```
then run the tag (Option A) or `gh release create` (Option B) step.

## Notes
- The repo is **public** so the installer is downloadable without a login — that
  matches the goal. Make it private instead by replacing `--public` with
  `--private` (downloads then require a GitHub login).
- No secrets are committed: `.gitignore` excludes `.env`, `*.db`, `*.ppn`, API
  keys (those live in Windows Credential Manager), `node_modules`, and build
  output.
