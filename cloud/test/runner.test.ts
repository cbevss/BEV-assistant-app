import { describe, it, expect } from "vitest";
import { Store } from "../src/db";
import { Runner, parseVerdict, lineDiff } from "../src/runner";
import { parseWhen } from "../src/schedule";
import { setupPhone } from "../src/phone";
import { fakeFetch, scriptedChat, testEnv, withCalls } from "./fakes";

const TZ = "Europe/London";
const T0 = parseWhen("2026-11-16T12:00", TZ)!;

async function ready(extra = {}) {
  const env = testEnv(extra);
  const store = new Store(env.DB);
  await store.set("owner_chat", "42");
  return { env, store };
}

const tgTexts = (sent: { url: string; body: unknown }[]) =>
  sent.filter((s) => s.url.endsWith("/sendMessage")).map((s) => (s.body as { text: string }).text);

describe("verdict parsing", () => {
  it("reads JSON wrapped in chatter", () => {
    expect(parseVerdict('Sure!\n```json\n{"notify": true, "urgent": false, "headline": "Price dropped", "message": "Now £399"}\n```')).toEqual({
      notify: true,
      urgent: false,
      headline: "Price dropped",
      message: "Now £399",
    });
    expect(parseVerdict("no json here")).toBeNull();
  });
  it("diffs page lines", () => {
    expect(lineDiff("a\nb\nc", "a\nc\nd")).toEqual({ added: "d", removed: "b" });
  });
});

