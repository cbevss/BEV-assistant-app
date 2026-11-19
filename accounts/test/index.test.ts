import { beforeEach, describe, expect, it } from "vitest";
import { app, b64url, cleanup, redirectAllowed, sha256, LIMITS, type Env } from "../src/index";
import { testDb } from "./d1";

const BASE = "https://accounts.example.workers.dev";
const LOOPBACK = "http://127.0.0.1:51234/callback";

function fakeDiscord(user = { id: "123456789", username: "cbev", global_name: "Cbev", avatar: "abc" }) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/oauth2/token")) {
      const p = new URLSearchParams(String(init?.body));
      return p.get("code") === "discord-ok" ? Response.json({ access_token: "dtok" }) : new Response("bad", { status: 400 });
    }
    if (url.endsWith("/users/@me")) return Response.json(user);
    return new Response("?", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

let env: Env;
beforeEach(() => {
  env = { DB: testDb(), DISCORD_CLIENT_ID: "cid", DISCORD_CLIENT_SECRET: "secret", WEB_ORIGINS: "https://app.bev.test" };
});

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: await sha256(verifier) };
}

/** Run the whole sign-in and return a session token. */
async function signIn(handler = app(fakeDiscord().f), device = "Desktop PC") {
  const { verifier, challenge } = await pkce();
  const state = "app-state-1234567890";
  const start = await handler(new Request(`${BASE}/auth/discord?redirect=${encodeURIComponent(LOOPBACK)}&state=${state}&challenge=${challenge}`), env);
  expect(start.status).toBe(302);
  const toDiscord = new URL(start.headers.get("location")!);
  expect(toDiscord.origin).toBe("https://discord.com");
  expect(toDiscord.searchParams.get("scope")).toBe("identify");
  const cb = await handler(new Request(`${BASE}/auth/discord/callback?code=discord-ok&state=${toDiscord.searchParams.get("state")}`), env);
  const back = new URL(cb.headers.get("location")!);
  expect(back.origin + back.pathname).toBe(LOOPBACK);
  expect(back.searchParams.get("state")).toBe(state);
  const code = back.searchParams.get("code")!;
  const tok = await handler(new Request(`${BASE}/auth/token`, { method: "POST", body: JSON.stringify({ code, verifier, device }) }), env);
  expect(tok.status).toBe(200);
  const j = (await tok.json()) as { token: string; user: { name: string; avatar: string } };
  return { token: j.token, user: j.user, code, verifier };
}

