/**
 * Settings → Usage: what BEV's AI use has cost, by day and by model, with
 * daily and monthly spending limits and prices you can set yourself.
 */
import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { useSettings } from "@/state/settings";
import { useUsage, totals, dayKey, monthStart, limitState, formatUsd, priceFor, BUILT_IN_PRICES, LOCAL, type UsageDays } from "@/ai/usage";
import { providerInfo, type ProviderId } from "@/ai/catalog";
import { PageHeader, Section, Field, TextInput, Button, Notice } from "../components/Form";

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

function lastDays(n: number, now = Date.now()) {
  return Array.from({ length: n }, (_, i) => dayKey(now - (n - 1 - i) * 86_400_000));
}

function byModel(days: UsageDays, from: string) {
  const out = new Map<string, { requests: number; input: number; output: number; cost: number | null; estimated: boolean }>();
  for (const [d, rows] of Object.entries(days)) {
    if (d < from) continue;
    for (const [k, r] of Object.entries(rows)) {
      const p = out.get(k) ?? { requests: 0, input: 0, output: 0, cost: 0, estimated: false };
      out.set(k, { requests: p.requests + r.requests, input: p.input + r.input, output: p.output + r.output, cost: p.cost === null || r.cost === null ? null : p.cost + r.cost, estimated: p.estimated || r.estimated });
    }
  }
  return [...out.entries()].sort((a, b) => (b[1].cost ?? 0) - (a[1].cost ?? 0) || b[1].requests - a[1].requests);
}

/** A money box that saves on blur; empty = no limit. */
function UsdInput({ value, onSave, label }: { value: number | null; onSave: (v: number | null) => void; label: string }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => setText(value === null ? "" : String(value)), [value]);
  const commit = () => {
    const t = text.trim().replace(/^\$/, "");
    if (!t) return onSave(null);
    const v = Number(t);
    if (Number.isFinite(v) && v >= 0) onSave(Math.round(v * 100) / 100);
    else setText(value === null ? "" : String(value));
  };
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-sm text-ink-3">$</span>
      <TextInput aria-label={label} inputMode="decimal" placeholder="No limit" className="w-28" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
    </div>
  );
}

