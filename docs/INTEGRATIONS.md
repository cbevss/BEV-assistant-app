# Connecting services to BEV

All of these are set up in **Integrations → Connected services**. Tokens and secrets are kept in Windows Credential Manager, never in BEV's settings file or logs. BEV only talks to the public APIs below plus addresses you add yourself (your Home Assistant, a remote MCP server).

## Home Assistant

1. In Home Assistant, open your profile (bottom left) → **Security** → **Long-lived access tokens** → **Create token**. Name it "BEV" and copy it.
2. In BEV, enter the address you use to open Home Assistant (for example `http://homeassistant.local:8123` or `http://192.168.1.20:8123`) and paste the token.
3. Press **Save and test**. You should see the number of entities.

Try: "turn the living room lights to 40%", "what's the temperature in the bedroom?", "is the back door locked?". Locks, alarms and garage doors always ask before changing.

## GitHub

1. github.com → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Choose the repositories, then give **Contents: read**, **Issues: read and write**, **Pull requests: read**, and (for notifications) a classic token with `notifications` if you want those.
3. Paste it into BEV and press **Save and test**.

Try: "any GitHub notifications?", "what's failing on PR 14 in cbevss/BEV-assistant-app?".

## Spotify

Spotify needs you to register a free developer app (it takes two minutes):

1. Go to https://developer.spotify.com/dashboard and sign in → **Create app**.
2. Name and description: anything (for example "BEV").
3. **Redirect URI**: `http://127.0.0.1:43117/callback` (exactly this). Press **Add**.
4. Tick **Web API**, agree, **Save**.
5. Open the app's **Settings** and copy the **Client ID** into BEV, then press **Sign in** and approve in the browser.

Playback control (play, pause, skip, volume) needs Spotify Premium; "what's playing" works on any account. Spotify must be open on some device.

## Gmail and Google Calendar

Google needs a free Cloud project with an OAuth client:

1. Go to https://console.cloud.google.com → create a project (for example "BEV").
2. **APIs & Services → Library**: enable **Gmail API** and **Google Calendar API**.
3. **APIs & Services → OAuth consent screen**: choose **External**, fill in the app name and your email. Under **Audience → Test users**, add your own Google address.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID → Desktop app**. Copy the **Client ID** and **Client secret** into BEV.
5. Press **Sign in** and approve. Google will warn that the app isn't verified; that's expected for your own project ("Continue").

BEV can search and read email, write **drafts** (you send them yourself; BEV never sends email), list upcoming events and add events without guests. While the consent screen is in "Testing", Google asks you to sign in again every 7 days.

## Discord

BEV uses a bot you create, so it only sees servers you add it to (never your personal DMs):

1. https://discord.com/developers/applications → **New Application** (for example "BEV").
2. **Bot** → **Reset Token** → copy it. Under **Privileged Gateway Intents**, turn on **Message Content Intent**.
3. **OAuth2 → URL Generator**: tick **bot**, then **View Channels**, **Read Message History** and **Send Messages**. Open the generated link and add the bot to your server.
4. Paste the token into BEV and press **Save and test**.

Try: "what's new in #general?". Posting a message always asks first.

## MCP servers

MCP is a standard way for apps to offer tools to AI assistants. In BEV you can add:

- **A program on this PC**: the command that starts it, for example `npx -y @modelcontextprotocol/server-memory` (needs Node.js), or the path to a server's .exe. It runs only while BEV is open.
- **A remote URL**: a Streamable HTTP endpoint, with an optional bearer token.

Only add servers you trust: a local server runs with your permissions. Each server's actions ask before running unless you turn that off; tools the server marks as read-only don't ask. Everything a server returns is treated as outside content, so it can't make BEV take sensitive actions on its own.
