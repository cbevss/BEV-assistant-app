/** Settings → Advanced → Your data: see what BEV keeps and delete any of it. */
import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { native } from "@/lib/native";
import { dataActions, eraseEverything } from "@/lib/dataControls";
import { useSettings } from "@/state/settings";
import { useAccount } from "@/account/account";
import { Section, Field, Button, Notice } from "./Form";
import { ConfirmDialog } from "./ConfirmDialog";

type Counts = Awaited<ReturnType<typeof native.dataCounts>>;
type Action = keyof typeof dataActions | "everything" | "synced" | "account";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function DataControls() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const replayOn = useSettings((s) => s.settings.screenReplay);
  const account = useAccount();
  const synced = account.status === "ready";

  const refresh = useCallback(() => {
    native.dataCounts().then(setCounts).catch(() => setCounts(null));
  }, []);
  useEffect(refresh, [refresh]);

  const everywhere = synced ? " Because you're signed in, this also deletes them on your other devices." : "";
  const rows: Array<{ id: keyof typeof dataActions; label: string; hint: string; count?: string; confirm: string; show?: boolean }> = [
    {
      id: "conversations",
      label: "Conversation history",
      hint: "Everything you and BEV have said, which BEV searches to remember past chats.",
      count: counts ? plural(counts.conversation_messages, "message") : undefined,
      confirm: "Delete your whole conversation history with BEV? It can't be undone.",
    },
    {
      id: "memories",
      label: "Memories",
      hint: `Facts BEV has saved about you and your preferences.${everywhere}`,
      count: counts ? plural(counts.memories, "memory", "memories") : undefined,
      confirm: `Delete everything BEV remembers about you?${everywhere} It can't be undone.`,
    },
    {
      id: "notes",
      label: "Notes",
      hint: `Notes you or BEV saved, including research.${everywhere}`,
      count: counts ? plural(counts.notes, "note") : undefined,
      confirm: `Delete all your notes?${everywhere} It can't be undone.`,
    },
    {
      id: "activity",
      label: "Activity history",
      hint: "The log of actions BEV took and tasks it ran (Activity page).",
      count: counts ? plural(counts.activity, "entry", "entries") : undefined,
      confirm: "Delete BEV's activity history? It can't be undone.",
    },
    {
      id: "replay",
      label: "Screen replay",
      hint: "The last few seconds of your screen BEV is holding in memory. It keeps recording afterwards while replay is on.",
      confirm: "Throw away what screen replay is holding right now?",
      show: replayOn,
    },
    {
      id: "learned",
      label: "Learned tasks",
      hint: "Steps BEV remembered from tasks it did in your apps (Automations page).",
      confirm: "Forget every task BEV has learned? Routines you saved stay.",
    },
    {
      id: "documents",
      label: "What BEV read from your documents",
      hint: "The search index of your chosen document folders. Your files aren't touched.",
      confirm: "Forget what BEV read from your documents? Your files stay as they are; BEV re-reads the folders if they're still chosen.",
    },
    {
      id: "secrets",
      label: "Saved keys and sign-ins",
      hint: "AI provider keys, connected services (Spotify, Google, GitHub, Home Assistant…), BEV Cloud and MCP tokens, stored in Windows Credential Manager.",
      confirm: "Delete every saved key and sign-in? BEV will need your AI key again, and connected services will need signing in again.",
    },
  ];

  const run = async (a: Action) => {
    setConfirm(null);
    setBusy(a);
    setErr(null);
    setDone(null);
    try {
      if (a === "everything") await eraseEverything();
      else if (a === "synced") await account.eraseSynced();
      else if (a === "account") await account.deleteAccount();
      else await dataActions[a]();
      setDone(a === "everything" ? null : "Deleted.");
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const confirmText =
    confirm === "everything"
      ? `Erase everything BEV keeps on this PC? That's your conversations, memories, notes, activity, routines, custom wake phrases, saved keys and sign-ins, and all settings. BEV starts again from setup.${synced ? " This PC is signed out of your account first, so your other devices keep their copies." : ""} It can't be undone.`
      : confirm === "synced"
        ? "Erase everything synced to your account? Your memories, notes and profile are deleted from the server and from every signed-in device, this one included. Your account stays."
        : confirm === "account"
          ? "Delete your BEV account? Everything synced is erased from the server for good and every device is signed out. BEV's memories on this PC stay."
          : rows.find((r) => r.id === confirm)?.confirm ?? "";

  return (
    <>
      <Section title="Your data">
        {rows
          .filter((r) => r.show !== false)
          .map((r) => (
            <Field key={r.id} label={r.label} hint={r.hint}>
              <div className="flex items-center gap-3">
                {r.count && <span className="tnum whitespace-nowrap text-sm text-ink-3">{r.count}</span>}
                <Button variant="danger" size="sm" icon={Trash2} loading={busy === r.id} onClick={() => setConfirm(r.id)}>
                  {r.id === "replay" ? "Clear" : "Delete"}
                </Button>
              </div>
            </Field>
          ))}
        <Field label="Erase everything on this PC" hint="All of the above, plus routines, custom wake phrases and every setting. BEV starts again from first-run setup.">
          <Button variant="danger" icon={Trash2} loading={busy === "everything"} onClick={() => setConfirm("everything")}>
            Erase everything
          </Button>
        </Field>
        {(done || err) && <div className="px-4 py-3">{err ? <Notice tone="danger">{err}</Notice> : <Notice tone="ok">{done}</Notice>}</div>}
      </Section>

      {account.status !== "off" && (
        <Section title="Account data">
          {synced ? (
            <>
              <Field label="Erase synced data" hint="Deletes your memories, notes and profile from the server and from every signed-in device. Your account and sign-in stay.">
                <Button variant="danger" size="sm" icon={Trash2} loading={busy === "synced"} onClick={() => setConfirm("synced")}>
                  Erase
                </Button>
              </Field>
              <Field label="Delete account" hint="Erases your account and everything synced from the server for good, and signs out every device. BEV's memories on this PC stay.">
                <Button variant="danger" size="sm" icon={Trash2} loading={busy === "account"} onClick={() => setConfirm("account")}>
                  Delete account
                </Button>
              </Field>
            </>
          ) : (
            <Field label="Not signed in" hint="Sign in (Settings → Account) to manage what's stored in your account.">
              {null}
            </Field>
          )}
        </Section>
      )}

      {confirm && (
        <ConfirmDialog
          text={confirmText}
          confirmLabel={confirm === "everything" ? "Erase everything" : confirm === "account" ? "Delete account" : confirm === "replay" ? "Clear" : confirm === "synced" ? "Erase" : "Delete"}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void run(confirm)}
        />
      )}
    </>
  );
}
