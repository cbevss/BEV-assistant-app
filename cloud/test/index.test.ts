import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";
import { Store } from "../src/db";
import { pairingCode, webhookSecret } from "../src/telegram";
import { phoneToolKey, setupPhone, webhookToolConfig, agentConfig } from "../src/phone";
import { fakeFetch, testEnv, withCalls } from "./fakes";

function ctx() {
  const waits: Promise<unknown>[] = [];
  return { c: { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext, done: () => Promise.all(waits) };
}

afterEach(() => vi.unstubAllGlobals());

async function tgPost(env: ReturnType<typeof testEnv>, message: unknown, secret?: string) {
  const { c, done } = ctx();
  const res = await worker.fetch(
    new Request("https://bev.example/tg", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": secret ?? (await webhookSecret(env)) },
      body: JSON.stringify({ message }),
    }),
    env,
    c
  );
  await done();
  return res;
}

const texts = (sent: { url: string; body: unknown }[]) =>
  sent.filter((s) => s.url.endsWith("/sendMessage")).map((s) => [(s.body as any).chat_id, (s.body as any).text]);

describe("Telegram webhook", () => {
  it("rejects calls without the secret", async () => {
    const env = testEnv();
    expect((await tgPost(env, { chat: { id: 1, type: "private" }, text: "hi" }, "wrong")).status).toBe(403);
  });

  it("pairs only with the right code, then ignores everyone else", async () => {
    const env = testEnv();
    const f = fakeFetch();
    vi.stubGlobal("fetch", f.fn);
    const store = new Store(env.DB);

    await tgPost(env, { chat: { id: 7, type: "private" }, text: "/start WRONGCODE" });
    expect(await store.get("owner_chat")).toBeNull();
    await tgPost(env, { chat: { id: 42, type: "private" }, text: `/start ${await pairingCode(env)}` });
    expect(await store.get("owner_chat")).toBe("42");
    expect(texts(f.sent).at(-1)![1]).toMatch(/^Linked\./);

    const before = f.sent.length;
    await tgPost(env, { chat: { id: 7, type: "private" }, text: "/tasks" });
    expect(f.sent.length).toBe(before); // stranger: no reply at all

    await tgPost(env, { chat: { id: 42, type: "private" }, text: "/tasks" });
    expect(texts(f.sent).at(-1)).toEqual(["42", "No tasks yet."]);
  });
});

describe("phone agent", () => {
  it("builds webhook tools and an agent that uses the call's details", () => {
    const t = webhookToolConfig("update_task", "https://bev.example", "k").tool_config;
    expect(t.api_schema.url).toBe("https://bev.example/phone/tool/update_task");
    expect(t.api_schema.request_headers).toEqual({ "X-Bev-Key": "k" });
    expect(t.api_schema.request_body_schema.required).toEqual(["id"]);
    expect((t.api_schema.request_body_schema.properties as any).status).toMatchObject({ type: "string", enum: ["active", "paused", "done"] });
    const a = agentConfig(testEnv(withCalls), ["t1"]);
    expect(a.conversation_config.agent.first_message).toBe("{{opening}}");
    expect(a.conversation_config.agent.prompt.prompt).toMatch(/\{\{call_reason\}\}[\s\S]*\{\{tasks\}\}/);
    expect(a.conversation_config.tts.voice_id).toBe("voice1");
  });

  it("setup creates tools, agent and number once, then updates", async () => {
    const env = testEnv(withCalls);
    const store = new Store(env.DB);
    const f = fakeFetch();
    expect(await setupPhone(env, store, "https://bev.example", f.fn)).toBe("Phone calls: ready.");
    const number = f.sent.find((s) => s.url.endsWith("/phone-numbers"))!.body as Record<string, unknown>;
    expect(number).toMatchObject({ phone_number: "+447000000000", provider: "twilio" });
    expect(number.agent_id).toBeUndefined(); // no agent on incoming calls
    const n = f.sent.length;
    await setupPhone(env, store, "https://bev.example", { ...f, fn: f.fn }.fn);
    const again = f.sent.slice(n).map((s) => s.url);
    expect(again.some((u) => u.endsWith("/agents/create") || u.endsWith("/phone-numbers"))).toBe(false);
  });

  it("tool webhook needs the key", async () => {
    const env = testEnv(withCalls);
    const { c } = ctx();
    const call = async (key: string) =>
      worker.fetch(new Request("https://bev.example/phone/tool/list_tasks", { method: "POST", headers: { "X-Bev-Key": key }, body: "{}" }), env, c);
    expect((await call("nope")).status).toBe(403);
    const ok = await call(await phoneToolKey(env));
    expect(await ok.json()).toEqual({ result: "No tasks yet." });
  });
});

describe("desktop API", () => {
  it("requires the admin key and manages tasks", async () => {
    const env = testEnv();
    const { c } = ctx();
    const req = (path: string, init: RequestInit = {}, key = env.ADMIN_KEY) =>
      worker.fetch(new Request(`https://bev.example${path}`, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } }), env, c);
    expect((await req("/api/tasks", {}, "wrong")).status).toBe(401);
    const add = await req("/api/tasks", { method: "POST", body: JSON.stringify({ kind: "watch", title: "Steam download", runs_on: "pc" }) });
    expect(await add.json()).toMatchObject({ result: expect.stringMatching(/Added: #1/) });
    const pc = (await (await req("/api/pc-tasks")).json()) as { tasks: Array<{ title: string }> };
    expect(pc.tasks.map((t) => t.title)).toEqual(["Steam download"]);
    expect((await req("/api/tasks/1", { method: "DELETE" })).status).toBe(200);
    const code = (await (await req("/api/pairing-code")).json()) as { linked: boolean; code: string };
    expect(code).toEqual({ linked: false, code: expect.stringMatching(/^[0-9A-F]{8}$/) });
  });

  it("refuses a weak admin key", async () => {
    const env = testEnv({ ADMIN_KEY: "short" });
    const { c } = ctx();
    const r = await worker.fetch(new Request("https://bev.example/api/status", { headers: { authorization: "Bearer short" } }), env, c);
    expect(r.status).toBe(401);
  });
});
