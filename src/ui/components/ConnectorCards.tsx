/** Integrations: connect BEV to your smart home, GitHub, Spotify, Google and MCP servers. */
import { useEffect, useRef, useState } from "react";
import { native } from "@/lib/native";
import { useSettings, type IntegrationSettings, type McpServerConfig } from "@/state/settings";
import { HA_TOKEN, testHomeAssistant } from "@/integrations/homeassistant";
import { GH_TOKEN, testGitHub } from "@/integrations/github";
import { DISCORD_TOKEN, testDiscord } from "@/integrations/discord";
import { BEVBOT_TOKEN, linkBot, unlinkBot } from "@/integrations/bevbot";
import { spotifyOAuth } from "@/integrations/spotify";
import { googleOAuth, GOOGLE_SECRET } from "@/integrations/google";
import { signIn, signOut, isSignedIn } from "@/integrations/oauth";
import { connectMcp, disconnectMcp, mcpClient, onMcpChange } from "@/integrations/registry";
import { mcpSecret } from "@/integrations/mcp";
import { BRAVE_KEY, webSearch } from "@/research/search";
import { Section, Field, TextInput, Button, Toggle, StatusPill, Select } from "./Form";

function usePatch() {
  const { settings, update } = useSettings();
  const i = settings.integrations;
  const patch = <K extends keyof IntegrationSettings>(k: K, v: Partial<IntegrationSettings[K]> | IntegrationSettings[K]) =>
    update({ integrations: { ...i, [k]: Array.isArray(v) ? v : { ...(i[k] as object), ...(v as object) } } as IntegrationSettings });
  return { i, patch };
}

function useHasSecret(name: string, bump = 0) {
  const [has, setHas] = useState(false);
  useEffect(() => {
    native.getSecret(name).then((v) => setHas(!!v)).catch(() => setHas(false));
  }, [name, bump]);
  return has;
}

function Result({ r }: { r: { ok: boolean; text: string } | null }) {
  if (!r) return null;
  return <p className={`text-sm ${r.ok ? "text-ok" : "text-danger"}`}>{r.text}</p>;
}

async function run(fn: () => Promise<string>, set: (r: { ok: boolean; text: string }) => void) {
  try {
    set({ ok: true, text: await fn() });
  } catch (e) {
    set({ ok: false, text: e instanceof Error ? e.message : String(e) });
  }
}

// ---------------------------------------------------------------------------

export function HomeAssistantCard() {
  const { i, patch } = usePatch();
  const [token, setToken] = useState("");
  const [bump, setBump] = useState(0);
  const has = useHasSecret(HA_TOKEN, bump);
  const [r, setR] = useState<{ ok: boolean; text: string } | null>(null);
  const save = () =>
    run(async () => {
      const url = i.homeassistant.url.trim();
      if (!url) throw new Error("Add the address first, e.g. http://homeassistant.local:8123");
      await native.integrationAllowOrigin(url);
      if (token.trim()) await native.storeSecret(HA_TOKEN, token.trim());
      setToken("");
      setBump((b) => b + 1);
      await patch("homeassistant", { enabled: true });
      return await testHomeAssistant();
    }, setR);
  return (
    <Section title="Home Assistant" aside={i.homeassistant.enabled ? <StatusPill ok={has} label={has ? "connected" : "no token"} /> : undefined}>
      <p className="text-sm text-ink-2">Control lights, heating, plugs and anything else in Home Assistant, and check sensors. Locks, alarms and garage doors always ask first.</p>
      <Field label="Address" hint="Your Home Assistant URL, as you open it in a browser.">
        <TextInput placeholder="http://homeassistant.local:8123" value={i.homeassistant.url} onChange={(e) => patch("homeassistant", { url: e.target.value })} />
      </Field>
      <Field label="Long-lived access token" hint="Home Assistant → your profile → Security → Long-lived access tokens → Create token. Stored in Windows Credential Manager.">
        <TextInput type="password" placeholder={has ? "saved (paste to replace)" : "paste token"} value={token} onChange={(e) => setToken(e.target.value)} />
      </Field>
      <div className="flex items-center justify-end gap-2">
        {i.homeassistant.enabled && (
          <Button variant="ghost" onClick={() => patch("homeassistant", { enabled: false })}>
            Turn off
          </Button>
        )}
        <Button onClick={save}>Save and test</Button>
      </div>
      <Result r={r} />
    </Section>
  );
}

