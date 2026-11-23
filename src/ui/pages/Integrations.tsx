import { useEffect, useState } from "react";
import { native } from "@/lib/native";
import { useSettings } from "@/state/settings";
import { AiModels } from "./AiModels";
import { bevCloud, CLOUD_KEY_SECRET, normaliseCloudUrl } from "@/lib/bevCloud";
import { WebSearchCard, HomeAssistantCard, SpotifyCard, GoogleCard, GitHubCard, DiscordCard, BevBotCard, McpCard } from "../components/ConnectorCards";
import { PageHeader, Section, Field, TextInput, Button, StatusPill } from "../components/Form";

type Check = { ok: boolean | null; msg: string };

export function Integrations({ part = "ai" }: { part?: "ai" | "services" }) {
  return (
    <div>
      {part === "ai" && <AiModels />}
      {part === "services" && (
        <>
      <PageHeader title="Connected services" subtitle="Your phone, smart home, music, email, code and other tools BEV can use. Tokens are stored in Windows Credential Manager." />
      <BevCloudCard />
      <WebSearchCard />
      <HomeAssistantCard />
      <SpotifyCard />
      <GoogleCard />
      <GitHubCard />
      <DiscordCard />
      <BevBotCard />
      <McpCard />
        </>
      )}
    </div>
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
      <p className="text-sm text-ink-2">
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
        <p className={`text-sm ${check.ok === false ? "text-danger" : check.ok ? "text-ok" : "text-ink-2"}`}>{check.msg}</p>
      )}
    </Section>
  );
}
