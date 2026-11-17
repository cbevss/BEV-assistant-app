import { useEffect, useState } from "react";
import { native } from "@/lib/native";
import { useSettings, ProviderId } from "@/state/settings";
import { makeProvider, providerLabels, secretNameFor } from "@/ai/factory";
import { bevCloud, CLOUD_KEY_SECRET, normaliseCloudUrl } from "@/lib/bevCloud";
import { HomeAssistantCard, SpotifyCard, GoogleCard, GitHubCard, McpCard } from "../components/ConnectorCards";
import { PageHeader, Section, Field, TextInput, Select, Button, StatusPill, Toggle } from "../components/Form";

type Check = { ok: boolean | null; msg: string };

export function Integrations() {
  const { settings, update } = useSettings();

  return (
    <div>
      <PageHeader
        title="Integrations"
        subtitle="AI providers and external services. Keys are stored in Windows Credential Manager, never on disk in plain text."
      />

      <Section title="Active AI provider">
        <Field label="Provider" hint="Used by voice and chat. Ollama runs fully offline.">
          <Select<ProviderId>
            ariaLabel="AI provider"
            value={settings.provider}
            onChange={(provider) => update({ provider })}
            options={(["anthropic", "openai", "ollama"] as ProviderId[]).map((p) => ({
              value: p,
              label: providerLabels[p],
            }))}
          />
        </Field>
        <Field
          label="Quick replies on a faster model"
          hint="Short, simple requests (the time, volume, opening an app) use the faster model below; anything that needs planning, several steps or a screenshot uses your main model. If the fast model fails, BEV retries on the main one."
        >
          <Toggle label="Model routing" checked={settings.modelRouting} onChange={(modelRouting) => update({ modelRouting })} />
        </Field>
        {settings.modelRouting && (
          <Field label="Fast model" hint={settings.provider === "ollama" ? "Leave empty to always use the main model." : undefined}>
            <TextInput
              aria-label="Fast model"
              value={settings.provider === "openai" ? settings.openaiFastModel : settings.provider === "ollama" ? settings.ollamaFastModel : settings.anthropicFastModel}
              onChange={(e) =>
                update(
                  settings.provider === "openai"
                    ? { openaiFastModel: e.target.value }
                    : settings.provider === "ollama"
                      ? { ollamaFastModel: e.target.value }
                      : { anthropicFastModel: e.target.value }
                )
              }
            />
          </Field>
        )}
      </Section>

      <ProviderCard id="anthropic" modelValue={settings.anthropicModel} onModel={(anthropicModel) => update({ anthropicModel })} />
      <ProviderCard id="openai" modelValue={settings.openaiModel} onModel={(openaiModel) => update({ openaiModel })} />
      <ProviderCard
        id="ollama"
        modelValue={settings.ollamaModel}
        onModel={(ollamaModel) => update({ ollamaModel })}
        host={settings.ollamaHost}
        onHost={(ollamaHost) => update({ ollamaHost })}
      />
      <BevCloudCard />

      <h2 className="pt-4 text-lg font-medium text-slate-100">Connected services</h2>
      <HomeAssistantCard />
      <SpotifyCard />
      <GoogleCard />
      <GitHubCard />
      <McpCard />
    </div>
  );
}

