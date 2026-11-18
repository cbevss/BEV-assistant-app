/** Notes vault, conversation history and search settings for the Memory page. */
import { useCallback, useEffect, useState } from "react";
import { native, type ConvMessage, type ConvSession, type Note } from "@/lib/native";
import { useSettings } from "@/state/settings";
import { saveNote, deleteNote, searchNotes, backfillEmbeddings, type NoteResult } from "@/brain/memory";
import { embedStatus, onEmbedStatus, preloadEmbedder, type EmbedStatus } from "@/brain/embed";
import { Section, Field, TextInput, TextArea, Button, Toggle, Select, StatusPill } from "./Form";
import { ConfirmDialog } from "./ConfirmDialog";

const date = (s: number) => new Date(s * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const isUrl = (s: string) => /^https?:\/\//i.test(s);

function useConfirm() {
  const [c, setC] = useState<{ text: string; run: () => Promise<void> } | null>(null);
  const dialog = c && (
    <ConfirmDialog
      text={c.text}
      onCancel={() => setC(null)}
      onConfirm={async () => {
        const x = c;
        setC(null);
        await x.run().catch(() => {});
      }}
    />
  );
  return [setC, dialog] as const;
}

// ---------------------------------------------------------------------------

export function NotesPanel() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<NoteResult[] | null>(null);
  const [open, setOpen] = useState<Note | null>(null);
  const [draft, setDraft] = useState<{ id?: number; title: string; body: string; source: string; tags: string } | null>(null);
  const [confirm, dialog] = useConfirm();

  const refresh = useCallback(() => native.notesList().then(setNotes).catch(() => setNotes([])), []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    if (!q.trim()) return setHits(null);
    const t = setTimeout(() => searchNotes(q.trim(), 20).then(setHits).catch(() => setHits([])), 250);
    return () => clearTimeout(t);
  }, [q]);

  const save = async () => {
    if (!draft || !draft.title.trim() || !draft.body.trim()) return;
    await saveNote({ ...draft, title: draft.title.trim(), body: draft.body.trim(), source: draft.source.trim() || "added by hand" });
    setDraft(null);
    refresh();
  };

  const list: Array<{ id: number; title: string; text: string; source: string; at: number }> = hits
    ? hits.map((h) => ({ id: h.id, title: h.title, text: h.snippet, source: h.source, at: h.updated_at }))
    : notes.map((n) => ({ id: n.id, title: n.title, text: n.body.slice(0, 200), source: n.source, at: n.updated_at }));

  return (
    <Section
      title={`Notes (${notes.length})`}
      aside={
        <Button variant="ghost" onClick={() => setDraft({ title: "", body: "", source: "", tags: "" })}>
          New note
        </Button>
      }
    >
      <p className="text-sm text-ink-2">Things BEV saved for later, each with where it came from. Ask “BEV, what did I save about…?”</p>
      {draft && (
        <div className="space-y-2 rounded-lg border border-line p-3">
          <TextInput placeholder="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <TextArea rows={6} placeholder="Note" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          <div className="flex gap-2">
            <TextInput placeholder="Source (link or where it's from)" value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} />
            <TextInput placeholder="Tags, comma-separated" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!draft.title.trim() || !draft.body.trim()}>
              Save
            </Button>
          </div>
        </div>
      )}
      <TextInput placeholder="Search notes by meaning or words…" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="divide-y divide-line-subtle">
        {list.map((n) => (
          <li key={n.id} className="flex items-start gap-4 py-3">
            <button className="min-w-0 flex-1 text-left" onClick={() => native.noteGet(n.id).then(setOpen)}>
              <div className="text-sm font-medium text-ink">{n.title}</div>
              <p className="mt-0.5 line-clamp-2 text-sm text-ink-2">{n.text}</p>
              <p className="mt-1 text-[11px] text-ink-4">
                {n.source ? `${n.source} · ` : ""}
                {date(n.at)}
              </p>
            </button>
            <Button
              variant="danger"
              onClick={() =>
                confirm({
                  text: `Delete the note "${n.title}"? This can't be undone.`,
                  run: async () => {
                    await deleteNote(n.id);
                    if (open?.id === n.id) setOpen(null);
                    refresh();
                  },
                })
              }
            >
              Delete
            </Button>
          </li>
        ))}
        {list.length === 0 && <li className="py-6 text-center text-sm text-ink-3">{hits ? "No matches." : 'No notes yet. Try: "BEV, save a note about…"'}</li>}
      </ul>
      {open && (
        <div className="space-y-2 rounded-lg border border-line p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-base font-medium text-white">{open.title}</div>
              <div className="text-xs text-ink-3">
                Source:{" "}
                {isUrl(open.source) ? (
                  <a className="text-accent underline" href={open.source} target="_blank" rel="noreferrer">
                    {open.source}
                  </a>
                ) : (
                  open.source || "none"
                )}{" "}
                · {date(open.created_at)}
                {open.tags ? ` · ${open.tags}` : ""}
              </div>
            </div>
            <div className="flex gap-1">
              <Button variant="ghost" onClick={() => (setDraft({ id: open.id, title: open.title, body: open.body, source: open.source, tags: open.tags }), setOpen(null))}>
                Edit
              </Button>
              <Button variant="ghost" onClick={() => setOpen(null)}>
                Close
              </Button>
            </div>
          </div>
          <p className="whitespace-pre-wrap text-sm text-ink-2">{open.body}</p>
        </div>
      )}
      {dialog}
    </Section>
  );
}

