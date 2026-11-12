import { useCallback, useEffect, useMemo, useState } from "react";
import { native, MemoryRow } from "@/lib/native";
import { looksSensitive } from "@/lib/sensitive";
import { PageHeader, Section, TextInput, Button } from "../components/Form";
import { ConfirmDialog } from "../components/ConfirmDialog";

export function Memory() {
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editVal, setEditVal] = useState("");
  const [confirm, setConfirm] = useState<{ text: string; run: () => Promise<void> } | null>(null);

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

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? rows.filter((r) => `${r.key} ${r.value} ${r.category}`.toLowerCase().includes(s)) : rows;
  }, [rows, q]);

  const add = async () => {
    if (!newKey.trim() || !newVal.trim()) return;
    if (looksSensitive(newKey, newVal)) {
      setErr("That looks like a password, key or card number. BEV doesn't store those.");
      return;
    }
    await native.memoryUpsert(newKey.trim(), newVal.trim(), "manual");
    setNewKey("");
    setNewVal("");
    refresh();
  };

  const saveEdit = async (r: MemoryRow) => {
    if (looksSensitive(r.key, editVal)) {
      setErr("That looks like sensitive data. Not saved.");
      return;
    }
    await native.memoryUpsert(r.key, editVal.trim(), r.category);
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
        subtitle="Everything BEV remembers lives in a local SQLite database on this PC. Inspect, edit, export or permanently delete it."
      />
      {err && <p className="mb-4 text-sm text-bev-danger">{err}</p>}

      <Section title="Add a memory">
        <div className="flex flex-col gap-2 md:flex-row">
          <TextInput placeholder="e.g. gaming mode apps" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
          <TextInput placeholder="e.g. Discord, Spotify, Steam" value={newVal} onChange={(e) => setNewVal(e.target.value)} />
          <Button onClick={add} disabled={!newKey.trim() || !newVal.trim()}>
            Add
          </Button>
        </div>
      </Section>

      <Section
        title={`Stored (${rows.length})`}
        aside={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={exportJson} disabled={rows.length === 0}>
              Export
            </Button>
            <Button
              variant="danger"
              disabled={rows.length === 0}
              onClick={() =>
                setConfirm({
                  text: `Permanently delete all ${rows.length} memories? This can't be undone.`,
                  run: async () => {
                    for (const r of rows) await native.memoryDelete(r.id);
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
        <TextInput placeholder="Search memories…" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="divide-y divide-white/5">
          {filtered.map((r) => (
            <li key={r.id} className="flex items-start gap-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-100">{r.key}</span>
                  <span className="rounded bg-white/5 px-1.5 text-[10px] uppercase tracking-wider text-slate-500">
                    {r.category}
                  </span>
                </div>
                {editing === r.id ? (
                  <div className="mt-2 flex gap-2">
                    <TextInput autoFocus value={editVal} onChange={(e) => setEditVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveEdit(r)} />
                    <Button onClick={() => saveEdit(r)}>Save</Button>
                    <Button variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <p className="mt-0.5 text-sm text-slate-400">{r.value}</p>
                )}
                <p className="mt-1 text-[11px] text-slate-600">updated {new Date(r.updated_at * 1000).toLocaleString("en-GB")}</p>
              </div>
              {editing !== r.id && (
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setEditing(r.id);
                      setEditVal(r.value);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() =>
                      setConfirm({
                        text: `Delete the memory "${r.key}"? This can't be undone.`,
                        run: async () => {
                          await native.memoryDelete(r.id);
                          refresh();
                        },
                      })
                    }
                  >
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="py-6 text-center text-sm text-slate-500">
              {rows.length === 0 ? 'Nothing stored yet. Try: "BEV, remember that my main browser is Chrome."' : "No matches."}
            </li>
          )}
        </ul>
      </Section>

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
