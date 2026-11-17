/**
 * The every-minute job: run due tasks, report what matters, reschedule.
 *
 * Watches only bother the AI when the page text actually changed, so a quiet
 * page costs nothing but a fetch.
 */
import type { Env } from "./env";
import type { Store, Task } from "./db";
import { chatFor, runAgent, type Chat, type Msg } from "./ai";
import { TaskTools, WEB_TOOL, describeTask, readWebpage } from "./tools";
import { formatLocal, nextRun, parseRepeat } from "./schedule";
import { report, type Deps } from "./report";
import { sha256Hex } from "./telegram";

/** Free Workers plans get little CPU per run: a few tasks a minute is plenty. */
const PER_RUN = 3;
const SNAPSHOT_CHARS = 8000;

export interface Verdict {
  notify: boolean;
  urgent: boolean;
  headline: string;
  message: string;
}

/** Pull the JSON verdict out of a model reply (tolerates code fences / chatter). */
export function parseVerdict(text: string): Verdict | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]) as Partial<Verdict>;
    if (typeof v.notify !== "boolean") return null;
    return {
      notify: v.notify,
      urgent: v.urgent === true,
      headline: String(v.headline ?? v.message ?? "").slice(0, 200),
      message: String(v.message ?? v.headline ?? ""),
    };
  } catch {
    return null;
  }
}

const VERDICT_RULES = `Answer ONLY with JSON: {"notify": true|false, "urgent": true|false, "headline": "one short spoken sentence", "message": "the update for the user, a few plain sentences"}.
notify=false if nothing worth their attention happened. urgent=true only if it matches what they asked to be called about, or waiting would cost them (a deal ending soon, something broken, a deadline missed).`;

/** Lines in `b` that weren't in `a` (and vice versa): what changed on the page. */
export function lineDiff(a: string, b: string, max = 3000): { added: string; removed: string } {
  const A = new Set(a.split("\n").map((l) => l.trim()).filter(Boolean));
  const B = new Set(b.split("\n").map((l) => l.trim()).filter(Boolean));
  const added = [...B].filter((l) => !A.has(l)).join("\n");
  const removed = [...A].filter((l) => !B.has(l)).join("\n");
  return { added: added.slice(0, max), removed: removed.slice(0, max) };
}

export class Runner {
  private chat: Chat;
  private fetcher: typeof fetch;
  constructor(
    private env: Env,
    private store: Store,
    private deps: Deps & { chat?: Chat } = {}
  ) {
    this.fetcher = deps.fetcher ?? fetch;
    this.chat = deps.chat ?? chatFor(env, this.fetcher);
  }

  private get now() {
    return this.deps.now ?? Date.now();
  }

  async runDue(): Promise<number> {
    const due = await this.store.dueTasks(this.now, PER_RUN);
    for (const t of due) await this.runOne(t);
    return due.length;
  }

  async runOne(t: Task): Promise<void> {
    const tz = this.env.TIMEZONE;
    let result: string;
    try {
      result = await this.execute(t);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Tell the user the first time a task starts failing, not every run.
      if (!t.last_result?.startsWith("Error")) {
        await report(this.env, this.store, {
          headline: `I couldn't run "${t.title}".`,
          text: `⚠️ I couldn't run "${t.title}": ${msg.slice(0, 300)}. I'll keep trying${t.repeat ? ` (${t.repeat})` : ""}.`,
          urgent: false,
          taskId: t.id,
        }, this.deps).catch(() => {});
      }
      result = `Error: ${msg.slice(0, 300)}`;
    }
    const rule = parseRepeat(t.repeat);
    const next = rule ? nextRun(rule, this.now, tz) : null;
    await this.store.updateTask(
      t.id,
      {
        last_run: this.now,
        last_result: result.slice(0, 1000),
        next_run: next,
        ...(next ? {} : { status: "done" as const }),
      },
      this.now
    );
  }

  private async execute(t: Task): Promise<string> {
    switch (t.kind) {
      case "reminder":
        await report(this.env, this.store, {
          headline: `Reminder: ${t.title}.`,
          text: `⏰ ${t.title}${t.instructions ? `\n${t.instructions}` : ""}`,
          urgent: t.urgent === 1,
          taskId: t.id,
        }, this.deps);
        return "reminded";
      case "watch":
        return this.watch(t);
      case "check":
        return this.check(t);
      case "briefing":
        return this.briefing(t);
    }
  }

