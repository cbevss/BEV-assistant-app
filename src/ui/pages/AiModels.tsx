/**
 * Settings → AI & models. Pick a main AI and model, add backups that take
 * over when the main one can't answer, and set each provider's key and models
 * (dropdowns list every model the provider offers).
 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { ArrowDown, ArrowUp, ChevronDown, ExternalLink, X } from "lucide-react";
import { native } from "@/lib/native";
import { useSettings, type ProviderId } from "@/state/settings";
import { PROVIDERS, providerInfo } from "@/ai/catalog";
import { chainOrder, makeProvider, modelsFor } from "@/ai/factory";
import { useAiStatus } from "@/ai/fallback";
import { PageHeader, Section, Field, TextInput, Button, StatusPill, Toggle, Badge, IconButton } from "../components/Form";
import { ModelPicker } from "../components/ModelPicker";

type Check = { ok: boolean | null; msg: string };

export function AiModels() {
  const { settings, update } = useSettings();
  const order = chainOrder(settings);
  const backups = order.slice(1);
  const [openId, setOpenId] = useState<ProviderId | null>(settings.provider);
  const lastBackup = useAiStatus();

  const move = (id: ProviderId, by: -1 | 1) => {
    const list = [...backups];
    const i = list.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    void update({ fallbacks: list });
  };

  return (
    <div>
      <PageHeader title="AI & models" subtitle="Which AI BEV thinks with, and which ones take over if it can't answer. Keys are stored in Windows Credential Manager, never in a file." />

      <Section
        title="Main and backups"
        description="BEV asks the main AI first. If it can't be reached, its key stops working, or it runs out of credit or hits a rate limit, the first backup answers instead, then the next."
        aside={lastBackup.backupReason && Date.now() - lastBackup.at < 3_600_000 ? <StatusPill ok={null} label={`Last answer came from a backup (${lastBackup.backupReason})`} /> : undefined}
      >
        <OrderRow
          badge={<Badge tone="accent">Main</Badge>}
          id={settings.provider}
          model={modelsFor(settings, settings.provider).model}
          onOpen={() => setOpenId(settings.provider)}
        />
        {backups.map((id, i) => (
          <OrderRow
            key={id}
            badge={<Badge>{`Backup ${i + 1}`}</Badge>}
            id={id}
            model={modelsFor(settings, id).model}
            onOpen={() => setOpenId(id)}
            actions={
              <>
                <IconButton size="sm" icon={ArrowUp} label={`Move ${providerInfo(id).label} up`} disabled={i === 0} onClick={() => move(id, -1)} />
                <IconButton size="sm" icon={ArrowDown} label={`Move ${providerInfo(id).label} down`} disabled={i === backups.length - 1} onClick={() => move(id, 1)} />
                <IconButton size="sm" icon={X} label={`Stop using ${providerInfo(id).label} as a backup`} onClick={() => update({ fallbacks: backups.filter((b) => b !== id) })} />
              </>
            }
          />
        ))}
        {backups.length === 0 && <p className="text-xs text-ink-3">No backups yet. Open another AI below and choose “Use as backup”, so BEV keeps working when your main AI can't answer.</p>}
      </Section>

      <Section title="Quick replies">
        <Field
          label="Use a faster model for quick replies"
          hint="Short, simple requests (the time, volume, opening an app) use each AI's quick-reply model; anything that needs planning, several steps or a screenshot uses its main model."
        >
          <Toggle label="Model routing" checked={settings.modelRouting} onChange={(modelRouting) => update({ modelRouting })} />
        </Field>
      </Section>

      <Section title="AI providers" flush>
        {PROVIDERS.map((p, i) => (
          <ProviderRow key={p.id} id={p.id} first={i === 0} open={openId === p.id} onToggle={() => setOpenId(openId === p.id ? null : p.id)} />
        ))}
      </Section>
    </div>
  );
}

function OrderRow({ badge, id, model, onOpen, actions }: { badge: React.ReactNode; id: ProviderId; model: string; onOpen: () => void; actions?: React.ReactNode }) {
  return (
    <div className="flex min-h-[28px] items-center gap-3">
      <div className="w-[76px] shrink-0">{badge}</div>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
        <span className="text-sm text-ink hover:underline hover:underline-offset-2">{providerInfo(id).label}</span>
        <span className="truncate font-mono text-xs text-ink-3">{model}</span>
      </button>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}

function ProviderRow({ id, first, open, onToggle }: { id: ProviderId; first: boolean; open: boolean; onToggle: () => void }) {
  const { settings, update } = useSettings();
  const info = providerInfo(id);
  const order = chainOrder(settings);
  const isMain = settings.provider === id;
  const backupIndex = order.indexOf(id) - 1; // -1 main, -2 not used
  const isBackup = backupIndex >= 0;
  const chosen = modelsFor(settings, id);

  const [hasKey, setHasKey] = useState<boolean | null>(info.secret ? null : true);
  const [keyInput, setKeyInput] = useState("");
  const [keyVersion, setKeyVersion] = useState(0);
  const [check, setCheck] = useState<Check>({ ok: null, msg: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!info.secret) return;
    native
      .getSecret(info.secret)
      .then((v) => setHasKey(!!v))
      .catch(() => setHasKey(false));
  }, [info.secret]);

  const setModels = (patch: Partial<{ model: string; fast: string }>) =>
    update({ models: { ...settings.models, [id]: { model: settings.models[id]?.model ?? "", fast: settings.models[id]?.fast ?? info.defaultFast, ...patch } } });

  const saveKey = async () => {
    if (!info.secret || !keyInput.trim()) return;
    try {
      await native.storeSecret(info.secret, keyInput.trim());
      setKeyInput("");
      setHasKey(true);
      setKeyVersion((v) => v + 1);
      setCheck({ ok: null, msg: "Key saved. Test it to be sure." });
    } catch (e) {
      setCheck({ ok: false, msg: `Couldn't save the key: ${String(e)}` });
    }
  };

  const removeKey = async () => {
    if (!info.secret) return;
    await native.deleteSecret(info.secret).catch(() => {});
    setHasKey(false);
    setCheck({ ok: null, msg: "Key removed." });
  };

  /** A real round trip: a tiny request with no tools. */
  const test = async () => {
    setBusy(true);
    setCheck({ ok: null, msg: "Testing…" });
    try {
      const p = makeProvider(settings, id);
      if (!(await p.isConfigured())) {
        setCheck({ ok: false, msg: info.kind === "ollama" ? "Ollama isn't running on this PC." : "No API key saved yet." });
        return;
      }
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20_000);
      const res = await p.chat({ system: "Reply with exactly the word: ready", messages: [{ role: "user", content: "ping" }], tools: [], maxTokens: 16, signal: ctl.signal });
      clearTimeout(t);
      setCheck({ ok: true, msg: `Connected: replied “${res.text.slice(0, 24)}”` });
    } catch (e) {
      setCheck({ ok: false, msg: e instanceof Error ? e.message.slice(0, 160) : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const makeMain = () =>
    update({
      provider: id,
      // The old main becomes the first backup, so nothing is lost.
      fallbacks: [settings.provider, ...settings.fallbacks.filter((f) => f !== id && f !== settings.provider)],
    });

  const toggleBackup = () => update({ fallbacks: isBackup ? settings.fallbacks.filter((f) => f !== id) : [...settings.fallbacks.filter((f) => f !== id), id] });

  const ready = hasKey === true;
  const status = isMain ? <Badge tone="accent">Main</Badge> : isBackup ? <Badge>{`Backup ${backupIndex + 1}`}</Badge> : ready ? <span className="text-xs text-ink-3">{info.secret ? "Key saved" : "Ready"}</span> : <span className="text-xs text-ink-4">Not set up</span>;

  return (
    <div className={clsx(!first && "border-t border-line-subtle")}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-fast hover:bg-surface-2/50">
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-ink">{info.label}</span>
          <span className="block truncate text-xs text-ink-3">{info.blurb}</span>
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {status}
          <ChevronDown className={clsx("h-4 w-4 text-ink-3 transition-transform duration-fast", open && "rotate-180")} aria-hidden />
        </span>
      </button>

      {open && (
        <div className="animate-page-in divide-y divide-line-subtle border-t border-line-subtle bg-canvas/40 [&>*]:px-4 [&>*]:py-3">
          {info.secret && (
            <Field
              label="API key"
              hint={
                <>
                  {hasKey ? "Saved in Credential Manager." : "Not saved yet."}{" "}
                  {info.keyUrl && (
                    <a href={info.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline">
                      Get a key <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                  )}
                </>
              }
            >
              <div className="flex w-full gap-2">
                <TextInput
                  type="password"
                  autoComplete="off"
                  aria-label={`${info.label} API key`}
                  placeholder={hasKey ? "•••••••• (replace)" : "Paste key"}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void saveKey()}
                />
                <Button onClick={saveKey} disabled={!keyInput.trim()}>
                  Save
                </Button>
                {hasKey && (
                  <Button variant="ghost" onClick={removeKey}>
                    Remove
                  </Button>
                )}
              </div>
            </Field>
          )}
          {info.kind === "ollama" && (
            <Field label="Address" hint="Where Ollama runs. Usually http://localhost:11434.">
              <TextInput aria-label="Ollama address" value={settings.ollamaHost} onChange={(e) => update({ ollamaHost: e.target.value })} />
            </Field>
          )}
          <Field label="Model" hint="Used for real work: planning, several steps, screenshots.">
            <ModelPicker provider={id} value={chosen.model} onChange={(model) => setModels({ model })} ariaLabel={`${info.label} model`} ollamaHost={settings.ollamaHost} keyVersion={keyVersion} />
          </Field>
          {settings.modelRouting && (
            <Field label="Quick-reply model" hint="A faster, cheaper model for short, simple requests.">
              <ModelPicker
                provider={id}
                value={chosen.fast}
                onChange={(fast) => setModels({ fast })}
                ariaLabel={`${info.label} quick-reply model`}
                emptyLabel="Same as main model"
                ollamaHost={settings.ollamaHost}
                keyVersion={keyVersion}
              />
            </Field>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={test} loading={busy}>
              Test connection
            </Button>
            {check.msg && <StatusPill ok={check.ok} label={check.msg} />}
            <span className="flex-1" />
            {!isMain && (
              <Button size="sm" onClick={toggleBackup} disabled={!ready && !isBackup} title={!ready ? "Add a key first" : undefined}>
                {isBackup ? "Stop using as backup" : "Use as backup"}
              </Button>
            )}
            {isMain ? (
              <span className="text-xs text-ink-3">This is your main AI.</span>
            ) : (
              <Button variant="primary" size="sm" onClick={makeMain} disabled={!ready} title={!ready ? "Add a key first" : undefined}>
                Make main
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
