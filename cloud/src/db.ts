/** Task, message, event and key-value storage on D1 (SQLite). */

export interface Task {
  id: number;
  kind: "reminder" | "watch" | "check" | "briefing";
  title: string;
  instructions: string;
  url: string | null;
  repeat: string | null;
  next_run: number | null;
  urgent: number;
  status: "active" | "done" | "paused";
  runs_on: "cloud" | "pc";
  last_run: number | null;
  last_result: string | null;
  snapshot_hash: string | null;
  snapshot: string | null;
  created_at: number;
  updated_at: number;
}

export type NewTask = Pick<Task, "kind" | "title"> &
  Partial<Pick<Task, "instructions" | "url" | "repeat" | "next_run" | "urgent" | "runs_on">>;

const EDITABLE = [
  "kind",
  "title",
  "instructions",
  "url",
  "repeat",
  "next_run",
  "urgent",
  "status",
  "runs_on",
  "last_run",
  "last_result",
  "snapshot_hash",
  "snapshot",
] as const;
export type TaskPatch = Partial<Pick<Task, (typeof EDITABLE)[number]>>;

export class Store {
  constructor(private db: D1Database) {}

  async addTask(t: NewTask, now = Date.now()): Promise<Task> {
    const row = await this.db
      .prepare(
        `INSERT INTO tasks (kind, title, instructions, url, repeat, next_run, urgent, runs_on, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
      )
      .bind(
        t.kind,
        t.title,
        t.instructions ?? "",
        t.url ?? null,
        t.repeat ?? null,
        t.next_run ?? null,
        t.urgent ? 1 : 0,
        t.runs_on ?? "cloud",
        now,
        now
      )
      .first<Task>();
    if (!row) throw new Error("task insert failed");
    return row;
  }

  getTask(id: number) {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<Task>();
  }

  async listTasks(status: Task["status"] | "all" = "active"): Promise<Task[]> {
    const q =
      status === "all"
        ? this.db.prepare("SELECT * FROM tasks ORDER BY status, COALESCE(next_run, 9e15), id")
        : this.db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY COALESCE(next_run, 9e15), id").bind(status);
    return (await q.all<Task>()).results;
  }

  async updateTask(id: number, patch: TaskPatch, now = Date.now()): Promise<Task | null> {
    const keys = EDITABLE.filter((k) => k in patch);
    if (!keys.length) return this.getTask(id);
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const vals = keys.map((k) => (patch as Record<string, unknown>)[k] ?? null);
    return this.db
      .prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ? RETURNING *`)
      .bind(...vals, now, id)
      .first<Task>();
  }

  async deleteTask(id: number): Promise<boolean> {
    const r = await this.db.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
    return (r.meta?.changes ?? 0) > 0;
  }

  /** Active cloud tasks whose time has come. */
  async dueTasks(now: number, limit = 10): Promise<Task[]> {
    return (
      await this.db
        .prepare(
          "SELECT * FROM tasks WHERE status = 'active' AND runs_on = 'cloud' AND next_run IS NOT NULL AND next_run <= ? ORDER BY next_run LIMIT ?"
        )
        .bind(now, limit)
        .all<Task>()
    ).results;
  }

  async addMessage(role: "user" | "assistant", content: string, now = Date.now()) {
    await this.db.prepare("INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)").bind(role, content, now).run();
    // Keep the thread short.
    await this.db
      .prepare("DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 30)")
      .run();
  }

  async recentMessages(limit = 16): Promise<{ role: "user" | "assistant"; content: string }[]> {
    const rows = (
      await this.db.prepare("SELECT role, content FROM messages ORDER BY id DESC LIMIT ?").bind(limit).all<{
        role: "user" | "assistant";
        content: string;
      }>()
    ).results;
    return rows.reverse();
  }

  clearMessages() {
    return this.db.prepare("DELETE FROM messages").run();
  }

  async addEvent(text: string, taskId: number | null, urgent: boolean, now = Date.now()) {
    await this.db
      .prepare("INSERT INTO events (task_id, text, urgent, created_at) VALUES (?, ?, ?, ?)")
      .bind(taskId, text, urgent ? 1 : 0, now)
      .run();
    await this.db.prepare("DELETE FROM events WHERE created_at < ?").bind(now - 30 * 86_400_000).run();
  }

  async eventsSince(since: number): Promise<{ text: string; urgent: number; created_at: number }[]> {
    return (
      await this.db
        .prepare("SELECT text, urgent, created_at FROM events WHERE created_at >= ? ORDER BY id")
        .bind(since)
        .all<{ text: string; urgent: number; created_at: number }>()
    ).results;
  }

  async get(key: string): Promise<string | null> {
    const r = await this.db.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first<{ value: string }>();
    return r?.value ?? null;
  }

  async set(key: string, value: string) {
    await this.db
      .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(key, value)
      .run();
  }
}