describe("Runner", () => {
  it("fires an urgent one-off reminder: message, voice note, call, then done", async () => {
    const { env, store } = await ready(withCalls);
    const f = fakeFetch();
    await setupPhone(env, store, "https://bev.example", f.fn);
    await store.addTask({ kind: "reminder", title: "Leave for the airport", urgent: 1, next_run: T0 - 1000 });
    const ran = await new Runner(env, store, { fetcher: f.fn, now: T0, chat: scriptedChat([]).chat }).runDue();
    expect(ran).toBe(1);
    const call = f.sent.find((s) => s.url.endsWith("/outbound-call"))!.body as Record<string, any>;
    expect(call.to_number).toBe("+447111111111");
    expect(call.conversation_initiation_client_data.dynamic_variables.opening).toBe("Hey, it's BEV. Reminder: Leave for the airport.");
    expect(tgTexts(f.sent)[0]).toMatch(/🚨 ⏰ Leave for the airport[\s\S]*Calling you/);
    expect(f.sent.some((s) => s.url.endsWith("/sendVoice"))).toBe(true);
    expect(await store.getTask(1)).toMatchObject({ status: "done", next_run: null, last_result: "reminded" });
  });

  it("repeating reminder is rescheduled, non-urgent one doesn't call", async () => {
    const { env, store } = await ready(withCalls);
    const f = fakeFetch();
    await store.addTask({ kind: "reminder", title: "Bins out", repeat: "weekly mon 19:00", next_run: T0 - 1 });
    await new Runner(env, store, { fetcher: f.fn, now: T0, chat: scriptedChat([]).chat }).runDue();
    expect(f.sent.some((s) => s.url.includes("outbound-call"))).toBe(false);
    expect((await store.getTask(1))!.next_run).toBe(parseWhen("2026-11-16T19:00", TZ));
  });

  it("watch: baseline, quiet when unchanged, reports a relevant change", async () => {
    const { env, store } = await ready();
    const url = "https://shop.example/ps5";
    const f = fakeFetch({ [url]: "<h1>PS5</h1><p>£479.99</p><p>In stock</p>" });
    await store.addTask({ kind: "watch", title: "PS5 price", url, instructions: "tell me under £400", repeat: "every 30m", next_run: T0 });
    const ai = scriptedChat([
      (req) => {
        expect(req.messages[0].role === "user" && req.messages[0].content).toMatch(/appeared:\n£389\.99/);
        return { text: '{"notify": true, "urgent": false, "headline": "The PS5 is down to £389.99.", "message": "Down to £389.99 from £479.99."}' };
      },
    ]);
    const run = (now: number) => new Runner(env, store, { fetcher: f.fn, now, chat: ai.chat }).runDue();

    await run(T0);
    expect((await store.getTask(1))!.last_result).toBe("baseline saved");
    await run(T0 + 1_800_000);
    expect((await store.getTask(1))!.last_result).toBe("no change");
    expect(ai.calls).toHaveLength(0);

    f.pages[url] = "<h1>PS5</h1><p>£389.99</p><p>In stock</p>";
    await run(T0 + 3_600_000);
    expect(ai.calls).toHaveLength(1);
    expect(tgTexts(f.sent).at(-1)).toMatch(/👀 PS5 price: Down to £389\.99/);
    expect((await store.getTask(1))!.next_run).toBe(T0 + 3_600_000 + 1_800_000);
  });

  it("check: uses the web tool, stays quiet when nothing new", async () => {
    const { env, store } = await ready();
    const f = fakeFetch({ "https://news.example/": "<p>No strike news today</p>" });
    await store.addTask({ kind: "check", title: "Strike news", instructions: "check news.example for train strikes", repeat: "every 1h", next_run: T0 });
    const ai = scriptedChat([
      { toolCalls: [{ id: "t1", name: "read_webpage", args: { url: "https://news.example/" } }] },
      (req) => {
        const last = req.messages.at(-1)!;
        expect(last.role === "tool" && last.content).toBe("No strike news today");
        return { text: '{"notify": false, "urgent": false, "headline": "", "message": "Nothing new on strikes."}' };
      },
    ]);
    await new Runner(env, store, { fetcher: f.fn, now: T0, chat: ai.chat }).runDue();
    expect(tgTexts(f.sent)).toEqual([]);
    expect((await store.getTask(1))!.last_result).toBe("nothing new: Nothing new on strikes.");
  });

  it("briefing summarises reports and tasks", async () => {
    const { env, store } = await ready();
    const f = fakeFetch();
    await store.addEvent("PS5 dropped to £389", null, false, T0 - 3_600_000);
    await store.addTask({ kind: "briefing", title: "Morning briefing", repeat: "daily 08:00", next_run: T0, last_run: undefined } as never);
    const ai = scriptedChat([
      (req) => {
        expect(req.messages[0].role === "user" && req.messages[0].content).toMatch(/PS5 dropped to £389/);
        return { text: "Morning. The PS5 dropped to £389 overnight. Nothing else pressing. Have a good one." };
      },
    ]);
    await new Runner(env, store, { fetcher: f.fn, now: T0, chat: ai.chat }).runDue();
    expect(tgTexts(f.sent)[0]).toMatch(/☀️ Morning\. The PS5 dropped/);
  });

  it("tells the user once when a task starts failing", async () => {
    const { env, store } = await ready();
    const f = fakeFetch();
    await store.addTask({ kind: "watch", title: "Dead page", url: "https://gone.example/", repeat: "every 30m", next_run: T0 });
    const r = (now: number) => new Runner(env, store, { fetcher: f.fn, now, chat: scriptedChat([]).chat }).runDue();
    await r(T0);
    await r(T0 + 1_800_000);
    const texts = tgTexts(f.sent);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/couldn't run "Dead page": The page answered 404/);
    expect((await store.getTask(1))!.status).toBe("active");
  });

  it("doesn't call twice within 10 minutes", async () => {
    const { env, store } = await ready(withCalls);
    const f = fakeFetch();
    await setupPhone(env, store, "https://bev.example", f.fn);
    await store.addTask({ kind: "reminder", title: "One", urgent: 1, next_run: T0 });
    await store.addTask({ kind: "reminder", title: "Two", urgent: 1, next_run: T0 });
    await new Runner(env, store, { fetcher: f.fn, now: T0, chat: scriptedChat([]).chat }).runDue();
    expect(f.sent.filter((s) => s.url.endsWith("/outbound-call"))).toHaveLength(1);
    expect(tgTexts(f.sent)[1]).toMatch(/no call: called less than 10 minutes ago/);
  });
});