export function Usage() {
  const usage = useUsage();
  const { settings, update } = useSettings();
  const sp = settings.spending;
  useEffect(() => void usage.load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const now = Date.now();
  const today = totals(usage.days, dayKey(now), dayKey(now));
  const month = totals(usage.days, monthStart(now));
  const st = limitState(usage.days, sp, now);
  const days = lastDays(14, now);
  const daily = days.map((d) => ({ d, ...totals(usage.days, d, d) }));
  const peak = Math.max(0.0001, ...daily.map((x) => x.cost));
  const models = useMemo(() => byModel(usage.days, monthStart(now)), [usage.days]); // eslint-disable-line react-hooks/exhaustive-deps
  const unpricedModels = models.filter(([k]) => {
    const [prov, ...rest] = k.split("/");
    return priceFor(prov as ProviderId, rest.join("/"), sp.prices) === null;
  });

  const setPrice = (model: string, field: "input" | "output", v: string) => {
    const n = Number(v);
    const cur = sp.prices[model] ?? { input: 0, output: 0 };
    const next = { ...sp.prices };
    if (v.trim() === "" && field === "input" && !cur.output) delete next[model];
    else if (Number.isFinite(n) && n >= 0) next[model] = { ...cur, [field]: n };
    void update({ spending: { ...sp, prices: next } });
  };

  return (
    <div>
      <PageHeader
        title="Usage"
        subtitle="What BEV's AI requests have cost, worked out from each provider's list prices. Your real bill can differ (taxes, discounts, cached tokens), so check your provider's dashboard for exact charges."
      />

      {st.reached && (
        <div className="mb-6">
          <Notice tone="danger">Your {st.reached} limit is reached: BEV isn't using paid AIs {st.reached === "daily" ? "until tomorrow" : "until next month"}. A local AI (Ollama) in your backups still works. Raise the limit below to carry on now.</Notice>
        </div>
      )}
      {!st.reached && st.near && (
        <div className="mb-6">
          <Notice tone="warn">Over 80% of your {st.near} limit is used.</Notice>
        </div>
      )}

      <Section title="Spending">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-line-subtle sm:grid-cols-4">
          {[
            ["Today", formatUsd(today.cost), `${today.requests} requests`],
            ["This month", formatUsd(month.cost), `${month.requests} requests`],
            ["Tokens this month", fmtTokens(month.input + month.output), `${fmtTokens(month.input)} in · ${fmtTokens(month.output)} out`],
            ["Daily average", formatUsd(month.cost / Math.max(1, new Date(now).getDate())), "this month"],
          ].map(([k, v, sub]) => (
            <div key={k} className="bg-surface-1 px-4 py-3">
              <div className="text-xs text-ink-3">{k}</div>
              <div className="tnum mt-0.5 text-xl text-ink">{v}</div>
              <div className="text-xs text-ink-4">{sub}</div>
            </div>
          ))}
        </div>
        {month.unpriced > 0 && <p className="mt-2 px-1 text-xs text-ink-3">{month.unpriced} request{month.unpriced === 1 ? "" : "s"} this month used a model without a price, so {month.unpriced === 1 ? "it isn't" : "they aren't"} counted. Add its price below.</p>}

        <div className="mt-5 px-1" role="img" aria-label="Estimated spend per day, last 14 days">
          <div className="flex h-28 items-end gap-1.5">
            {daily.map((x) => (
              <div key={x.d} className="group relative flex h-full flex-1 flex-col justify-end" title={`${x.d}: ${formatUsd(x.cost)}, ${x.requests} requests`}>
                <div className="rounded-sm bg-accent/70 transition-colors duration-fast group-hover:bg-accent" style={{ height: `${x.cost > 0 ? Math.max(3, (x.cost / peak) * 100) : 0}%` }} />
                {x.cost === 0 && <div className="h-px bg-line" />}
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-ink-4">
            <span>{new Date(now - 13 * 86_400_000).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
            <span>Today</span>
          </div>
        </div>
      </Section>

      <Section title="Limits" description="When a limit is reached, BEV stops using paid AIs until the day or month is over and lets you know. You get a heads-up at 80%. Leave a box empty for no limit.">
        <Field label="Daily limit" hint={`Spent today: about ${formatUsd(st.today)}.`}>
          <UsdInput label="Daily limit in dollars" value={sp.dailyUsd} onSave={(dailyUsd) => update({ spending: { ...sp, dailyUsd } })} />
        </Field>
        <Field label="Monthly limit" hint={`Spent this month: about ${formatUsd(st.month)}.`}>
          <UsdInput label="Monthly limit in dollars" value={sp.monthlyUsd} onSave={(monthlyUsd) => update({ spending: { ...sp, monthlyUsd } })} />
        </Field>
      </Section>

      <Section title="This month by model">
        {models.length === 0 ? (
          <Field label="Nothing yet" hint="Usage appears here once BEV has answered something.">
            <span />
          </Field>
        ) : (
          models.map(([k, r]) => {
            const [prov, ...rest] = k.split("/");
            const model = rest.join("/");
            const label = providerInfo(prov as ProviderId).label;
            return (
              <Field key={k} label={`${model}`} hint={`${label} · ${r.requests} requests · ${fmtTokens(r.input)} in, ${fmtTokens(r.output)} out${r.estimated ? " (some estimated)" : ""}`}>
                <span className="tnum text-sm text-ink">{LOCAL.has(prov as ProviderId) ? "Free (on this PC)" : r.cost === null ? "No price" : formatUsd(r.cost)}</span>
              </Field>
            );
          })
        )}
      </Section>

      <Section title="Prices" description={`USD per million tokens. Built in: ${Object.keys(BUILT_IN_PRICES).join(", ")}. Set a price for any other model you use, or to override one.`}>
        {[...new Set([...unpricedModels.map(([k]) => k.split("/").slice(1).join("/")), ...Object.keys(sp.prices)])].map((m) => (
          <Field key={m} label={m} hint={BUILT_IN_PRICES[m] ? `Built-in: $${BUILT_IN_PRICES[m].input} in / $${BUILT_IN_PRICES[m].output} out` : sp.prices[m] ? "Your price" : "No price yet"}>
            <div className="flex items-center gap-2 text-xs text-ink-3">
              In
              <TextInput aria-label={`${m} input price`} inputMode="decimal" className="w-20" defaultValue={sp.prices[m]?.input ?? ""} onBlur={(e) => setPrice(m, "input", e.target.value)} />
              Out
              <TextInput aria-label={`${m} output price`} inputMode="decimal" className="w-20" defaultValue={sp.prices[m]?.output ?? ""} onBlur={(e) => setPrice(m, "output", e.target.value)} />
            </div>
          </Field>
        ))}
        {unpricedModels.length === 0 && Object.keys(sp.prices).length === 0 && (
          <Field label="All the models you've used have prices" hint="Models without a built-in price show up here to fill in.">
            <span />
          </Field>
        )}
      </Section>

      <Section title="History">
        <Field label="Clear usage history" hint="Forgets the counts above (kept for 120 days). It doesn't change anything with your providers.">
          <Button variant="danger" icon={Trash2} onClick={() => usage.clear()} disabled={!Object.keys(usage.days).length}>
            Clear
          </Button>
        </Field>
      </Section>
    </div>
  );
}