export function GitHubCard() {
  const { i, patch } = usePatch();
  const [token, setToken] = useState("");
  const [bump, setBump] = useState(0);
  const has = useHasSecret(GH_TOKEN, bump);
  const [r, setR] = useState<{ ok: boolean; text: string } | null>(null);
  const save = () =>
    run(async () => {
      if (token.trim()) await native.storeSecret(GH_TOKEN, token.trim());
      setToken("");
      setBump((b) => b + 1);
      await patch("github", { enabled: true });
      return await testGitHub();
    }, setR);
  return (
    <Section title="GitHub" aside={i.github.enabled ? <StatusPill ok={has} label={has ? "connected" : "no token"} /> : undefined}>
      <p className="text-sm text-ink-2">Notifications, issues, pull request checks. Opening an issue always asks first.</p>
      <Field label="Personal access token" hint="github.com → Settings → Developer settings → Fine-grained tokens. Give it read access to the repos you want (and Issues: write to open issues).">
        <TextInput type="password" placeholder={has ? "saved (paste to replace)" : "github_pat_…"} value={token} onChange={(e) => setToken(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2">
        {i.github.enabled && (
          <Button variant="ghost" onClick={() => patch("github", { enabled: false })}>
            Turn off
          </Button>
        )}
        <Button onClick={save} disabled={!has && !token.trim()}>
          Save and test
        </Button>
      </div>
      <Result r={r} />
    </Section>
  );
}

function OAuthCard({ id, title, blurb, setupHint, secretName }: { id: "spotify" | "google"; title: string; blurb: string; setupHint: string; secretName?: string }) {
  const { i, patch } = usePatch();
  const cfg = i[id];
  const [signedIn, setSignedIn] = useState(false);
  const [secret, setSecret] = useState("");
  const [r, setR] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    isSignedIn(id).then(setSignedIn);
  }, [id]);
  // Only the latest attempt reports back: starting again cancels the one
  // waiting on the sign-in port, and that one shouldn't show as an error.
  const attempt = useRef(0);
  const go = async () => {
    const mine = ++attempt.current;
    setBusy(true);
    setR(null);
    await run(async () => {
      if (secretName && secret.trim()) await native.storeSecret(secretName, secret.trim());
      setSecret("");
      await signIn(id === "spotify" ? spotifyOAuth() : await googleOAuth());
      await patch(id, { enabled: true });
      setSignedIn(true);
      return "Signed in.";
    }, (res) => {
      if (mine === attempt.current) setR(res);
    });
    if (mine === attempt.current) setBusy(false);
  };
  return (
    <Section title={title} aside={cfg.enabled ? <StatusPill ok={signedIn} label={signedIn ? "signed in" : "not signed in"} /> : undefined}>
      <p className="text-sm text-ink-2">{blurb}</p>
      <Field label="Client ID" hint={setupHint}>
        <TextInput value={cfg.clientId} onChange={(e) => patch(id, { clientId: e.target.value })} />
      </Field>
      {secretName && (
        <Field label="Client secret" hint="Shown next to the client ID. Stored in Windows Credential Manager.">
          <TextInput type="password" placeholder="paste once" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </Field>
      )}
      <div className="flex justify-end gap-2">
        {signedIn && (
          <Button
            variant="ghost"
            onClick={async () => {
              await signOut(id);
              await patch(id, { enabled: false });
              setSignedIn(false);
            }}
          >
            Sign out
          </Button>
        )}
        <Button onClick={go} disabled={!cfg.clientId.trim()}>
          {busy ? "Restart sign-in" : signedIn ? "Sign in again" : "Sign in"}
        </Button>
      </div>
      {busy && <p className="text-sm text-ink-3">Waiting for you to finish signing in in your browser.</p>}
      <Result r={r} />
    </Section>
  );
}

