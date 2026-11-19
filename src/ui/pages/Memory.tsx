import { Download, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SlidingUnderline, useActiveRect } from "../components/Motion";
import { native, MemoryRow } from "@/lib/native";
import { looksSensitive } from "@/lib/sensitive";
import { PageHeader, Section, TextInput, Button, IconButton, Badge } from "../components/Form";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { NotesPanel, HistoryPanel, SemanticSearchSettings } from "../components/BrainPanels";
import { DocumentsPanel } from "../components/DocumentsPanel";
import { remember, forgetMemory, searchMemories } from "@/brain/memory";

export function Memory() {
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editVal, setEditVal] = useState("");
  const [confirm, setConfirm] = useState<{ text: string; run: () => Promise<void> } | null>(null);
  const [tab, setTab] = useState<"memories" | "notes" | "documents" | "history">(() => {
    const t = new URLSearchParams(location.search).get("tab");
    return t === "notes" || t === "documents" || t === "history" ? t : "memories";
  });
  const tabsRef = useRef<HTMLDivElement>(null);
  const tabRect = useActiveRect(tabsRef, tab);
  const [ranked, setRanked] = useState<MemoryRow[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRows(await native.memoryList());
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Search by meaning and words (falls back to plain matching).
  useEffect(() => {
    const s = q.trim();
    if (!s) return setRanked(null);
    const t = setTimeout(() => {
      searchMemories(s, 50, rows)
        .then((r) => setRanked(r.map((x) => x.item)))
        .catch(() => setRanked(null));
    }, 200);
    return () => clearTimeout(t);
  }, [q, rows]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    if (ranked) return ranked;
    return rows.filter((r) => `${r.key} ${r.value} ${r.category}`.toLowerCase().includes(s));
  }, [rows, q, ranked]);

  const add = async () => {
    if (!newKey.trim() || !newVal.trim()) return;
    if (looksSensitive(newKey, newVal)) {
      setErr("That looks like a password, key or card number. BEV doesn't store those.");
      return;
    }
    const r = await remember(newKey.trim(), newVal.trim(), { category: "manual" });
    if (r.kind === "conflict") {
      setConfirm({
        text: `This looks like "${r.existing.key}: ${r.existing.value}". Replace that memory with the new one?`,
        run: async () => {
          await remember(newKey.trim(), newVal.trim(), { category: "manual", replaces: r.existing.id });
          setNewKey("");
          setNewVal("");
          refresh();
        },
      });
      return;
    }
    if (r.kind === "duplicate") setErr(`Already remembered as "${r.existing.key}".`);
    setNewKey("");
    setNewVal("");
    refresh();
  };

  const saveEdit = async (r: MemoryRow) => {
    if (looksSensitive(r.key, editVal)) {
      setErr("That looks like sensitive data. Not saved.");
      return;
    }
    await remember(r.key, editVal.trim(), { category: r.category });
    setEditing(null);
    refresh();
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bev-memories-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <PageHeader
        title="Memory"
        subtitle="Everything BEV remembers (facts, notes, past conversations and what it has read of your documents) lives in a local database on this PC. Inspect, edit, export or permanently delete it."
      />
      {err && <p className="mb-4 text-sm text-danger">{err}</p>}

      <div ref={tabsRef} className="relative mb-6 flex gap-5 border-b border-line-subtle" role="tablist">
        <SlidingUnderline rect={tabRect.rect} ready={tabRect.ready} />
        {(["memories", "notes", "documents", "history"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            data-active={tab === t ? "true" : undefined}
            onClick={() => setTab(t)}
            className={`pb-2.5 text-sm capitalize transition-colors duration-fast ${tab === t ? "text-ink" : "text-ink-3 hover:text-ink"}`}
          >
            {t === "memories" ? "Facts & preferences" : t}
          </button>
        ))}
      </div>
      <div key={tab} className="animate-page-in">
      {tab === "notes" && <NotesPanel />}
      {tab === "history" && <HistoryPanel />}
      {tab === "documents" && <DocumentsPanel />}
      {tab === "memories" && (
        <>

      <Section title="Add a memory" description="Something BEV should always know, as a name and a value.">
        <div className="flex flex-col gap-2 md:flex-row">
          <TextInput aria-label="Name" placeholder="Name, e.g. gaming apps" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
          <TextInput aria-label="Value" placeholder="Value, e.g. Discord, Spotify, Steam" value={newVal} onChange={(e) => setNewVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <Button variant="primary" icon={Plus} onClick={add} disabled={!newKey.trim() || !newVal.trim()}>
            Add
          </Button>
        </div>
      </Section>

      <Section
        title={`Stored (${rows.length})`}
        flush
        aside={
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" icon={Download} onClick={exportJson} disabled={rows.length === 0}>
              Export
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={rows.length === 0}
              onClick={() =>
                setConfirm({
                  text: `Permanently delete all ${rows.length} memories? This can't be undone.`,
                  run: async () => {
                    for (const r of rows) await forgetMemory(r.id);
                    refresh();
                  },
                })
              }
            >
              Delete all
            </Button>
          </div>
        }
      >
        <div className="border-b border-line-subtle px-4 py-3">
          <TextInput aria-label="Search memories" placeholder="Search by meaning or words" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ul className="divide-y divide-line-subtle">
          {filtered.map((r) => (
            <li key={r.id} className="group flex items-start gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-ink">{r.key}</span>
                  <Badge>{r.category}</Badge>
                </div>
                {editing === r.id ? (
                  <div className="mt-2 flex gap-2">
                    <TextInput autoFocus value={editVal} onChange={(e) => setEditVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveEdit(r)} />
                    <Button variant="primary" onClick={() => saveEdit(r)}>Save</Button>
                    <Button variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <p className="mt-0.5 text-sm text-ink-2">{r.value}</p>
                )}
                <p className="mt-1 text-2xs text-ink-4">Updated {new Date(r.updated_at * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</p>
              </div>
              {editing !== r.id && (
                <div className="flex gap-0.5 opacity-60 transition-opacity duration-fast group-hover:opacity-100 focus-within:opacity-100">
                  <IconButton
                    icon={Pencil}
                    size="sm"
                    label={`Edit ${r.key}`}
                    onClick={() => {
                      setEditing(r.id);
                      setEditVal(r.value);
                    }}
                  />
                  <IconButton
                    icon={Trash2}
                    size="sm"
                    label={`Delete ${r.key}`}
                    className="hover:!bg-danger/10 hover:!text-danger"
                    onClick={() =>
                      setConfirm({
                        text: `Delete the memory "${r.key}"? This can't be undone.`,
                        run: async () => {
                          await forgetMemory(r.id);
                          refresh();
                        },
                      })
                    }
                  />
                </div>
              )}
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-4 py-8 text-center text-sm text-ink-3">
              {rows.length === 0 ? 'Nothing stored yet. Try: "BEV, remember that my main browser is Chrome."' : "No matches."}
            </li>
          )}
        </ul>
      </Section>

          <SemanticSearchSettings />
        </>
      )}
      </div>

      {confirm && (
        <ConfirmDialog
          text={confirm.text}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const c = confirm;
            setConfirm(null);
            await c.run().catch((e) => setErr(String(e)));
          }}
        />
      )}
    </div>
  );
}
