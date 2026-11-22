/** Settings → Account: who's signed in, sync, devices, passphrase, export, delete. */
import { useEffect, useState } from "react";
import { RefreshCw, LogOut, Download, Trash2, Copy, Smartphone } from "lucide-react";
import { useAccount } from "@/account/account";
import { MIN_PASSPHRASE } from "@/account/crypto";
import { PageHeader, Section, Field, Button, TextInput, Notice, StatusPill, Toggle } from "../components/Form";
import { useSettings } from "@/state/settings";
import { usePhone } from "@/account/phone";
import { ACCOUNTS_URL } from "@/account/config";
import { ConfirmDialog } from "../components/ConfirmDialog";

const ago = (t: number | null) => {
  if (!t) return "never";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

function PhoneControl() {
  const { settings, update } = useSettings();
  const phone = usePhone();
  const [copied, setCopied] = useState(false);
  const url = `${ACCOUNTS_URL.replace(/\/+$/, "")}/phone`;
  const on = settings.phoneControl;
  return (
    <Section
      title="Phone control"
      description="Use BEV from your phone: ask it to do things on this PC, see what it's doing, approve actions and look at your screen. Messages are encrypted with your passphrase, so the BEV service can't read them."
      aside={on ? <StatusPill ok={!phone.error && phone.running} label={phone.error ? "problem" : phone.running ? "listening" : "starting"} /> : undefined}
    >
      <Field
        label="Take requests from my phone"
        hint="While BEV is open, it checks for messages from your phone every few seconds. From the phone, BEV can't use the mouse, keyboard or screen, and anything that needs your OK is sent to your phone, where you confirm it twice."
      >
        <Toggle label="Phone control" checked={on} onChange={(phoneControl) => update({ phoneControl })} />
      </Field>
      {on && (
        <Field label="Open this on your phone" hint={`${url}. Sign in with the same Discord account, then unlock with your passphrase. Add it to your home screen to use it like an app.`}>
          <Button
            icon={copied ? Smartphone : Copy}
            onClick={async () => {
              await navigator.clipboard.writeText(url).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
        </Field>
      )}
      {on && phone.error && (
        <div className="px-4 py-3">
          <Notice tone="danger">{phone.error}</Notice>
        </div>
      )}
    </Section>
  );
}

export function AccountSettings() {
  const a = useAccount();
  const [confirm, setConfirm] = useState<"signout" | "delete" | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [passMsg, setPassMsg] = useState<string | null>(null);

  useEffect(() => {
    if (a.status === "ready") void a.refreshDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.status]);

  if (a.status === "off") {
    return (
      <>
        <PageHeader title="Account" subtitle="Sign in to keep BEV's memories with you on every device." />
        <Notice tone="info">Accounts aren't switched on in this version of BEV yet. Everything stays on this PC for now.</Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Account" subtitle="Your memories, notes and how BEV talks to you sync across your devices, end-to-end encrypted." />

      <Section title="Signed in">
        <Field label={a.user?.name ?? "Signed in"} hint="With Discord.">
          <div className="flex items-center gap-3">
            <Avatar url={a.user?.avatar ?? null} name={a.user?.name ?? ""} />
            <Button icon={LogOut} onClick={() => setConfirm("signout")}>
              Sign out
            </Button>
          </div>
        </Field>
      </Section>

      <PhoneControl />

      <Section title="Sync" aside={<StatusPill ok={!a.error} label={a.syncing ? "syncing" : a.error ? "problem" : "on"} />}>
        <Field label="Last synced" hint="Every couple of minutes while BEV is open. Encrypted on this PC first: the server only ever holds scrambled data.">
          <div className="flex items-center gap-3">
            <span className="tnum text-sm text-ink-2">{ago(a.lastSync)}</span>
            <Button icon={RefreshCw} loading={a.syncing} onClick={() => void a.syncNow()}>
              Sync now
            </Button>
          </div>
        </Field>
        {a.error && (
          <div className="px-4 py-3">
            <Notice tone="warn">{a.error}</Notice>
          </div>
        )}
      </Section>

      <Section title="Devices">
        {a.devices.length === 0 ? (
          <Field label="This PC" hint="Other devices you sign in on appear here.">{null}</Field>
        ) : (
          a.devices.map((d) => (
            <Field key={d.id} label={`${d.device}${d.current ? " (this PC)" : ""}`} hint={`Signed in ${new Date(d.created_at).toLocaleDateString()} · last active ${ago(d.last_used)}`}>
              {!d.current && (
                <Button size="sm" onClick={() => void a.signOutDevice(d.id)}>
                  Sign out
                </Button>
              )}
            </Field>
          ))
        )}
      </Section>

      <Section title="Passphrase">
        <form
          className="space-y-3 px-4 py-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setPassMsg(null);
            try {
              await a.changePassphrase(current, next);
              setCurrent("");
              setNext("");
              setPassMsg("Passphrase changed. Your recovery key still works.");
            } catch {
              /* shown via the store's error */
            }
          }}
        >
          <p className="text-sm text-ink-3">Changing it doesn't re-encrypt anything; your recovery key keeps working.</p>
          <div className="flex flex-wrap gap-2">
            <TextInput type="password" aria-label="Current passphrase or recovery key" placeholder="Current passphrase or recovery key" autoComplete="current-password" className="min-w-[220px] flex-1" value={current} onChange={(e) => setCurrent(e.target.value)} />
            <TextInput type="password" aria-label="New passphrase" placeholder={`New passphrase (${MIN_PASSPHRASE}+ characters)`} autoComplete="new-password" className="min-w-[220px] flex-1" value={next} onChange={(e) => setNext(e.target.value)} />
            <Button type="submit" disabled={!current || next.length < MIN_PASSPHRASE} loading={a.busy}>
              Change
            </Button>
          </div>
          {passMsg && <p className="text-sm text-ok">{passMsg}</p>}
        </form>
      </Section>

      <Section title="Your data">
        <Field label="Download a copy" hint="Everything the server holds for you (it's encrypted, as stored).">
          <Button
            icon={Download}
            onClick={async () => {
              const data = await a.exportData();
              const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
              const link = document.createElement("a");
              link.href = url;
              link.download = "bev-account-export.json";
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            Download
          </Button>
        </Field>
        <Field label="Delete account" hint="Erases your account and everything synced, on the server, for good. BEV's memories on this PC stay.">
          <Button variant="danger" icon={Trash2} onClick={() => setConfirm("delete")}>
            Delete account
          </Button>
        </Field>
      </Section>

      {confirm === "signout" && (
        <ConfirmDialog
          text="Sign out on this PC? BEV's memories stay here, but stop syncing. You'll need your passphrase to sign back in."
          confirmLabel="Sign out"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void a.signOut();
          }}
        />
      )}
      {confirm === "delete" && (
        <ConfirmDialog
          text="Delete your BEV account? Everything synced is erased from the server for good, and every device is signed out. BEV's memories on this PC stay."
          confirmLabel="Delete account"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void a.deleteAccount();
          }}
        />
      )}
    </>
  );
}

/** Discord profile picture, or the first letter of the name if there isn't one or it won't load. */
function Avatar({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (url && !failed)
    return <img src={url} alt="" className="h-9 w-9 rounded-full border border-line object-cover" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  return (
    <span aria-hidden className="grid h-9 w-9 place-items-center rounded-full border border-line bg-surface-2 text-sm font-medium text-ink-2">
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}
