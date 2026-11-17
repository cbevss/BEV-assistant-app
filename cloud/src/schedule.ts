/**
 * Repeat rules and times, in the user's time zone (Europe/London by default),
 * so "daily 08:00" stays 08:00 across the clock changes.
 *
 * Rules:  "every 30m" | "every 2h" | "daily 08:00" | "weekdays 08:00" |
 *         "weekly mon 09:00" | "weekly mon,thu 18:30" | "monthly 1 09:00"
 */

export type Rule =
  | { type: "every"; ms: number }
  | { type: "daily"; h: number; m: number; days?: number[] } // days: 0=Sun…6=Sat
  | { type: "monthly"; day: number; h: number; m: number };

const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MIN_INTERVAL_MS = 5 * 60_000;

function hm(s: string): { h: number; m: number } | null {
  const t = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!t) return null;
  const h = Number(t[1]);
  const m = Number(t[2]);
  return h < 24 && m < 60 ? { h, m } : null;
}

export function parseRepeat(input: string | null | undefined): Rule | null {
  if (!input) return null;
  const s = input.trim().toLowerCase().replace(/\s+/g, " ");
  let x: RegExpExecArray | null;
  if ((x = /^every (\d+) ?(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/.exec(s))) {
    const n = Number(x[1]);
    const unit = x[2][0];
    const ms = n * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
    return ms >= MIN_INTERVAL_MS ? { type: "every", ms } : null;
  }
  if ((x = /^(daily|weekdays|weekends) (\d{1,2}:\d{2})$/.exec(s))) {
    const t = hm(x[2]);
    if (!t) return null;
    const days = x[1] === "weekdays" ? [1, 2, 3, 4, 5] : x[1] === "weekends" ? [0, 6] : undefined;
    return { type: "daily", ...t, days };
  }
  if ((x = /^weekly ([a-z,]+) (\d{1,2}:\d{2})$/.exec(s))) {
    const t = hm(x[2]);
    const days = x[1].split(",").map((d) => DOW[d.slice(0, 3)]);
    if (!t || days.some((d) => d === undefined)) return null;
    return { type: "daily", ...t, days };
  }
  if ((x = /^monthly (\d{1,2}) (\d{1,2}:\d{2})$/.exec(s))) {
    const t = hm(x[2]);
    const day = Number(x[1]);
    return t && day >= 1 && day <= 28 ? { type: "monthly", day, ...t } : null;
  }
  return null;
}

/** Wall-clock parts of an instant in a time zone. */
export function localParts(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) p[type] = value;
  return {
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    mi: Number(p.minute),
    s: Number(p.second),
    dow: DOW[p.weekday.toLowerCase().slice(0, 3)],
  };
}

/** The instant when the wall clock in `tz` reads y-mo-d h:mi. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  // Guess as if UTC, then correct by the zone's offset at that moment (twice,
  // to settle across a DST boundary).
  let t = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = localParts(t, tz);
    const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    t += Date.UTC(y, mo - 1, d, h, mi) - asUtc;
  }
  return t;
}

/** Next time the rule fires strictly after `after`. */
export function nextRun(rule: Rule, after: number, tz: string): number {
  if (rule.type === "every") return after + rule.ms;
  const p = localParts(after, tz);
  for (let add = 0; add <= 62; add++) {
    // Walk calendar days in local time (noon avoids DST edge cases).
    const day = localParts(zonedToUtc(p.y, p.mo, p.d, 12, 0, tz) + add * 86_400_000, tz);
    if (rule.type === "monthly" && day.d !== rule.day) continue;
    if (rule.type === "daily" && rule.days && !rule.days.includes(day.dow)) continue;
    const t = zonedToUtc(day.y, day.mo, day.d, rule.h, rule.m, tz);
    if (t > after) return t;
  }
  throw new Error("no next run found");
}

/**
 * "2026-11-16T18:00" (local, as the AI writes it) or a full ISO time with an
 * offset → epoch ms. Returns null if it can't be read.
 */
export function parseWhen(input: string | null | undefined, tz: string): number | null {
  if (!input) return null;
  const s = input.trim();
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  const x = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/.exec(s);
  if (!x) return null;
  return zonedToUtc(Number(x[1]), Number(x[2]), Number(x[3]), Number(x[4]), Number(x[5]), tz);
}

/** "Mon 16 Nov, 18:00" in the user's zone. */
export function formatLocal(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}
