// Minimal D1 stand-in on Node's built-in SQLite, for tests.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private args: unknown[] = []) {}
  bind(...args: unknown[]) {
    return new Stmt(this.db, this.sql, args);
  }
  private s() {
    return this.db.prepare(this.sql);
  }
  async first<T>() {
    return ((this.s().get(...(this.args as never[])) as T) ?? null) as T | null;
  }
  async all<T>() {
    return { results: this.s().all(...(this.args as never[])) as T[] };
  }
  async run() {
    const r = this.s().run(...(this.args as never[]));
    return { meta: { changes: Number(r.changes) } };
  }
}

export function testDb(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return { prepare: (sql: string) => new Stmt(db, sql) } as unknown as D1Database;
}