  private async watch(t: Task): Promise<string> {
    if (!t.url) throw new Error("no url to watch");
    const text = await readWebpage(t.url, this.fetcher, SNAPSHOT_CHARS * 4);
    const hash = await sha256Hex(text);
    if (!t.snapshot_hash) {
      await this.store.updateTask(t.id, { snapshot_hash: hash, snapshot: text.slice(0, SNAPSHOT_CHARS) }, this.now);
      return "baseline saved";
    }
    if (hash === t.snapshot_hash) return "no change";

    const diff = lineDiff(t.snapshot ?? "", text);
    const r = await this.chat({
      system: `You monitor a web page for the user. ${VERDICT_RULES}`,
      messages: [
        {
          role: "user",
          content: `Watch: ${t.title}\nURL: ${t.url}\nWhat the user wants to know: ${t.instructions || "any meaningful change"}\nThey asked for a call if urgent: ${t.urgent ? "yes" : "no"}\n\nText that appeared:\n${diff.added || "(none)"}\n\nText that disappeared:\n${diff.removed || "(none)"}\n\nCurrent page (start):\n${text.slice(0, 2500)}`,
        },
      ],
      tools: [],
      maxTokens: 400,
    });
    await this.store.updateTask(t.id, { snapshot_hash: hash, snapshot: text.slice(0, SNAPSHOT_CHARS) }, this.now);
    const v = parseVerdict(r.text);
    if (!v) return "changed (couldn't judge)";
    if (!v.notify) return "changed, nothing relevant";
    await report(this.env, this.store, {
      headline: v.headline,
      text: `👀 ${t.title}: ${v.message}\n${t.url}`,
      urgent: v.urgent && t.urgent === 1,
      taskId: t.id,
    }, this.deps);
    return `reported: ${v.headline}`;
  }

  private async check(t: Task): Promise<string> {
    const tools = new TaskTools(this.store, this.env.TIMEZONE, () => this.now, this.fetcher);
    const messages: Msg[] = [
      {
        role: "user",
        content: `Scheduled check: ${t.title}\nInstructions: ${t.instructions || t.title}\n${t.url ? `Start from: ${t.url}\n` : ""}Last result: ${t.last_result ?? "(first run)"}\nThey asked for a call if urgent: ${t.urgent ? "yes" : "no"}\nCurrent time: ${formatLocal(this.now, this.env.TIMEZONE)}\n\nDo the check with your tools, then give your verdict. Don't repeat news you already reported (see last result).`,
      },
    ];
    const answer = await runAgent(
      this.chat,
      `You are BEV doing a scheduled job for the user. Use read_webpage to look things up. ${VERDICT_RULES}`,
      messages,
      [WEB_TOOL],
      (n, a) => tools.run(n, a),
      5
    );
    const v = parseVerdict(answer);
    if (!v) return answer.slice(0, 300) || "no verdict";
    if (!v.notify) return `nothing new: ${v.message.slice(0, 200)}`;
    await report(this.env, this.store, {
      headline: v.headline,
      text: `🔎 ${t.title}: ${v.message}`,
      urgent: v.urgent && t.urgent === 1,
      taskId: t.id,
    }, this.deps);
    return `reported: ${v.message.slice(0, 300)}`;
  }

  private async briefing(t: Task): Promise<string> {
    const tz = this.env.TIMEZONE;
    const since = t.last_run ?? this.now - 86_400_000;
    const [tasks, events] = await Promise.all([this.store.listTasks(), this.store.eventsSince(since)]);
    const r = await this.chat({
      system:
        "You are BEV, the user's AI assistant. Write a short spoken-style briefing (under 120 words, no lists or markdown): anything important first, then what's coming up today, then a one-line sign-off.",
      messages: [
        {
          role: "user",
          content: `Briefing: ${t.title}${t.instructions ? ` (${t.instructions})` : ""}\nNow: ${formatLocal(this.now, tz)}\n\nReports since last briefing:\n${events.map((e) => `- ${formatLocal(e.created_at, tz)}: ${e.text}`).join("\n") || "none"}\n\nTasks:\n${tasks.map((x) => describeTask(x, tz)).join("\n") || "none"}`,
        },
      ],
      tools: [],
      maxTokens: 400,
    });
    const text = r.text.trim() || "Nothing to report.";
    await report(this.env, this.store, { headline: t.title, text: `☀️ ${text}`, urgent: false, taskId: t.id }, this.deps);
    return "briefing sent";
  }
}

