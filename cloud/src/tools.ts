/**
 * Task tools, shared by the Telegram chat, scheduled checks and phone calls,
 * so BEV can manage the same list however you talk to it.
 */
import type { ToolSpec } from "./ai";
import type { Store, Task, TaskPatch } from "./db";
import { formatLocal, nextRun, parseRepeat, parseWhen } from "./schedule";

const DEFAULT_REPEAT: Partial<Record<Task["kind"], string>> = { watch: "every 30m", check: "every 1h" };

export const TASK_TOOLS: ToolSpec[] = [
  {
    name: "add_task",
    description:
      "Start tracking something for the user. kind: reminder (tell them at a time), watch (monitor a web page for a change, e.g. a price or stock), check (a recurring job you do with your own judgement, e.g. 'check BBC for news about X and tell me if anything big'), briefing (a scheduled summary of their tasks and recent reports). Times are in the user's local time zone. Set urgent=true only if they'd want a phone call for it. Use runs_on='pc' for things only their PC can see (files, downloads, games, PC temperatures).",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["reminder", "watch", "check", "briefing"] },
        title: { type: "string", description: "Short name, e.g. 'PS5 price at Argos'" },
        instructions: {
          type: "string",
          description: "What to do or look for, in detail (e.g. 'tell me if it drops under £400').",
        },
        when: { type: "string", description: "First/only time, local, as YYYY-MM-DDTHH:MM" },
        repeat: {
          type: "string",
          description:
            "How often: 'every 30m', 'every 2h', 'daily 08:00', 'weekdays 08:00', 'weekly mon,thu 18:30', 'monthly 1 09:00'. Omit for once.",
        },
        url: { type: "string", description: "Page to watch (watch tasks)" },
        urgent: { type: "boolean" },
        runs_on: { type: "string", enum: ["cloud", "pc"] },
      },
      required: ["kind", "title"],
    },
  },
  {
    name: "list_tasks",
    description: "List what you're tracking for the user, with ids, times and last results.",
    parameters: { type: "object", properties: { include_done: { type: "boolean" } } },
  },
  {
    name: "update_task",
    description: "Change a task: reschedule it, change what to look for, pause/resume it, mark urgent.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "integer" },
        title: { type: "string" },
        instructions: { type: "string" },
        when: { type: "string", description: "New time, local YYYY-MM-DDTHH:MM" },
        repeat: { type: "string", description: "New repeat rule, or 'none' for once" },
        url: { type: "string" },
        urgent: { type: "boolean" },
        status: { type: "string", enum: ["active", "paused", "done"] },
      },
      required: ["id"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a task done (it stops running).",
    parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
  },
  {
    name: "delete_task",
    description: "Delete a task completely.",
    parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
  },
  {
    name: "recent_reports",
    description: "What you've reported to the user recently (watch hits, check results, reminders sent).",
    parameters: { type: "object", properties: { hours: { type: "integer", description: "Default 24" } } },
  },
];

export const WEB_TOOL: ToolSpec = {
  name: "read_webpage",
  description: "Fetch a public web page and return its text, to check prices, news, stock and so on.",
  parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
};

export function describeTask(t: Task, tz: string): string {
  const bits = [`#${t.id} [${t.kind}${t.runs_on === "pc" ? ", PC" : ""}] ${t.title}`];
  if (t.status !== "active") bits.push(`(${t.status})`);
  if (t.next_run && t.status === "active") bits.push(`next ${formatLocal(t.next_run, tz)}`);
  if (t.repeat) bits.push(`repeats ${t.repeat}`);
  if (t.urgent) bits.push("URGENT (calls)");
  if (t.url) bits.push(t.url);
  if (t.instructions) bits.push(`— ${t.instructions}`);
  if (t.last_result) bits.push(`| last: ${t.last_result.slice(0, 160)}`);
  return bits.join(" ");
}

/** Validate a URL for fetching: public http(s) only. */
export function safeUrl(input: string): URL {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new Error("That isn't a valid web address.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only http(s) pages can be read.");
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.startsWith("[")) {
    throw new Error("Private network addresses can't be read.");
  }
  return u;
}

