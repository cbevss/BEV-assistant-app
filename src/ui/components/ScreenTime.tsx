/** Activity → Screen time: today's time per app. */
import { useEffect, useState } from "react";
import { useScreenTime, sumApps, dayKeys } from "@/lib/screentime";
import { useSettings } from "@/state/settings";
import { formatDuration } from "@/lib/timers";

export function ScreenTime() {
  const st = useScreenTime();
  const on = useSettings((s) => s.settings.screenTime);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    void useScreenTime.getState().load();
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const rows = sumApps(st.days, dayKeys("today", now));
  const total = rows.reduce((n, [, s]) => n + s, 0);
  const top = rows[0]?.[1] ?? 1;
  if (!on) return null;
  return (
    <section className="mb-8">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-2">
          <span className="h-px w-3 bg-accent" aria-hidden />
          Screen time today
        </h2>
        <span className="tnum font-mono text-2xs text-ink-3">{formatDuration(total * 1000)}</span>
      </div>
      <ul className="divide-y divide-line-subtle rounded-lg border border-line-subtle bg-surface-1">
        {rows.slice(0, 7).map(([app, s]) => (
          <li key={app} className="px-4 py-2.5 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span className="truncate text-ink">{app}</span>
              <span className="tnum shrink-0 font-mono text-xs text-ink-3">{formatDuration(s * 1000)}</span>
            </div>
            <div className="mt-1.5 h-0.5 rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-accent/60" style={{ width: `${(100 * s) / top}%` }} />
            </div>
          </li>
        ))}
        {rows.length === 0 && <li className="px-4 py-3 text-sm text-ink-3">Nothing yet today. Time away from the keyboard isn't counted.</li>}
      </ul>
    </section>
  );
}
