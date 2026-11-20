/**
 * "What did I do today?": a recap from what BEV saw on this PC: what you
 * asked it, background tasks, games played, AI spend, BEV's notices and
 * what's still coming up. Facts only; the AI turns it into a few sentences.
 */
import { invoke } from "@tauri-apps/api/core";
import { native } from "./native";
import { allSessions, totalsSince, startOfDay } from "./playtime";
import { useUsage, totals as usageTotals, dayKey, formatUsd } from "@/ai/usage";
import { useNotices } from "@/proactive/notices";
import { useTimers, clockTime, formatDuration } from "./timers";

interface ConvSession {
  session: string;
  started: number;
  first: string;
  count: number;
}

/** Seconds or milliseconds → milliseconds. */
const ms = (t: number) => (t < 1e12 ? t * 1000 : t);

export async function recap(day: "today" | "yesterday", now = Date.now()): Promise<string> {
  const from = startOfDay(now) - (day === "yesterday" ? 86_400_000 : 0);
  const to = from + 86_400_000;
  const inDay = (t: number) => t >= from && t < to;
  const parts: string[] = [];

  const convs = await invoke<ConvSession[]>("conv_sessions", { limit: 60 }).catch(() => [] as ConvSession[]);
  const asked = convs.filter((c) => inDay(ms(c.started)));
  if (asked.length) parts.push(`Conversations with BEV (${asked.length}), starting with: ${asked.slice(0, 12).map((c) => `[${clockTime(ms(c.started))}] "${c.first.slice(0, 90)}"`).join("; ")}`);

  const runs = await native.journalRecent(40).catch(() => []);
  const tasks = runs.filter((r) => inDay(ms(r.started_at)));
  if (tasks.length) parts.push(`Background tasks: ${tasks.map((t) => `"${t.request.slice(0, 80)}" (${t.status})`).join("; ")}`);

  const games = totalsSince(allSessions(now).filter((s) => s.start < to).map((s) => ({ ...s, end: Math.min(s.end, to) })), from);
  if (games.length) parts.push(`Gaming: ${formatDuration(games.reduce((n, g) => n + g.ms, 0))} (${games.map((g) => `${g.game} ${formatDuration(g.ms)}`).join(", ")})`);

  await useUsage.getState().load();
  const u = usageTotals(useUsage.getState().days, dayKey(from), dayKey(from));
  if (u.requests) parts.push(`AI use: ${u.requests} requests, about ${formatUsd(u.cost)}`);

  const notices = useNotices.getState().items.filter((n) => inDay(n.at));
  if (notices.length) parts.push(`BEV noticed: ${notices.slice(0, 8).map((n) => n.title).join("; ")}`);

  if (day === "today") {
    const coming = useTimers.getState().timers.filter((t) => t.due < to);
    if (coming.length) parts.push(`Still to come today: ${coming.map((t) => `${t.label || t.kind} at ${clockTime(t.due)}`).join("; ")}`);
  }

  return parts.length ? `${day === "today" ? "Today" : "Yesterday"} on this PC:\n${parts.join("\n")}` : `BEV has nothing recorded for ${day} on this PC.`;
}