/** HTML → readable text (good enough for prices, headlines, stock messages). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&pound;/g, "£")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export async function readWebpage(url: string, fetcher: typeof fetch = fetch, maxChars = 12_000): Promise<string> {
  const u = safeUrl(url);
  const res = await fetcher(u.toString(), {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 BEV/1.0",
      accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`The page answered ${res.status}.`);
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  const text = /html|xml/i.test(type) || /^\s*</.test(body) ? htmlToText(body) : body;
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(cut)` : text;
}

export class TaskTools {
  constructor(
    private store: Store,
    private tz: string,
    private now: () => number = Date.now,
    private fetcher: typeof fetch = fetch
  ) {}

  private schedule(kind: Task["kind"], when?: unknown, repeat?: unknown): { next_run: number | null; repeat: string | null } {
    const now = this.now();
    const rep = typeof repeat === "string" && repeat.trim() && repeat.trim().toLowerCase() !== "none" ? repeat.trim() : null;
    const rule = rep ? parseRepeat(rep) : null;
    if (rep && !rule) {
      throw new Error(
        `I can't use the repeat rule "${rep}". Use one of: every 30m, every 2h, daily 08:00, weekdays 08:00, weekly mon,thu 18:30, monthly 1 09:00 (minimum every 5 minutes).`
      );
    }
    if (typeof when === "string" && when.trim()) {
      const t = parseWhen(when, this.tz);
      if (t === null) throw new Error(`I can't read the time "${when}". Use YYYY-MM-DDTHH:MM.`);
      if (t < now - 60_000) throw new Error(`${formatLocal(t, this.tz)} is in the past.`);
      return { next_run: t, repeat: rep };
    }
    if (rule) {
      // Watches/checks start straight away (a baseline); timed rules wait.
      return { next_run: rule.type === "every" ? now + 60_000 : nextRun(rule, now, this.tz), repeat: rep };
    }
    const fallback = DEFAULT_REPEAT[kind];
    if (fallback) return { next_run: now + 60_000, repeat: fallback };
    throw new Error("A reminder or briefing needs a time (when) or a repeat rule.");
  }

  async run(name: string, a: Record<string, unknown>): Promise<string> {
    const s = this.store;
    switch (name) {
      case "add_task": {
        const kind = a.kind as Task["kind"];
        if (!["reminder", "watch", "check", "briefing"].includes(kind)) throw new Error("kind must be reminder, watch, check or briefing.");
        const title = String(a.title ?? "").trim();
        if (!title) throw new Error("A task needs a title.");
        const url = typeof a.url === "string" && a.url.trim() ? safeUrl(a.url.trim()).toString() : null;
        const runs_on = a.runs_on === "pc" ? "pc" : "cloud";
        if (kind === "watch" && runs_on === "cloud" && !url) throw new Error("A watch needs the page's url.");
        const when = runs_on === "pc" ? { next_run: null, repeat: typeof a.repeat === "string" ? a.repeat : null } : this.schedule(kind, a.when, a.repeat);
        const t = await s.addTask(
          {
            kind,
            title,
            instructions: typeof a.instructions === "string" ? a.instructions : "",
            url,
            urgent: a.urgent === true ? 1 : 0,
            runs_on,
            ...when,
          },
          this.now()
        );
        return `Added: ${describeTask(t, this.tz)}`;
      }
      case "list_tasks": {
        const list = await s.listTasks(a.include_done ? "all" : "active");
        return list.length ? list.map((t) => describeTask(t, this.tz)).join("\n") : "No tasks yet.";
      }
      case "update_task": {
        const id = Number(a.id);
        const t = await s.getTask(id);
        if (!t) throw new Error(`There's no task #${a.id}.`);
        const patch: TaskPatch = {};
        if (typeof a.title === "string") patch.title = a.title;
        if (typeof a.instructions === "string") patch.instructions = a.instructions;
        if (typeof a.url === "string") patch.url = a.url ? safeUrl(a.url).toString() : null;
        if (typeof a.urgent === "boolean") patch.urgent = a.urgent ? 1 : 0;
        if (a.when !== undefined || a.repeat !== undefined) {
          Object.assign(patch, this.schedule(t.kind, a.when, a.repeat === undefined ? t.repeat : a.repeat));
        }
        if (a.status === "active" || a.status === "paused" || a.status === "done") {
          patch.status = a.status;
          // Resuming something whose time has passed: run it on its rule again.
          if (a.status === "active" && !patch.next_run && (!t.next_run || t.next_run < this.now())) {
            const rule = parseRepeat(patch.repeat ?? t.repeat);
            patch.next_run = rule ? nextRun(rule, this.now(), this.tz) : null;
          }
        }
        const u = await s.updateTask(id, patch, this.now());
        return `Updated: ${describeTask(u!, this.tz)}`;
      }
      case "complete_task": {
        const u = await s.updateTask(Number(a.id), { status: "done" }, this.now());
        if (!u) throw new Error(`There's no task #${a.id}.`);
        return `Done: ${u.title}`;
      }
      case "delete_task":
        if (!(await s.deleteTask(Number(a.id)))) throw new Error(`There's no task #${a.id}.`);
        return `Deleted task #${a.id}.`;
      case "recent_reports": {
        const hours = Math.min(Math.max(Number(a.hours) || 24, 1), 24 * 30);
        const ev = await s.eventsSince(this.now() - hours * 3_600_000);
        return ev.length
          ? ev.map((e) => `${formatLocal(e.created_at, this.tz)}${e.urgent ? " (urgent)" : ""}: ${e.text}`).join("\n")
          : `Nothing reported in the last ${hours} hours.`;
      }
      case "read_webpage":
        return readWebpage(String(a.url ?? ""), this.fetcher);
      default:
        throw new Error(`Unknown tool ${name}.`);
    }
  }
}