const req = (path: string, token: string, init: RequestInit = {}) =>
  new Request(`${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });

describe("sign-in with Discord", () => {
  it("signs in through the loopback redirect and returns a session", async () => {
    const { token, user } = await signIn();
    expect(token.length).toBeGreaterThan(30);
    expect(user.name).toBe("Cbev");
    expect(user.avatar).toContain("cdn.discordapp.com/avatars/123456789/abc.png");
    const me = (await (await app()(req("/me", token), env)).json()) as { devices: { device: string; current: boolean }[] };
    expect(me.devices).toEqual([expect.objectContaining({ device: "Desktop PC", current: true })]);
  });

  it("only redirects to the app on this PC or a configured web origin", () => {
    expect(redirectAllowed(LOOPBACK, env)).toBe(true);
    expect(redirectAllowed("http://localhost:5000/cb", env)).toBe(true);
    expect(redirectAllowed("https://app.bev.test/auth", env)).toBe(true);
    expect(redirectAllowed("https://evil.example/cb", env)).toBe(false);
    expect(redirectAllowed("http://127.0.0.1/cb", env)).toBe(false); // no port: not the app's listener
    expect(redirectAllowed("not a url", env)).toBe(false);
  });

  it("refuses a code used twice or with the wrong verifier", async () => {
    const handler = app(fakeDiscord().f);
    const { code, verifier } = await signIn(handler);
    const again = await handler(new Request(`${BASE}/auth/token`, { method: "POST", body: JSON.stringify({ code, verifier }) }), env);
    expect(again.status).toBe(400);

    // A fresh sign-in, but someone else's verifier.
    const { challenge } = await pkce();
    const start = await handler(new Request(`${BASE}/auth/discord?redirect=${encodeURIComponent(LOOPBACK)}&state=abcdefghijklmnop&challenge=${challenge}`), env);
    const st = new URL(start.headers.get("location")!).searchParams.get("state");
    const cb = await handler(new Request(`${BASE}/auth/discord/callback?code=discord-ok&state=${st}`), env);
    const c2 = new URL(cb.headers.get("location")!).searchParams.get("code");
    const wrong = await handler(new Request(`${BASE}/auth/token`, { method: "POST", body: JSON.stringify({ code: c2, verifier: "x".repeat(43) }) }), env);
    expect(wrong.status).toBe(400);
  });

  it("sends the user back with an error when they cancel at Discord", async () => {
    const handler = app(fakeDiscord().f);
    const { challenge } = await pkce();
    const start = await handler(new Request(`${BASE}/auth/discord?redirect=${encodeURIComponent(LOOPBACK)}&state=abcdefghijklmnop&challenge=${challenge}`), env);
    const st = new URL(start.headers.get("location")!).searchParams.get("state");
    const cb = await handler(new Request(`${BASE}/auth/discord/callback?error=access_denied&state=${st}`), env);
    expect(new URL(cb.headers.get("location")!).searchParams.get("error")).toBe("cancelled");
  });

  it("is the same account when the same Discord user signs in on another device", async () => {
    const a = await signIn(app(fakeDiscord().f), "Desktop");
    const b = await signIn(app(fakeDiscord().f), "Laptop");
    expect(a.user).toEqual(b.user);
    const me = (await (await app()(req("/me", b.token), env)).json()) as { devices: unknown[] };
    expect(me.devices).toHaveLength(2);
  });

  it("rejects requests without a valid session", async () => {
    expect((await app()(new Request(`${BASE}/me`), env)).status).toBe(401);
    expect((await app()(req("/me", "x".repeat(43)), env)).status).toBe(401);
  });
});

describe("encrypted vault and sync", () => {
  it("stores the wrapped key once and refuses to overwrite it by accident", async () => {
    const { token } = await signIn();
    expect((await app()(req("/vault", token), env)).status).toBe(404);
    const vault = { v: 1, kdf: "PBKDF2-SHA256", wrapped: { passphrase: "aaa", recovery: "bbb" } };
    const put = (b: unknown) => app()(req("/vault", token, { method: "PUT", body: JSON.stringify(b) }), env);
    expect((await put({ vault })).status).toBe(200);
    expect((await put({ vault: { ...vault, v: 2 } })).status).toBe(409);
    expect((await put({ vault: { ...vault, v: 2 }, replace: true })).status).toBe(200);
    const got = (await (await app()(req("/vault", token), env)).json()) as { vault: { v: number } };
    expect(got.vault.v).toBe(2);
  });

  it("pushes and pulls changes in order, including deletions", async () => {
    const { token } = await signIn();
    const push = (items: unknown[]) => app()(req("/sync/push", token, { method: "POST", body: JSON.stringify({ items }) }), env);
    const pull = async (since: number) => (await (await app()(req(`/sync/pull?since=${since}`, token), env)).json()) as { items: { id: string; deleted: boolean; ct?: string }[]; cursor: number; more: boolean };

    expect((await push([{ id: "mem-aaaaaaaa", kind: "memory", iv: "iv1", ct: "ct1" }, { id: "note-bbbbbbbb", kind: "note", iv: "iv2", ct: "ct2" }])).status).toBe(200);
    const first = await pull(0);
    expect(first.items.map((i) => i.id)).toEqual(["mem-aaaaaaaa", "note-bbbbbbbb"]);
    expect(first.cursor).toBe(2);

    await push([{ id: "mem-aaaaaaaa", kind: "memory", deleted: true }]);
    const next = await pull(first.cursor);
    expect(next.items).toEqual([{ id: "mem-aaaaaaaa", kind: "memory", deleted: true }]);
    expect((await pull(next.cursor)).items).toEqual([]);
  });

  it("validates pushes", async () => {
    const { token } = await signIn();
    const push = (items: unknown) => app()(req("/sync/push", token, { method: "POST", body: JSON.stringify({ items }) }), env);
    expect((await push([{ id: "x", kind: "memory", iv: "a", ct: "b" }])).status).toBe(400);
    expect((await push([{ id: "mem-aaaaaaaa", kind: "passwords", iv: "a", ct: "b" }])).status).toBe(400);
    expect((await push([{ id: "mem-aaaaaaaa", kind: "memory" }])).status).toBe(400);
    expect((await push([{ id: "mem-aaaaaaaa", kind: "memory", iv: "a", ct: "x".repeat(LIMITS.itemBytes + 1) }])).status).toBe(413);
  });

  it("keeps each account's data apart", async () => {
    const a = await signIn(app(fakeDiscord().f));
    const b = await signIn(app(fakeDiscord({ id: "987654321", username: "other", global_name: null, avatar: null } as never).f));
    await app()(req("/sync/push", a.token, { method: "POST", body: JSON.stringify({ items: [{ id: "mem-aaaaaaaa", kind: "memory", iv: "i", ct: "c" }] }) }), env);
    const other = (await (await app()(req("/sync/pull?since=0", b.token), env)).json()) as { items: unknown[] };
    expect(other.items).toEqual([]);
  });
});

describe("devices, export and deletion", () => {
  it("signs out this device or another one", async () => {
    const a = await signIn(app(fakeDiscord().f), "Desktop");
    const b = await signIn(app(fakeDiscord().f), "Laptop");
    const me = (await (await app()(req("/me", a.token), env)).json()) as { devices: { id: string; device: string }[] };
    const laptop = me.devices.find((d) => d.device === "Laptop")!;
    await app()(req(`/sessions/${laptop.id}`, a.token, { method: "DELETE" }), env);
    expect((await app()(req("/me", b.token), env)).status).toBe(401);
    await app()(req("/auth/logout", a.token, { method: "POST" }), env);
    expect((await app()(req("/me", a.token), env)).status).toBe(401);
  });

  it("exports everything and erases the account on request", async () => {
    const { token } = await signIn();
    await app()(req("/vault", token, { method: "PUT", body: JSON.stringify({ vault: { v: 1 } }) }), env);
    await app()(req("/sync/push", token, { method: "POST", body: JSON.stringify({ items: [{ id: "mem-aaaaaaaa", kind: "memory", iv: "i", ct: "c" }] }) }), env);
    const ex = (await (await app()(req("/export", token), env)).json()) as { vault: unknown; items: unknown[] };
    expect(ex.vault).toEqual({ v: 1 });
    expect(ex.items).toHaveLength(1);

    expect((await app()(req("/account", token, { method: "DELETE" }), env)).status).toBe(200);
    expect((await app()(req("/me", token), env)).status).toBe(401);
    for (const t of ["users", "items", "vaults", "sessions", "counters"]) {
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>();
      expect(n?.n).toBe(0);
    }
  });

  it("erases synced data but keeps the account, telling other devices to delete their copies", async () => {
    const { token } = await signIn();
    const push = (items: unknown[]) => app()(req("/sync/push", token, { method: "POST", body: JSON.stringify({ items }) }), env);
    await push([
      { id: "mem-aaaaaaaa", kind: "memory", iv: "i", ct: "secret1" },
      { id: "note-bbbbbbbb", kind: "note", iv: "i", ct: "secret2" },
    ]);
    const erase = (kinds?: string[]) => app()(req("/data/erase", token, { method: "POST", body: JSON.stringify(kinds ? { kinds } : {}) }), env);
    const r = (await (await erase(["memory"])).json()) as { erased: number };
    expect(r.erased).toBe(1);
    const pulled = (await (await app()(req("/sync/pull?since=2", token), env)).json()) as { items: unknown[] };
    expect(pulled.items).toEqual([{ id: "mem-aaaaaaaa", kind: "memory", deleted: true }]);
    await erase();
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE ct != ''").first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect((await app()(req("/me", token), env)).status).toBe(200);
    expect((await erase(["passwords"])).status).toBe(400);
  });

  it("answers the web version's preflight only for configured origins", async () => {
    const ok = await app()(new Request(`${BASE}/me`, { method: "OPTIONS", headers: { origin: "https://app.bev.test" } }), env);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.bev.test");
    const no = await app()(new Request(`${BASE}/me`, { method: "OPTIONS", headers: { origin: "https://evil.example" } }), env);
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("cleans up stale sign-ins", async () => {
    const { challenge } = await pkce();
    await app(fakeDiscord().f)(new Request(`${BASE}/auth/discord?redirect=${encodeURIComponent(LOOPBACK)}&state=abcdefghijklmnop&challenge=${challenge}`), env);
    await cleanup(env, Date.now() + 11 * 60_000);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_logins").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
