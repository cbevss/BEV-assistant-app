import { describe, it, expect } from "vitest";
import { Store } from "../src/db";
import { testDb } from "./d1";

describe("Store", () => {
  it("adds, lists, updates and deletes tasks", async () => {
    const s = new Store(testDb());
    const t = await s.addTask({ kind: "reminder", title: "Call the dentist", next_run: 1000, urgent: 1 }, 1);
    expect(t).toMatchObject({ id: 1, kind: "reminder", status: "active", urgent: 1, runs_on: "cloud" });
    await s.addTask({ kind: "watch", title: "PS5 price", url: "https://x", repeat: "every 30m", next_run: 5000 }, 2);
    expect((await s.listTasks()).map((x) => x.title)).toEqual(["Call the dentist", "PS5 price"]);
    expect((await s.dueTasks(2000)).map((x) => x.id)).toEqual([1]);
    const u = await s.updateTask(1, { status: "done", last_result: "sent" }, 3);
    expect(u).toMatchObject({ status: "done", last_result: "sent", updated_at: 3 });
    expect((await s.dueTasks(9999)).map((x) => x.id)).toEqual([2]);
    expect(await s.deleteTask(2)).toBe(true);
    expect(await s.deleteTask(2)).toBe(false);
  });

  it("skips PC-only tasks in the cloud queue", async () => {
    const s = new Store(testDb());
    await s.addTask({ kind: "watch", title: "Download finished", runs_on: "pc", next_run: 1 });
    expect(await s.dueTasks(10)).toEqual([]);
  });

  it("keeps a short message thread and a key-value store", async () => {
    const s = new Store(testDb());
    for (let i = 0; i < 35; i++) await s.addMessage(i % 2 ? "assistant" : "user", `m${i}`);
    const recent = await s.recentMessages(3);
    expect(recent.map((m) => m.content)).toEqual(["m32", "m33", "m34"]);
    await s.set("owner", "42");
    await s.set("owner", "43");
    expect(await s.get("owner")).toBe("43");
    expect(await s.get("nope")).toBeNull();
  });
});
