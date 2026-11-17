import { describe, it, expect } from "vitest";
import { Store } from "../src/db";
import { TaskTools, htmlToText, safeUrl } from "../src/tools";
import { parseWhen } from "../src/schedule";
import { testDb } from "./d1";

const TZ = "Europe/London";
const NOW = parseWhen("2026-11-16T12:00", TZ)!;

function setup() {
  const store = new Store(testDb());
  return { store, tools: new TaskTools(store, TZ, () => NOW) };
}

describe("TaskTools", () => {
  it("adds a timed reminder in local time", async () => {
    const { store, tools } = setup();
    const r = await tools.run("add_task", { kind: "reminder", title: "Ring the garage", when: "2026-11-16T18:00", urgent: true });
    expect(r).toMatch(/Added: #1 \[reminder\] Ring the garage next Mon 16 Nov, 18:00 URGENT/);
    expect((await store.getTask(1))!.next_run).toBe(parseWhen("2026-11-16T18:00", TZ));
  });

  it("gives watches a default interval and a quick first check", async () => {
    const { store, tools } = setup();
    await tools.run("add_task", { kind: "watch", title: "PS5", url: "https://shop.example/ps5" });
    expect(await store.getTask(1)).toMatchObject({ repeat: "every 30m", next_run: NOW + 60_000 });
  });

  it("explains bad input so the model can fix it", async () => {
    const { tools } = setup();
    await expect(tools.run("add_task", { kind: "reminder", title: "x" })).rejects.toThrow(/needs a time/);
    await expect(tools.run("add_task", { kind: "reminder", title: "x", when: "2026-11-15T10:00" })).rejects.toThrow(/in the past/);
    await expect(tools.run("add_task", { kind: "reminder", title: "x", repeat: "now and then" })).rejects.toThrow(/repeat rule/);
    await expect(tools.run("add_task", { kind: "watch", title: "x" })).rejects.toThrow(/url/);
    await expect(tools.run("add_task", { kind: "watch", title: "x", url: "http://192.168.1.1/" })).rejects.toThrow(/Private/);
  });

  it("PC tasks aren't scheduled in the cloud", async () => {
    const { store, tools } = setup();
    await tools.run("add_task", { kind: "watch", title: "Download done", runs_on: "pc" });
    expect(await store.getTask(1)).toMatchObject({ runs_on: "pc", next_run: null });
  });

  it("reschedules, pauses, resumes and completes", async () => {
    const { store, tools } = setup();
    await tools.run("add_task", { kind: "briefing", title: "Morning", repeat: "daily 08:00" });
    expect((await store.getTask(1))!.next_run).toBe(parseWhen("2026-11-17T08:00", TZ));
    await tools.run("update_task", { id: 1, repeat: "weekdays 07:30" });
    expect((await store.getTask(1))!.next_run).toBe(parseWhen("2026-11-17T07:30", TZ));
    await tools.run("update_task", { id: 1, status: "paused" });
    expect(await tools.run("list_tasks", {})).toBe("No tasks yet.");
    await tools.run("update_task", { id: 1, status: "active" });
    expect((await store.getTask(1))!.status).toBe("active");
    expect(await tools.run("complete_task", { id: 1 })).toBe("Done: Morning");
    await expect(tools.run("delete_task", { id: 9 })).rejects.toThrow(/no task #9/);
  });
});

describe("web helpers", () => {
  it("turns HTML into text", () => {
    expect(htmlToText("<html><style>x{}</style><h1>PS5 &amp; more</h1><p>Now &pound;399</p><script>bad()</script></html>")).toBe("PS5 & more\nNow £399");
  });
  it("blocks private and non-http addresses", () => {
    for (const u of ["file:///etc/passwd", "http://localhost:8080", "http://10.0.0.1", "http://[::1]/", "ftp://x.com"]) expect(() => safeUrl(u)).toThrow();
    expect(safeUrl("https://www.argos.co.uk/x").hostname).toBe("www.argos.co.uk");
  });
});
