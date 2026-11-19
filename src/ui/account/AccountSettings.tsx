/** Settings → Account: who's signed in, sync, devices, passphrase, export, delete. */
import { useEffect, useState } from "react";
import { RefreshCw, LogOut, Download, Trash2 } from "lucide-react";
import { useAccount } from "@/account/account";
import { MIN_PASSPHRASE } from "@/account/crypto";
import { PageHeader, Section, Field, Button, TextInput, Notice, StatusPill } from "../components/Form";
import { ConfirmDialog } from "../components/ConfirmDialog";

const ago = (t: number | null) => {
  if (!t) return "never";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

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
            {a.user?.avatar && <img src={a.user.avatar} alt="" className="h-9 w-9 rounded-full border border-line" referrerPolicy="no-referrer" />}
            <Button icon={LogOut} onClick={() => setConfirm("signout")}>
              Sign out
            </Button>
          </div>
        </Field>
      </Section>

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
