/**
 * A dropdown of every model a provider offers, loaded live from its API,
 * with search (OpenRouter alone lists hundreds). If a brand-new model isn't
 * listed yet, typing its exact id offers to use it anyway.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Check, ChevronDown, RefreshCw, Search } from "lucide-react";
import { providerInfo, type ProviderId } from "@/ai/catalog";
import { listModels, type ModelOption } from "@/ai/models";

export function ModelPicker({
  provider,
  value,
  onChange,
  ariaLabel,
  emptyLabel,
  ollamaHost,
  keyVersion = 0,
}: {
  provider: ProviderId;
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  /** Offer a "none" choice with this label (e.g. "Same as main model"). */
  emptyLabel?: string;
  ollamaHost?: string;
  /** Bump when the key changes, to reload the list. */
  keyVersion?: number;
}) {
  const info = providerInfo(provider);
  // Dev preview can open one picker for screenshots (never in the built app).
  const [open, setOpen] = useState(() => import.meta.env.DEV && (globalThis as { __bevOpenPicker?: string }).__bevOpenPicker === ariaLabel);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      setModels(await listModels(provider, { ollamaHost, refresh }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setModels(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(keyVersion > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, ollamaHost, keyVersion]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const all: ModelOption[] = useMemo(() => {
    const base = models ?? info.suggested.map((id) => ({ id }));
    // Keep the current choice visible even if the list doesn't include it.
    return value && !base.some((m) => m.id === value) ? [{ id: value }, ...base] : base;
  }, [models, info.suggested, value]);

  const q = query.trim().toLowerCase();
  const shown = q ? all.filter((m) => m.id.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q)) : all;
  const custom = q && !all.some((m) => m.id.toLowerCase() === q) ? query.trim() : null;
  const rows: Array<{ id: string; label: string; sub?: string; custom?: boolean }> = [
    ...(emptyLabel && !q ? [{ id: "", label: emptyLabel }] : []),
    ...shown.map((m) => ({ id: m.id, label: m.id, sub: m.name })),
    ...(custom ? [{ id: custom, label: `Use “${custom}”`, custom: true }] : []),
  ];

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(rows.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows[active]) pick(rows[active].id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const current = value || emptyLabel || info.defaultModel;

  return (
    <div ref={root} className="relative w-full">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setActive(0);
        }}
        className="no-drag flex h-8 w-full items-center gap-2 rounded border border-line bg-surface-2 px-2.5 text-left text-sm text-ink transition-colors duration-fast hover:border-line-strong focus:border-accent/70 focus:outline-none focus:ring-2 focus:ring-accent/20"
      >
        <span className={clsx("min-w-0 flex-1 truncate", !value && emptyLabel && "text-ink-3", value && "font-mono text-[13px]")}>{current}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-40 animate-scale-in overflow-hidden rounded-lg border border-line bg-surface-2 shadow-pop">
          <div className="flex items-center gap-2 border-b border-line-subtle px-2.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKey}
              placeholder={`Search ${models ? models.length : ""} models`.replace("  ", " ")}
              aria-label={`Search ${info.label} models`}
              className="h-9 min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-4 focus:outline-none"
            />
            <button
              type="button"
              title="Reload the list"
              aria-label="Reload the list"
              onClick={() => void load(true)}
              className="grid h-6 w-6 place-items-center rounded text-ink-3 hover:bg-surface-3 hover:text-ink"
            >
              <RefreshCw className={clsx("h-3.5 w-3.5", loading && "animate-spin")} aria-hidden />
            </button>
          </div>
          {error && <p className="border-b border-line-subtle px-3 py-2 text-xs text-ink-3">{error} Showing suggestions for now.</p>}
          <ul ref={listRef} role="listbox" className="max-h-[260px] overflow-y-auto py-1">
            {loading && !models && <li className="px-3 py-2 text-sm text-ink-3">Loading models…</li>}
            {rows.map((r, i) => (
              <li
                key={`${r.id}-${i}`}
                data-i={i}
                role="option"
                aria-selected={r.id === value}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(r.id)}
                className={clsx("flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm", i === active ? "bg-surface-3" : "", r.custom ? "text-accent" : "text-ink")}
              >
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className={clsx("truncate", r.id && !r.custom && "font-mono text-[13px]", !r.id && "text-ink-2")}>{r.label}</span>
                  {r.sub && <span className="truncate text-xs text-ink-3">{r.sub}</span>}
                </span>
                {r.id === value && !r.custom && <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />}
              </li>
            ))}
            {!loading && rows.length === 0 && <li className="px-3 py-2 text-sm text-ink-3">No models match.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
