/** Activity: the PC right now, what BEV noticed, and its tasks. */
import { useEffect, useState } from "react";
import { native, SystemStats, RunningApp } from "@/lib/native";
import { BackgroundTasks } from "../components/BackgroundTasks";
import { Noticed } from "../components/Noticed";
import { RecentTasks } from "../components/RecentTasks";
import { PlayTime } from "../components/PlayTime";
import { gpuApi, type GpuStats } from "@/lib/gaming";
import { PageHeader, Notice } from "../components/Form";
import { HudLabel, Scale } from "../components/Hud";

export function Dashboard() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [apps, setApps] = useState<RunningApp[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [gpu, setGpu] = useState<GpuStats | null>(null);

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
    const gpuTick = () => gpuApi.stats().then((g) => alive && setGpu(g)).catch(() => {});
    gpuTick();
    const gid = setInterval(gpuTick, 4000);
    return () => {
      alive = false;
      clearInterval(id);
      clearInterval(gid);
    };
  }, []);

  const memGb = stats ? stats.mem_used_mb / 1024 : 0;
  const gpuPct = gpu?.usage ?? stats?.gpu_usage ?? null;

  return (
    <div>
      <PageHeader title="Activity" subtitle={stats?.host ? `${stats.host}, live` : "Your PC and BEV's work, live."} />
      {err && (
        <div className="mb-6">
          <Notice tone="danger">System readings aren't available: {err}</Notice>
        </div>
      )}

      <div className="mb-8 grid grid-cols-4 divide-x divide-line-subtle rounded-lg border border-line-subtle bg-surface-1 max-[900px]:grid-cols-2 max-[900px]:divide-x-0">
        <Stat label="CPU" value={stats ? `${stats.cpu_usage.toFixed(0)}%` : "—"} detail={stats ? `${stats.cpu_cores} cores` : ""} pct={stats?.cpu_usage} />
        <Stat label="Memory" value={stats ? `${memGb.toFixed(1)} GB` : "—"} detail={stats ? `of ${(stats.mem_total_mb / 1024).toFixed(0)} GB` : ""} pct={stats?.mem_percent} />
        <Stat
          label="Graphics"
          value={gpuPct != null ? `${gpuPct.toFixed(0)}%` : "—"}
          detail={gpuPct == null ? "No sensor available" : [gpu?.name ?? stats?.gpu_name, gpu?.temp_c != null ? `${Math.round(gpu.temp_c)}°C` : null].filter(Boolean).join(" · ")}
          pct={gpuPct ?? undefined}
        />
        <Stat label="Uptime" value={stats ? fmtUptime(stats.uptime_secs) : "—"} detail="Since last restart" />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-8 max-[1000px]:grid-cols-1">
        <div>
          <BackgroundTasks />
          <RecentTasks />
          <PlayTime />
        </div>
        <div>
          <Noticed />
          <section className="mb-8">
            <div className="mb-2 px-1">
              <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-2">
                <span className="h-px w-3 bg-accent" aria-hidden />
                Using the most memory
              </h2>
            </div>
            <ul className="divide-y divide-line-subtle rounded-lg border border-line-subtle bg-surface-1">
              {apps.map((a) => (
                <li key={a.pid} className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
                  <span className="truncate text-ink">{a.name.replace(/\.exe$/i, "")}</span>
                  <span className="tnum shrink-0 font-mono text-xs text-ink-3">{a.mem_mb >= 1024 ? `${(a.mem_mb / 1024).toFixed(1)} GB` : `${a.mem_mb} MB`}</span>
                </li>
              ))}
              {apps.length === 0 && <li className="px-4 py-3 text-sm text-ink-3">No readings yet.</li>}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, detail, pct }: { label: string; value: string; detail?: string; pct?: number }) {
  const hot = pct != null && pct >= 90;
  return (
    <div className="px-4 py-3.5">
      <HudLabel>{label}</HudLabel>
      <div className={`tnum mt-1.5 font-mono text-xl ${hot ? "text-warn" : "text-ink"}`}>{value}</div>
      <div className="mt-0.5 truncate text-2xs text-ink-4">{detail}</div>
      <div className="mt-3">{pct != null ? <Scale value={pct} tone={hot ? "warn" : "accent"} label={label} /> : <div className="h-2.5" />}</div>
    </div>
  );
}

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}