// ---------------------------------------------------------------------------

export function HistoryPanel() {
  const { settings, update } = useSettings();
  const [sessions, setSessions] = useState<ConvSession[]>([]);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Awaited<ReturnType<typeof native.convSearch>> | null>(null);
  const [view, setView] = useState<{ session: string; messages: ConvMessage[] } | null>(null);
  const [confirm, dialog] = useConfirm();

  const refresh = useCallback(() => native.convSessions(50).then(setSessions).catch(() => setSessions([])), []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    if (!q.trim()) return setHits(null);
    const t = setTimeout(() => native.convSearch(q.trim(), 30).then(setHits).catch(() => setHits([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  const openSession = (session: string) => native.convSession(session).then((messages) => setView({ session, messages }));

  return (
    <Section
      title="Conversation history"
      aside={
        <Button
          variant="danger"
          disabled={sessions.length === 0}
          onClick={() =>
            confirm({
              text: "Delete all conversation history? This can't be undone.",
              run: async () => {
                await native.convClear();
                setView(null);
                refresh();
              },
            })
          }
        >
          Delete all
        </Button>
      }
    >
      <Field label="Keep history" hint="What you and BEV said (not screenshots or web pages), kept on this PC so BEV can look back. Anything that looks like a key or card number is never saved.">
        <Toggle label="Keep history" checked={settings.keepHistory} onChange={(keepHistory) => update({ keepHistory })} />
      </Field>
      <Field label="Keep for">
        <Select
          ariaLabel="History retention"
          value={String(settings.historyDays)}
          onChange={async (v) => {
            await update({ historyDays: Number(v) });
            await native.convPrune(Number(v)).catch(() => {});
            refresh();
          }}
          options={[
            { value: "7", label: "1 week" },
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
            { value: "365", label: "1 year" },
          ]}
        />
      </Field>
      <TextInput placeholder="Search past conversations…" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="divide-y divide-line-subtle">
        {hits
          ? hits.map((h) => (
              <li key={h.id} className="py-2">
                <button className="w-full text-left" onClick={() => openSession(h.session)}>
                  <span className="text-xs text-ink-3">{date(h.at)} · {h.role === "user" ? "You" : "BEV"}</span>
                  <p className="text-sm text-ink-2">{h.snippet.replace(/\[|\]/g, "")}</p>
                </button>
              </li>
            ))
          : sessions.map((s) => (
              <li key={s.session} className="py-2">
                <button className="w-full text-left" onClick={() => openSession(s.session)}>
                  <span className="text-xs text-ink-3">
                    {date(s.started)} · {s.count} messages
                  </span>
                  <p className="line-clamp-1 text-sm text-ink-2">{s.first}</p>
                </button>
              </li>
            ))}
        {(hits ?? sessions).length === 0 && <li className="py-6 text-center text-sm text-ink-3">{hits ? "No matches." : "No conversations saved yet."}</li>}
      </ul>
      {view && (
        <div className="max-h-96 space-y-2 overflow-y-auto rounded-lg border border-line p-3">
          <div className="flex justify-end">
            <Button variant="ghost" onClick={() => setView(null)}>
              Close
            </Button>
          </div>
          {view.messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "text-right" : ""}>
              <span className="text-[11px] text-ink-4">{date(m.at)}</span>
              <p className={`inline-block max-w-[85%] rounded-lg px-3 py-1.5 text-sm ${m.role === "user" ? "bg-accent/10 text-ink" : "bg-surface-2 text-ink-2"}`}>{m.text}</p>
            </div>
          ))}
        </div>
      )}
      {dialog}
    </Section>
  );
}

// ---------------------------------------------------------------------------

export function SemanticSearchSettings() {
  const { settings, update } = useSettings();
  const [st, setSt] = useState<EmbedStatus>(embedStatus());
  useEffect(() => onEmbedStatus(setSt), []);
  const label = st.state === "downloading" ? `downloading ${st.percent}%` : st.state === "ready" ? "ready" : st.state === "error" ? "keyword search only" : "not loaded";
  return (
    <Section title="Search by meaning" aside={settings.semanticSearch ? <StatusPill ok={st.state === "ready" ? true : st.state === "error" ? false : null} label={label} /> : undefined}>
      <Field
        label="Find memories and notes by meaning"
        hint="A small model (about 23 MB, downloaded once) runs on this PC so “my car” finds “vehicle: Golf”. Off, or before it's downloaded, BEV matches words instead."
      >
        <Toggle
          label="Search by meaning"
          checked={settings.semanticSearch}
          onChange={async (semanticSearch) => {
            await update({ semanticSearch });
            if (semanticSearch) {
              preloadEmbedder();
              backfillEmbeddings();
            }
          }}
        />
      </Field>
      {st.state === "error" && settings.semanticSearch && <p className="text-xs text-ink-3">Couldn't load the model ({st.message}). Keyword search still works.</p>}
    </Section>
  );
}