function ProviderCard({
  id,
  modelValue,
  onModel,
  host,
  onHost,
}: {
  id: ProviderId;
  modelValue: string;
  onModel: (v: string) => void;
  host?: string;
  onHost?: (v: string) => void;
}) {
  const settings = useSettings((s) => s.settings);
  const secretName = secretNameFor[id];
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [check, setCheck] = useState<Check>({ ok: null, msg: "not tested" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!secretName) return;
    native
      .getSecret(secretName)
      .then((v) => setHasKey(!!v))
      .catch(() => setHasKey(false));
  }, [secretName]);

  const saveKey = async () => {
    if (!secretName || !keyInput.trim()) return;
    try {
      await native.storeSecret(secretName, keyInput.trim());
      setKeyInput("");
      setHasKey(true);
      setCheck({ ok: null, msg: "key saved — test it" });
    } catch (e) {
      setCheck({ ok: false, msg: `could not save key: ${String(e)}` });
    }
  };

  const removeKey = async () => {
    if (!secretName) return;
    await native.deleteSecret(secretName).catch(() => {});
    setHasKey(false);
    setCheck({ ok: null, msg: "key removed" });
  };

  /** Real round-trip: a minimal chat request with no tools. */
  const test = async () => {
    setBusy(true);
    setCheck({ ok: null, msg: "testing…" });
    try {
      const p = makeProvider(settings, id);
      if (!(await p.isConfigured())) {
        setCheck({ ok: false, msg: id === "ollama" ? "Ollama not reachable" : "no API key saved" });
        return;
      }
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20_000);
      const res = await p.chat({
        system: "Reply with exactly the word: ready",
        messages: [{ role: "user", content: "ping" }],
        tools: [],
        maxTokens: 10,
        signal: ctl.signal,
      });
      clearTimeout(t);
      setCheck({ ok: true, msg: `connected — replied "${res.text.slice(0, 30)}"` });
    } catch (e) {
      setCheck({ ok: false, msg: e instanceof Error ? e.message.slice(0, 160) : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={providerLabels[id]} aside={<StatusPill ok={check.ok} label={check.msg} />}>
      {secretName && (
        <Field
          label="API key"
          hint={hasKey ? "A key is saved in Credential Manager." : "No key saved yet."}
        >
          <div className="flex gap-2">
            <TextInput
              type="password"
              autoComplete="off"
              placeholder={hasKey ? "•••••••• (replace)" : "paste key"}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <Button onClick={saveKey} disabled={!keyInput.trim()}>
              Save
            </Button>
            {hasKey && (
              <Button variant="danger" onClick={removeKey}>
                Remove
              </Button>
            )}
          </div>
        </Field>
      )}
      {onHost && (
        <Field label="Host" hint="Default Ollama endpoint is http://localhost:11434">
          <TextInput value={host} onChange={(e) => onHost(e.target.value)} />
        </Field>
      )}
      <Field label="Model">
        <TextInput value={modelValue} onChange={(e) => onModel(e.target.value)} />
      </Field>
      <div className="flex justify-end">
        <Button variant="ghost" onClick={test} disabled={busy}>
          {busy ? "Testing…" : "Test connection"}
        </Button>
      </div>
    </Section>
  );
}

/**
 * BEV Cloud: the always-on half of BEV (Telegram, task tracking, urgent calls).
 * Set up once with docs/BEV_CLOUD.md; this card links the desktop app to it.
 */
function BevCloudCard() {
  const { settings, update } = useSettings();
  const [url, setUrl] = useState(settings.bevCloudUrl);
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [check, setCheck] = useState<Check>({ ok: null, msg: "" });

  useEffect(() => {
    native.getSecret(CLOUD_KEY_SECRET).then((k) => setHasKey(Boolean(k))).catch(() => {});
  }, []);

  const save = async () => {
    setCheck({ ok: null, msg: "Checking…" });
    try {
      const clean = normaliseCloudUrl(url);
      const useKey = key.trim() || (await native.getSecret(CLOUD_KEY_SECRET)) || "";
      if (!clean || !useKey) throw new Error("Enter BEV Cloud's address and admin key.");
      const s = await bevCloud.status({ url: clean, key: useKey });
      if (key.trim()) {
        await native.storeSecret(CLOUD_KEY_SECRET, key.trim());
        setHasKey(true);
        setKey("");
      }
      setUrl(clean);
      await update({ bevCloudUrl: clean });
      let tgNote = "Telegram linked";
      if (!s.telegramLinked) {
        const p = await bevCloud.pairingCode({ url: clean, key: useKey }).catch(() => null);
        tgNote = p?.code ? `To link Telegram, send your bot: /start ${p.code}` : "Telegram not linked yet";
      }
      setCheck({ ok: true, msg: `Connected. ${tgNote}. Phone calls ${s.calls ? "ready" : "not set up"}.` });
    } catch (e) {
      setCheck({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    }
  };

  const disconnect = async () => {
    await native.deleteSecret(CLOUD_KEY_SECRET).catch(() => {});
    await update({ bevCloudUrl: "" });
    setHasKey(false);
    setUrl("");
    setCheck({ ok: null, msg: "Disconnected." });
  };

  const connected = Boolean(settings.bevCloudUrl && hasKey);
  return (
    <Section
      title="BEV Cloud (phone, Telegram, task tracking)"
      aside={<StatusPill ok={connected ? (check.ok ?? true) : null} label={connected ? "connected" : "not connected"} />}
    >
      <p className="text-sm text-slate-400">
        Lets BEV keep track of things while this PC is off, message you on Telegram and ring you when something is
        urgent. Ask BEV to “keep an eye on…” and it lands there.
      </p>
      <Field label="Address" hint="Shown at the end of the setup guide, like https://bev-cloud.yourname.workers.dev">
        <TextInput value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://bev-cloud….workers.dev" />
      </Field>
      <Field label="Admin key" hint={hasKey ? "Saved in Windows Credential Manager. Enter a new one to replace it." : "The BEV_ADMIN_KEY you created during setup."}>
        <TextInput type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={hasKey ? "••••••••" : ""} />
      </Field>
      <div className="flex justify-end gap-2">
        {connected && (
          <Button variant="ghost" onClick={disconnect}>
            Disconnect
          </Button>
        )}
        <Button onClick={save}>{connected ? "Test" : "Connect"}</Button>
      </div>
      {check.msg && (
        <p className={`text-sm ${check.ok === false ? "text-bev-danger" : check.ok ? "text-bev-ok" : "text-slate-400"}`}>{check.msg}</p>
      )}
    </Section>
  );
}
