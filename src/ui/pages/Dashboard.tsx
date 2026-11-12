import { useEffect, useState } from "react";
import { native, SystemStats, RunningApp } from "@/lib/native";
import { useAssistant } from "@/state/assistant";

export function Dashboard() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [apps, setApps] = useState<RunningApp[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const messages = useAssistant((s) => s.messages);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [s, a] = await Promise.all([native.getSystemStats(), native.getRunningApps(6)]);
        if (alive) {
          setStats(s);
          setApps(a);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const id = setInterval(tick, 2000); // modest poll; no busy loop
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-glow">Dashboard</h1>
        <p className="text-sm text-slate-400">
          {stats?.host ? `${stats.host} · ` : ""}live system telemetry
        </p>
      </header>

      {err && (
        <div className="glass rounded-xl border border-bev-danger/30 p-4 text-sm text-bev-danger">
          Telemetry unavailable: {err}
        </div>
      )}

      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Metric label="CPU" value={stats ? `${stats.cpu_usage.toFixed(0)}%` : "—"} sub={stats ? `${stats.cpu_cores} cores` : ""} pct={stats?.cpu_usage} />
        <Metric
          label="RAM"
          value={stats ? `${(stats.mem_used_mb / 1024).toFixed(1)} GB` : "—"}
          sub={stats ? `of ${(stats.mem_total_mb / 1024).toFixed(0)} GB` : ""}
          pct={stats?.mem_percent}
        />
        <Metric
          label="GPU"
          value={stats?.gpu_usage != null ? `${stats.gpu_usage.toFixed(0)}%` : "n/a"}
          sub={stats?.gpu_usage == null ? "no sensor bridge" : stats.gpu_name ?? ""}
        />
        <Metric
          label="Uptime"
          value={stats ? fmtUptime(stats.uptime_secs) : "—"}
          sub="since boot"
        />
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title="Top processes">
          <ul className="space-y-2 text-sm">
            {apps.map((a) => (
              <li key={a.pid} className="flex items-center justify-between">
                <span className="truncate text-slate-200">{a.name}</span>
                <span className="font-mono text-xs text-slate-400">{a.mem_mb} MB</span>
              </li>
            ))}
            {apps.length === 0 && <li className="text-slate-500">—</li>}
          </ul>
        </Panel>

        <Panel title="Recent assistant activity">
          <ul className="space-y-2 text-sm">
            {messages.slice(-6).reverse().map((m) => (
              <li key={m.id} className="flex items-start gap-2">
                <span className="mt-0.5 text-xs text-bev-cyan">
                  {m.role === "tool" ? (m.ok ? "✓" : "✕") : m.role === "user" ? "›" : "‹"}
                </span>
                <span className="truncate text-slate-300">{m.toolName ?? m.content}</span>
              </li>
            ))}
            {messages.length === 0 && (
              <li className="text-slate-500">Say “BEV” or use the chat to get started.</li>
            )}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function Metric({ label, value, sub, pct }: { label: string; value: string; sub?: string; pct?: number }) {
  return (
    <div className="glass rounded-xl p-4">
      <div className="text-xs uppercase tracking-widest text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-glow">{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
      {pct != null && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded bg-white/5">
          <div
            className="h-full rounded bg-gradient-to-r from-bev-cyan to-bev-violet transition-all"
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass rounded-xl p-5">
      <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-slate-400">{title}</h2>
      {children}
    </div>
  );
}

function fmtUptime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
