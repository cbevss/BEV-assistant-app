/** Activity → Play time: this week's gaming by game, and the last 7 days. */
import { useEffect, useState } from "react";
import { usePlaytime, allSessions, totalsSince, periodStart, perDay } from "@/lib/playtime";
import { formatDuration } from "@/lib/timers";

export function PlayTime() {
  const pt = usePlaytime();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    void usePlaytime.getState().load();
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const list = allSessions(now);
  const week = totalsSince(list, periodStart("week", now));
  const today = totalsSince(list, periodStart("today", now)).reduce((n, t) => n + t.ms, 0);
  const days = perDay(list, 7, now);
  const peak = Math.max(30, ...days);
  const weekTotal = week.reduce((n, t) => n + t.ms, 0);

  return (
    <section className="mb-8">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-2">
          <span className="h-px w-3 bg-accent" aria-hidden />
          Play time
        </h2>
        <span className="tnum font-mono text-2xs text-ink-3">
          today {formatDuration(today)} · week {formatDuration(weekTotal)}
        </span>
      </div>
      <div className="rounded-lg border border-line-subtle bg-surface-1">
        {pt.current && (
          <div className="flex items-center justify-between gap-4 border-b border-line-subtle px-4 py-2.5 text-sm">
            <span className="flex min-w-0 items-center gap-2 truncate text-ink">
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden />
              Playing {pt.current.game}
            </span>
            <span className="tnum shrink-0 font-mono text-xs text-ink-3">{formatDuration(now - pt.current.start)}</span>
          </div>
        )}
        <div className="flex h-16 items-end gap-1.5 px-4 pb-2 pt-3" role="img" aria-label={`Minutes played per day, last 7 days: ${days.join(", ")}`}>
          {days.map((m, i) => (
            <div key={i} className="flex h-full flex-1 flex-col justify-end" title={`${new Date(now - (6 - i) * 86_400_000).toLocaleDateString("en-GB", { weekday: "short" })}: ${formatDuration(m * 60_000)}`}>
              {m > 0 ? <div className="rounded-sm bg-accent/70" style={{ height: `${Math.max(6, (m / peak) * 100)}%` }} /> : <div className="h-px bg-line" />}
            </div>
          ))}
        </div>
        <ul className="divide-y divide-line-subtle border-t border-line-subtle">
          {week.slice(0, 6).map((t) => (
            <li key={t.game} className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
              <span className="truncate text-ink">{t.game}</span>
              <span className="tnum shrink-0 font-mono text-xs text-ink-3">
                {formatDuration(t.ms)} · {t.sessions} session{t.sessions === 1 ? "" : "s"}
              </span>
            </li>
          ))}
          {week.length === 0 && <li className="px-4 py-3 text-sm text-ink-3">No games played this week. BEV counts Steam games and full-screen games.</li>}
        </ul>
      </div>
    </section>
  );
}
