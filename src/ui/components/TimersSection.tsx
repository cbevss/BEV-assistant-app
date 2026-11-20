/** Automations → Timers & reminders: what's running on this PC, with cancel. */
import { useEffect, useState } from "react";
import { X, LayoutGrid } from "lucide-react";
import { useLayouts } from "@/lib/layouts";
import { useCountdowns, describeCountdown, daysUntil, nextDate } from "@/lib/countdowns";
import { useTimers, clockDown, clockTime, formatDuration } from "@/lib/timers";
import { useWatches, describeWatch } from "@/lib/watches";
import { Section, Field, IconButton, Button } from "./Form";

/** “Tell me when…” watches BEV is keeping an eye on. */
export function WatchesSection() {
  const { watches, remove } = useWatches();
  useEffect(() => void useWatches.getState().load(), []);
  return (
    <Section title="Watching for" description="Ask BEV to tell you when something happens: “tell me when my download finishes”, “let me know when Blender's done”, “warn me if my GPU goes over 90°C”. Each one is checked every few seconds and lasts up to a day.">
      {watches.length === 0 ? (
        <Field label="Nothing yet" hint="Things you ask BEV to watch for appear here.">
          <span />
        </Field>
      ) : (
        watches.map((w) => {
          const t = describeWatch(w);
          return (
            <Field key={w.id} label={t.charAt(0).toUpperCase() + t.slice(1)} hint={`${w.message ? `Says “${w.message}” · ` : ""}until ${clockTime(w.expires)}${new Date(w.expires).toDateString() !== new Date().toDateString() ? " tomorrow" : ""}`}>
              <IconButton icon={X} size="sm" label={`Stop watching ${t}`} onClick={() => remove([w.id])} />
            </Field>
          );
        })
      )}
    </Section>
  );
}

/** Saved window arrangements, with Restore. */
export function LayoutsSection() {
  const { layouts, remove, restore } = useLayouts();
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => void useLayouts.getState().load(), []);
  return (
    <Section title="Window layouts" description="Arrange your windows across your monitors, then say “save this as my streaming layout”. “Restore my streaming layout” puts every app back where it was.">
      {layouts.length === 0 ? (
        <Field label="No layouts saved" hint="BEV can also move single windows: “put Discord on my second monitor”, “snap Chrome to the left”.">
          <span />
        </Field>
      ) : (
        layouts.map((l) => (
          <Field key={l.name} label={l.name} hint={`${l.windows.length} windows: ${[...new Set(l.windows.map((w) => w.process.replace(/\.exe$/i, "")))].join(", ")}`}>
            <div className="flex items-center gap-1">
              <Button size="sm" icon={LayoutGrid} onClick={async () => setMsg(await restore(l.name).catch((e) => String(e instanceof Error ? e.message : e)))}>
                Restore
              </Button>
              <IconButton icon={X} size="sm" label={`Delete ${l.name}`} onClick={() => remove(l.name)} />
            </div>
          </Field>
        ))
      )}
      {msg && <p className="px-4 py-2 text-xs text-ink-3">{msg}</p>}
    </Section>
  );
}

/** Countdowns to dates. */
export function CountdownsSection() {
  const { items, set } = useCountdowns();
  useEffect(() => void useCountdowns.getState().load(), []);
  const now = Date.now();
  const sorted = [...items].sort((a, b) => nextDate(a, now) - nextDate(b, now));
  if (!sorted.length) return null;
  return (
    <Section title="Countdowns" description="Ask BEV to count down to a date (“count down to my holiday on 14 March”), then “how long until my holiday?”.">
      {sorted.map((c) => (
        <Field key={c.name} label={c.name} hint={describeCountdown(c, now)}>
          <div className="flex items-center gap-3">
            <span className="tnum font-mono text-sm text-ink">{Math.max(0, daysUntil(c, now))}d</span>
            <IconButton icon={X} size="sm" label={`Remove ${c.name}`} onClick={() => set(items.filter((x) => x !== c))} />
          </div>
        </Field>
      ))}
    </Section>
  );
}

export function TimersSection() {
  const { timers, stopwatch, cancel, setStopwatch } = useTimers();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    void useTimers.getState().load();
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const sw = stopwatch.before + (stopwatch.since ? now - stopwatch.since : 0);

  return (
    <Section title="Timers & reminders" description="Set by asking BEV (“set a timer for 10 minutes”, “wake me at 7:30 on weekdays”, “remind me at 6 to call Mum”). They run on this PC while BEV is open; anything missed while it's closed is mentioned when it opens.">
      {timers.length === 0 && !sw ? (
        <Field label="Nothing running" hint="Timers, alarms and reminders you set appear here.">
          <span />
        </Field>
      ) : null}
      {timers.map((t) => (
        <Field
          key={t.id}
          label={t.label || (t.kind === "timer" ? `${formatDuration(t.durationMs ?? 0)} timer` : t.kind === "alarm" ? "Alarm" : "Reminder")}
          hint={`${t.kind === "timer" ? "Timer" : t.kind === "alarm" ? "Alarm" : "Reminder"} · ${t.kind === "timer" ? `done at ${clockTime(t.due)}` : `${new Date(t.due).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${clockTime(t.due)}`}${t.repeat ? ` · ${t.repeat}` : ""}${t.everyMin ? ` · every ${formatDuration(t.everyMin * 60_000)}${t.until ? ` until ${clockTime(t.until)}` : ""}` : ""}`}
        >
          <div className="flex items-center gap-3">
            <span className="tnum font-mono text-sm text-ink">{clockDown(t.due - now)}</span>
            <IconButton icon={X} size="sm" label={`Cancel ${t.label || t.kind}`} onClick={() => cancel([t.id])} />
          </div>
        </Field>
      ))}
      {sw > 0 && (
        <Field label="Stopwatch" hint={stopwatch.since ? "Running" : "Stopped"}>
          <div className="flex items-center gap-3">
            <span className="tnum font-mono text-sm text-ink">{clockDown(sw)}</span>
            <IconButton icon={X} size="sm" label="Reset the stopwatch" onClick={() => setStopwatch({ since: null, before: 0 })} />
          </div>
        </Field>
      )}
    </Section>
  );
}
