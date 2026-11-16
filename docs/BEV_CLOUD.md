# BEV Cloud: Telegram, task tracking and phone calls

BEV Cloud is the always-on half of BEV. It runs free on Cloudflare, so it keeps
working while your PC is off:

- **Telegram:** chat with BEV by text or voice note from anywhere. Replies come
  back as text plus a voice note in BEV's voice.
- **Tracking:** reminders, web page watches (prices, stock, changes), recurring
  checks BEV does itself (news, sites), and scheduled briefings.
- **Urgent things ring your phone:** a real two-way call in BEV's voice. You can
  talk back ("push it to tomorrow") and BEV changes your tasks during the call.
- **BEV on your PC** can hand things over: "hey BEV, keep an eye on…"

You set it up once (about 20 minutes). After that it updates itself whenever
BEV Cloud changes on `main`.

---

## 1. Telegram bot (2 minutes, free)

1. In Telegram, open **@BotFather** and send `/newbot`.
2. Pick a name (e.g. `BEV`) and a username ending in `bot`.
3. Copy the **token** it gives you (`123456:ABC…`).

## 2. Cloudflare (5 minutes, free)

1. Sign up at **dash.cloudflare.com**.
2. Open **Workers & Pages** once. If it asks you to choose a `workers.dev`
   subdomain, pick one (e.g. `cbevss`). Your BEV Cloud address will be
   `https://bev-cloud.<subdomain>.workers.dev`.
3. Copy your **Account ID** (on the Workers & Pages overview, right-hand side).
4. Go to **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" → Use template**.
   Under *Permissions*, **add two rows**:
   - Account · **D1** · Edit
   - Account · **Workers AI** · Read

   Then *Continue → Create Token* and copy it.

## 3. Phone calls (optional, about £2 a month)

Skip this section for Telegram-only. You can add calls later.

**ElevenLabs** (you already have it):
1. **Developers → API Keys → Create**. Give it access to **Text to Speech**,
   **Voices** and **Agents** (write). Copy the key.
2. **Voices → My Voices**, open the voice you want BEV to use and copy its
   **Voice ID**.
3. The free plan includes 15 call minutes a month. Beyond that it's $0.08 a
   minute on a paid plan.

**Twilio:**
1. Sign up at **twilio.com**. Trial accounts can only call your own verified
   number and play a short trial message first. To avoid that, upgrade by
   adding credit.
2. **Phone Numbers → Buy a number**: a UK mobile number (about $2.50 a month).
   UK numbers may ask for proof of address. Use a UK number: calls to UK
   phones from foreign numbers cost far more.
3. Copy your **Account SID** and **Auth Token** from the Twilio console home page.

## 4. Put the keys into GitHub (PowerShell)

Run these in your BEV folder. Each `gh secret set` asks you to paste the value.
Values never appear on screen, in history or in logs.

```powershell
cd C:\Users\cbevs\Projects\BEV

# A long random admin key. Keep a copy: BEV on your PC needs it in step 6.
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$key = [Convert]::ToBase64String($b); $key | Set-Clipboard; "Admin key copied to clipboard: $key"
gh secret set BEV_ADMIN_KEY            # paste the admin key

gh secret set CLOUDFLARE_API_TOKEN     # from step 2
gh secret set CLOUDFLARE_ACCOUNT_ID    # from step 2
gh secret set TELEGRAM_BOT_TOKEN       # from step 1
gh secret set AI_API_KEY               # your Anthropic key (same one BEV uses)
# Using OpenAI instead? Also: gh secret set AI_PROVIDER   (type: openai)

# Phone calls and voice notes (skip any you don't have yet):
gh secret set ELEVENLABS_API_KEY
gh secret set ELEVENLABS_VOICE_ID
gh secret set TWILIO_ACCOUNT_SID
gh secret set TWILIO_AUTH_TOKEN
gh secret set TWILIO_PHONE_NUMBER      # the number you bought, e.g. +447…
gh secret set MY_PHONE_NUMBER          # your own mobile, e.g. +447…
```

## 5. Deploy

```powershell
gh workflow run "BEV Cloud"
gh run watch
```

When it's green, the run's summary page shows your BEV Cloud address and
whether Telegram and phone calls are connected.

## 6. Link BEV and Telegram

1. In BEV on your PC: **Integrations → BEV Cloud**. Paste the address and your
   admin key, then press **Connect**.
2. It shows a pairing code: send your bot `/start CODE` in Telegram. Only that
   chat can use BEV from then on; anyone else who finds the bot gets no reply.

## 7. Try it

In Telegram:
- `remind me in 2 minutes to test BEV`
- `watch https://… and tell me if it drops under £400`
- `every morning at 8, give me a briefing`
- `/call` for a test phone call (if you set up calls)

By voice on your PC: *"Hey BEV, keep an eye on the PS5 price at Argos and call
me if it drops under £400."*

---

## Good to know

- **Urgent = phone call.** Only tasks you mark urgent ring you, and BEV never
  calls more than once every 10 minutes. Everything else is a message.
- **The phone number doesn't answer incoming calls**, so a stranger who rings it
  can't reach your tasks.
- **PC-only things** (a download finishing, a game update, PC temperatures) are
  saved for the PC. Watching them while the PC is on is coming next.
- **Free limits:** Cloudflare's free plan runs BEV Cloud every minute at no cost.
  Very large web pages may need the $5/month Workers plan, but most don't.
- **Changing a key:** run `gh secret set NAME` again, then `gh workflow run "BEV Cloud"`.
- **Commands:** `/tasks`, `/reports`, `/clear`, `/call`, `/help`.
