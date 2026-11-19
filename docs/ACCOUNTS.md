# BEV accounts

BEV accounts let people sign in with Discord so BEV's memories go with them:
their memories, notes and how BEV talks to them (name, personality) sync
between their PCs, and later the web version on their phone.

**Everything synced is end-to-end encrypted.** It's encrypted on the user's
device before it's sent, with a key only they have. The accounts service
stores ciphertext it can't read.

## Turning accounts on

Until you do this, the app works exactly as before (no sign-in). Once it's
on, **everyone has to sign in** the next time they open BEV.

1. **Discord app.** In the [Discord Developer Portal](https://discord.com/developers/applications),
   open your BEV application (the bot's app is fine) → **OAuth2**. Copy the
   **Client ID**, and **Reset Secret** to get the **Client Secret**.
2. **GitHub secrets** (repo → Settings → Secrets and variables → Actions):
   - `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` from step 1
   - `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`: the same ones BEV Cloud
     uses (see [BEV_CLOUD.md](BEV_CLOUD.md)); the token needs **Workers Scripts: Edit**
     and **D1: Edit**.
3. **Deploy.** Actions → **BEV Accounts** → **Run workflow**. It tests,
   creates the `bev-accounts` database, deploys, and prints the address
   (like `https://bev-accounts.yourname.workers.dev`) in the run summary.
4. **Redirect.** Back in Discord → OAuth2 → **Redirects**, add
   `https://<that address>/auth/discord/callback` and save.
5. **Switch it on in the app.** Put the address in `src/account/config.ts`
   (`ACCOUNTS_URL`) and release. (Or tell Claude the address and it'll do it.)
   The app can only reach `*.workers.dev` addresses; a custom domain needs
   adding to `src-tauri/capabilities/default.json` too.

## What people see

- **Sign in with Discord** in their browser.
- **First device:** BEV shows a **recovery key** (8 groups of 4 characters)
  to save, then asks for a **passphrase** (10+ characters).
- **Another device:** type the passphrase (or the recovery key) once.
- After that BEV opens straight away, even offline, and syncs every couple of
  minutes. Settings → Account shows devices, lets them sign one out, change
  the passphrase, download their data or delete the account.
- **Forgotten passphrase and lost recovery key = synced memories can't be
  recovered.** That's the price of nobody else being able to read them. The
  memories already on their PC are unaffected.

## How the encryption works

- A random 256-bit **data key** per account. The server stores it only
  wrapped (AES-256-GCM) by a key derived from the passphrase
  (PBKDF2-SHA256, 600,000 rounds) and, separately, by the recovery key
  (160 random bits). Each device keeps the unwrapped key in Windows
  Credential Manager.
- Each memory, note and the profile is encrypted with AES-256-GCM using a key
  derived from the data key (HKDF), bound to its kind and id, so records
  can't be swapped or replayed under another id.
- Record ids are HMACs of the memory name or note id, so the server doesn't
  learn memory names.

## What the server does hold

Discord user id, display name and avatar; device names ("BEV on Windows")
and sign-in times; and for each record its opaque id, kind (memory, note or
profile), size and when it changed. Sessions are random tokens stored only as
hashes, valid for 180 days of inactivity. Account deletion erases all of it
immediately.

**Running this for other people makes you responsible for their data** (UK
GDPR): you'll want a short privacy notice saying what's stored (the list
above), why, and how to delete it (Settings → Account → Delete account). This
isn't legal advice.

## Deleting data

- **Settings → Advanced → Your data** (desktop): delete conversation history,
  memories, notes, activity history, the screen replay buffer, or saved keys
  and sign-ins, one at a time, or erase everything on the PC. While signed
  in, deleting memories or notes also deletes them on the user's other
  devices (that's what sync means); "Erase everything" signs the PC out
  first, so other devices keep their copies.
- **Account data** (same page, and Settings → Account): erase everything
  synced (`POST /data/erase`: content is deleted from the server at once and
  every device removes its copy on its next sync; the account stays), or
  delete the account (`DELETE /account`).
- The web version must offer the same controls; both endpoints are ready
  for it.

## Not synced (yet)

Conversation history, API keys and other secrets, connected services, app
permissions and PC-specific settings (microphone, shortcuts) stay on each PC.
The web version will need its own front end; the service already supports it
(add its origin to `WEB_ORIGINS` in `accounts/wrangler.toml`).
