/**
 * Memory → Documents: choose the folders BEV reads so you can ask about your
 * documents, see how much it has read, and re-read or forget them.
 */
import { useEffect, useRef, useState } from "react";
import { FolderPlus, RefreshCw, Trash2, X } from "lucide-react";
import { useSettings } from "@/state/settings";
import { docsApi, indexDocuments, describeReport, type DocStatus } from "@/lib/documents";
import { Section, Field, Button, IconButton, Notice } from "./Form";

async function pickFolder(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "Choose a folder for BEV to read" });
  return typeof picked === "string" ? picked : null;
}

const ago = (ms?: number) => {
  if (!ms) return "never";
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} hour${h === 1 ? "" : "s"} ago` : `${Math.round(h / 24)} day${h < 48 ? "" : "s"} ago`;
};

export function DocumentsPanel() {
  const { settings, update } = useSettings();
  const docs = settings.documents;
  const [status, setStatus] = useState<DocStatus | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = () => docsApi.status().then(setStatus).catch(() => {});
  useEffect(() => {
    void refresh();
    poll.current = setInterval(refresh, 1500);
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, []);

  const readNow = async (folders = docs.folders) => {
    if (!folders.length) return;
    setMsg(null);
    try {
      const r = await indexDocuments();
      setMsg({ tone: "ok", text: `Done: ${describeReport(r)}.` });
    } catch (e) {
      setMsg({ tone: "danger", text: e instanceof Error ? e.message : String(e) });
    }
    void refresh();
  };

  const add = async () => {
    const f = await pickFolder();
    if (!f || docs.folders.includes(f)) return;
    const folders = [...docs.folders, f];
    await update({ documents: { ...docs, folders } });
    void readNow(folders);
  };

  const removeFolder = async (f: string) => {
    const folders = docs.folders.filter((x) => x !== f);
    await update({ documents: { ...docs, folders } });
    // Re-reading drops everything from folders no longer chosen.
    if (folders.length) void readNow(folders);
    else await docsApi.clear().then(refresh);
  };

  const running = status?.running;

  return (
    <>
      <Section
        title="Folders BEV reads"
        description="Choose folders of documents you'd like to ask BEV about, like “when does my lease end?” or “what did the builder's quote say?”. BEV reads PDFs, Word, PowerPoint, Excel and text files into a search index on this PC. Only the passages needed to answer go to your AI when you ask."
        aside={
          <Button variant="primary" icon={FolderPlus} onClick={add} disabled={running}>
            Add folder
          </Button>
        }
      >
        {docs.folders.length === 0 ? (
          <Field label="No folders yet" hint="Documents is a good place to start. BEV skips system folders and anything over 60 MB.">
            <span />
          </Field>
        ) : (
          docs.folders.map((f) => (
            <Field key={f} label={f.split(/[\\/]/).filter(Boolean).pop() ?? f} hint={f}>
              <IconButton icon={X} size="sm" label={`Stop reading ${f}`} onClick={() => removeFolder(f)} disabled={running} />
            </Field>
          ))
        )}
      </Section>

      <Section title="What BEV has read">
        <Field
          label={running ? `Reading… ${status?.done ?? 0} of ${status?.total ?? 0}` : `${status?.files ?? 0} document${status?.files === 1 ? "" : "s"}`}
          hint={
            running
              ? "You can keep using BEV while it reads."
              : `${status?.passages ?? 0} passages searchable${status?.unreadable ? `, ${status.unreadable} couldn't be read (locked, damaged or too big)` : ""}. Last read ${ago(docs.lastIndexed)}; BEV re-reads changed files when it starts.`
          }
        >
          {running ? (
            <div className="h-1.5 w-40 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={status?.total ?? 0} aria-valuenow={status?.done ?? 0}>
              <div className="h-full bg-accent transition-[width] duration-base" style={{ width: `${status?.total ? (100 * status.done) / status.total : 0}%` }} />
            </div>
          ) : (
            <div className="flex gap-2">
              <Button icon={RefreshCw} onClick={() => readNow()} disabled={!docs.folders.length}>
                Read again
              </Button>
              <Button
                variant="danger"
                icon={Trash2}
                onClick={async () => {
                  await docsApi.clear();
                  setMsg({ tone: "ok", text: "BEV has forgotten what it read. Your files weren't touched." });
                  void refresh();
                }}
                disabled={!status?.files && !status?.unreadable}
              >
                Forget
              </Button>
            </div>
          )}
        </Field>
        {msg && (
          <div className="px-4 py-3">
            <Notice tone={msg.tone}>{msg.text}</Notice>
          </div>
        )}
      </Section>
    </>
  );
}