export const SpotifyCard = () => (
  <OAuthCard
    id="spotify"
    title="Spotify"
    blurb="What's playing, play/pause/skip, volume, and play any song, artist or playlist. Control needs Spotify Premium."
    setupHint="developer.spotify.com → Dashboard → Create app → Redirect URI http://127.0.0.1:43117/callback, Web API ticked → copy the Client ID. See docs/INTEGRATIONS.md."
  />
);

export const GoogleCard = () => (
  <OAuthCard
    id="google"
    title="Gmail and Google Calendar"
    blurb="Search and read your email, write drafts for you to send (BEV never sends email), see and add calendar events."
    setupHint="console.cloud.google.com → new project → enable Gmail API and Google Calendar API → OAuth consent screen (add yourself as a test user) → Credentials → OAuth client ID → Desktop app. See docs/INTEGRATIONS.md."
    secretName={GOOGLE_SECRET}
  />
);

// ---------------------------------------------------------------------------

export function McpCard() {
  const { i, patch } = usePatch();
  const [, force] = useState(0);
  useEffect(() => onMcpChange(() => force((n) => n + 1)), []);
  const [draft, setDraft] = useState<{ name: string; transport: "stdio" | "http"; command: string; url: string; token: string }>({ name: "", transport: "stdio", command: "", url: "", token: "" });
  const [r, setR] = useState<{ ok: boolean; text: string } | null>(null);

  const add = () =>
    run(async () => {
      const name = draft.name.trim();
      if (!name) throw new Error("Give it a name");
      const id = `${Date.now().toString(36)}`;
      let cfg: McpServerConfig;
      if (draft.transport === "stdio") {
        const parts = draft.command.match(/"[^"]*"|\S+/g)?.map((p) => p.replace(/^"|"$/g, "")) ?? [];
        if (!parts.length) throw new Error("Add the command that starts the server, e.g. npx -y @modelcontextprotocol/server-filesystem C:\\Users\\me\\Documents");
        cfg = { id, name, transport: "stdio", command: parts[0], args: parts.slice(1), enabled: true, confirmActions: true };
      } else {
        if (!/^https?:\/\//i.test(draft.url.trim())) throw new Error("Add the server URL");
        await native.integrationAllowOrigin(draft.url.trim());
        if (draft.token.trim()) await native.storeSecret(mcpSecret(id), draft.token.trim());
        cfg = { id, name, transport: "http", url: draft.url.trim(), enabled: true, confirmActions: true };
      }
      const n = await connectMcp(cfg);
      await patch("mcp", [...i.mcp, cfg]);
      setDraft({ name: "", transport: "stdio", command: "", url: "", token: "" });
      return `Connected ${name}: ${n} tools.`;
    }, setR);

  const update = (cfg: McpServerConfig, p: Partial<McpServerConfig>) => patch("mcp", i.mcp.map((m) => (m.id === cfg.id ? { ...m, ...p } : m)));

  return (
    <Section title="MCP servers">
      <p className="text-sm text-ink-2">
        Add tools from MCP servers, the standard many apps use to plug into AI assistants. Only add servers you trust: a local server runs as a program on this PC. Each action asks first unless you turn that off.
      </p>
      <ul className="divide-y divide-line-subtle">
        {i.mcp.map((m) => {
          const st = mcpClient(m.id)?.status ?? { state: "off" as const };
          return (
            <li key={m.id} className="space-y-2 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-ink">{m.name}</div>
                  <div className="truncate font-mono text-xs text-ink-3">{m.transport === "stdio" ? [m.command, ...(m.args ?? [])].join(" ") : m.url}</div>
                  <div className={`text-xs ${st.state === "error" ? "text-danger" : "text-ink-2"}`}>
                    {st.state === "ready" ? `${st.tools.length} tools` : st.state === "error" ? st.message : st.state === "connecting" ? "Connecting…" : "Not connected"}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" onClick={() => run(async () => `Connected: ${await connectMcp(m)} tools.`, setR)}>
                    Reconnect
                  </Button>
                  <Button
                    variant="danger"
                    onClick={async () => {
                      disconnectMcp(m.id);
                      await native.deleteSecret(mcpSecret(m.id)).catch(() => {});
                      await patch("mcp", i.mcp.filter((x) => x.id !== m.id));
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-6 text-sm">
                <label className="flex items-center gap-2 text-ink-2">
                  <Toggle label={`Enable ${m.name}`} checked={m.enabled} onChange={(enabled) => (update(m, { enabled }), enabled ? connectMcp({ ...m, enabled }).catch(() => {}) : disconnectMcp(m.id))} />
                  On
                </label>
                <label className="flex items-center gap-2 text-ink-2">
                  <Toggle label={`Ask before ${m.name} actions`} checked={m.confirmActions} onChange={(confirmActions) => update(m, { confirmActions })} />
                  Ask before each action (read-only tools don't ask)
                </label>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="space-y-2 rounded-lg border border-line p-3">
        <div className="flex gap-2">
          <TextInput placeholder="Name, e.g. Files" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <div className="w-56">
            <Select
              ariaLabel="Server type"
              value={draft.transport}
              onChange={(transport) => setDraft({ ...draft, transport })}
              options={[
                { value: "stdio", label: "Program on this PC" },
                { value: "http", label: "Remote URL" },
              ]}
            />
          </div>
        </div>
        {draft.transport === "stdio" ? (
          <TextInput placeholder="Command, e.g. npx -y @modelcontextprotocol/server-memory" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
        ) : (
          <div className="flex gap-2">
            <TextInput placeholder="https://example.com/mcp" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
            <TextInput type="password" placeholder="Token (optional)" value={draft.token} onChange={(e) => setDraft({ ...draft, token: e.target.value })} />
          </div>
        )}
        <div className="flex justify-end">
          <Button onClick={add}>Add server</Button>
        </div>
      </div>
      <Result r={r} />
    </Section>
  );
}

// ---------------------------------------------------------------------------

export function WebSearchCard() {
  const { settings } = useSettings();
  const [key, setKey] = useState("");
  const [bump, setBump] = useState(0);
  const has = useHasSecret(BRAVE_KEY, bump);
  const [r, setR] = useState<{ ok: boolean; text: string } | null>(null);
  const viaClaude = settings.provider === "anthropic";
  return (
    <Section title="Web search" aside={<StatusPill ok={viaClaude || has ? true : null} label={viaClaude ? "via Claude" : has ? "Brave" : "not set up"} />}>
      <p className="text-sm text-ink-2">
        Lets BEV look things up and read web pages for research.{" "}
        {viaClaude ? "With Claude as the AI it uses Claude's built-in web search, so there's nothing to set up." : "With this AI provider it needs a Brave Search key (free tier available)."}
      </p>
      <Field label="Brave Search API key" hint="Optional with Claude (used as a fallback). Get one at api-dashboard.search.brave.com. Stored in Windows Credential Manager.">
        <TextInput type="password" placeholder={has ? "saved (paste to replace)" : "paste key"} value={key} onChange={(e) => setKey(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2">
        {has && (
          <Button
            variant="ghost"
            onClick={async () => {
              await native.deleteSecret(BRAVE_KEY);
              setBump((b) => b + 1);
            }}
          >
            Remove key
          </Button>
        )}
        <Button
          disabled={!key.trim() && !viaClaude && !has}
          onClick={() =>
            run(async () => {
              if (key.trim()) await native.storeSecret(BRAVE_KEY, key.trim());
              setKey("");
              setBump((b) => b + 1);
              const o = await webSearch("weather London today");
              return `Working: ${o.results.length} results via ${o.engine === "anthropic" ? "Claude" : "Brave"}.`;
            }, setR)
          }
        >
          {key.trim() ? "Save and test" : "Test"}
        </Button>
      </div>
      <Result r={r} />
    </Section>
  );
}

export function DiscordCard() {
  const { i, patch } = usePatch();
  const enabled = !!i.discord?.enabled;
  const [token, setToken] = useState("");
  const [bump, setBump] = useState(0);
  const has = useHasSecret(DISCORD_TOKEN, bump);
  const [r, setR] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <Section title="Discord" aside={enabled ? <StatusPill ok={has} label={has ? "connected" : "no token"} /> : undefined}>
      <p className="text-sm text-ink-2">Read channels in your servers through your own bot, and post as the bot after you confirm. BEV can't read your personal DMs.</p>
      <Field label="Bot token" hint="discord.com/developers → New Application → Bot → Reset Token (turn on Message Content Intent). Invite it with OAuth2 → URL Generator → bot, Read Messages and Send Messages. See docs/INTEGRATIONS.md.">
        <TextInput type="password" placeholder={has ? "saved (paste to replace)" : "paste token"} value={token} onChange={(e) => setToken(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2">
        {enabled && (
          <Button variant="ghost" onClick={() => patch("discord", { enabled: false })}>
            Turn off
          </Button>
        )}
        <Button
          disabled={!has && !token.trim()}
          onClick={() =>
            run(async () => {
              if (token.trim()) await native.storeSecret(DISCORD_TOKEN, token.trim());
              setToken("");
              setBump((b) => b + 1);
              await patch("discord", { enabled: true });
              return await testDiscord();
            }, setR)
          }
        >
          Save and test
        </Button>
      </div>
      <Result r={r} />
    </Section>
  );
}

export function BevBotCard() {
  const { i, patch } = usePatch();
  const cfg = i.bevbot ?? { enabled: false, url: "" };
  const [url, setUrl] = useState(cfg.url);
  const [code, setCode] = useState("");
  const [bump, setBump] = useState(0);
  const linked = useHasSecret(BEVBOT_TOKEN, bump);
  const [r, setR] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <Section title="BEV bot (owner)" aside={linked ? <StatusPill ok label="linked" /> : undefined}>
      <p className="text-sm text-ink-2">
        For the owner of the BEV Discord bot only: control every server's features and settings, global switches, dashboard buttons, posts and the bot's status by voice. DM the bot
        “pc …” from anywhere to give this PC a job, and BEV tells you when servers join or leave or the bot hits errors. Only the bot's owner can get a link code.
      </p>
      <Field label="Bot address" hint="Where the bot runs, e.g. your Render service URL.">
        <TextInput placeholder="https://your-bot.onrender.com" value={url} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      {!linked && (
        <Field label="Link code" hint="DM the bot “link” from your account. The code works once and lasts 10 minutes.">
          <TextInput placeholder="ABCD-EFGH" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
      )}
      <div className="flex justify-end gap-2">
        {linked && (
          <Button
            variant="ghost"
            onClick={() =>
              run(async () => {
                await unlinkBot();
                await patch("bevbot", { enabled: false, url });
                setBump((b) => b + 1);
                return "Unlinked. DM the bot “link” for a new code.";
              }, setR)
            }
          >
            Unlink
          </Button>
        )}
        <Button
          disabled={!url.trim() || (!linked && !code.trim())}
          onClick={() =>
            run(async () => {
              const msg = linked ? (await native.integrationAllowOrigin(url.trim()), "Saved.") : await linkBot(url, code);
              setCode("");
              setBump((b) => b + 1);
              await patch("bevbot", { enabled: true, url: url.trim().replace(/\/+$/, "") });
              return msg;
            }, setR)
          }
        >
          {linked ? "Save" : "Link"}
        </Button>
      </div>
      <Result r={r} />
    </Section>
  );
}
