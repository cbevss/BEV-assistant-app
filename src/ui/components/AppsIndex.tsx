import { useEffect, useMemo, useState } from "react";
import { appsApi, type AppIndexStatus, type AppRow } from "@/lib/apps";
import { Section, Field, TextInput, Button, StatusPill } from "./Form";

const KIND_LABEL: Record<AppRow["kind"], string> = { packaged: "Store", win32: "Desktop", system: "Windows" };

function ago(ms: number): string {
  if (!ms) return "never";
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** What BEV can open: the installed-app index, searchable, with a rescan. */
export function AppsIndex() {
  const [status, setStatus] = useState<AppIndexStatus | null>(null);
  const [rows, setRows] = useState<AppRow[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const [s, l] = await Promise.all([appsApi.status(), appsApi.list()]);
      setStatus(s);
      setRows(l);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    load();
    // A background scan may be running at startup: check back until it's done.
    const id = setInterval(() => {
      appsApi.status().then((s) => {
        setStatus(s);
        if (!s.scanning) appsApi.list().then(setRows).catch(() => {});
      }).catch(() => {});
    }, 4000);
    return () => clearInterval(id);
  }, []);

  const refresh = async () => {
    setBusy(true);
    setErr(null);
    try {
      await appsApi.refresh();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s ? rows.filter((r) => `${r.name} ${r.exe_name ?? ""} ${r.aliases.join(" ")}`.toLowerCase().includes(s)) : rows;
    return list.slice(0, 200);
  }, [rows, q]);

  const scanning = busy || status?.scanning;
  return (
    <Section
      title="Apps BEV can open"
      aside={<StatusPill ok={status ? (status.last_error ? false : status.count > 0) : null} label={scanning ? "scanning…" : status ? `${status.count} apps` : "…"} />}
    >
      <Field
        label="Installed apps"
        hint={`Found from the Start menu, Microsoft Store, shortcuts and Windows' app registry. Last scan: ${ago(status?.scanned_at ?? 0)}. BEV rescans by itself when you ask for something it doesn't know yet.`}
      >
        <div className="flex justify-end">
          <Button variant="ghost" onClick={refresh} disabled={!!scanning}>
            {scanning ? "Scanning…" : "Rescan now"}
          </Button>
        </div>
      </Field>
      {(err || status?.last_error) && <p className="text-sm text-danger">{err ?? status?.last_error}</p>}
      <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search installed apps…" aria-label="Search installed apps" />
      {rows.length === 0 ? (
        <p className="text-sm text-ink-3">{scanning ? "Looking at what's installed…" : "No apps indexed yet. Press Rescan now."}</p>
      ) : (
        <ul className="max-h-72 divide-y divide-line-subtle overflow-y-auto rounded-lg border border-line-subtle" aria-label="Installed apps">
          {shown.map((r) => (
            <li key={`${r.name}|${r.exe_name ?? r.kind}`} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <div className="min-w-0">
                <div className="truncate text-sm text-ink">{r.name}</div>
                {(r.exe_name || r.aliases.length > 0) && (
                  <div className="truncate text-xs text-ink-3">
                    {[r.exe_name, r.aliases.length ? `also: ${r.aliases.slice(0, 3).join(", ")}` : ""].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
              <span className="shrink-0 text-xs text-ink-3">{KIND_LABEL[r.kind]}</span>
            </li>
          ))}
          {shown.length === 0 && <li className="px-3 py-2 text-sm text-ink-3">Nothing installed matches “{q}”.</li>}
        </ul>
      )}
    </Section>
  );
}
