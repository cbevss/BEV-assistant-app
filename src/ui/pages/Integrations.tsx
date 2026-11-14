import { useEffect, useState } from "react";
import { native } from "@/lib/native";
import { useSettings, ProviderId } from "@/state/settings";
import { makeProvider, providerLabels, secretNameFor } from "@/ai/factory";
import { PageHeader, Section, Field, TextInput, Select, Button, StatusPill } from "../components/Form";

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

      <PicovoiceCard />
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

function PicovoiceCard() {
  const [has, setHas] = useState<boolean | null>(null);
  const [val, setVal] = useState("");
  useEffect(() => {
    native.getSecret("picovoice_key").then((v) => setHas(!!v)).catch(() => setHas(false));
  }, []);
  return (
    <Section
      title="Picovoice (on-device wake word)"
      aside={<StatusPill ok={has} label={has ? "key saved" : has === false ? "not configured" : "…"} />}
    >
      <Field
        label="Access key"
        hint="Free at console.picovoice.ai. On-device wake word is coming in a future update; until then BEV uses the built-in speech wake word, so saving a key changes nothing yet."
      >
        <div className="flex gap-2">
          <TextInput type="password" autoComplete="off" value={val} onChange={(e) => setVal(e.target.value)} placeholder="paste access key" />
          <Button
            disabled={!val.trim()}
            onClick={async () => {
              await native.storeSecret("picovoice_key", val.trim());
              setVal("");
              setHas(true);
            }}
          >
            Save
          </Button>
        </div>
      </Field>
    </Section>
  );
}
