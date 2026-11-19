/**
 * BEV Accounts.
 *
 * Sign-in (desktop, RFC 8252 loopback + PKCE):
 *   GET  /auth/discord?redirect=http://127.0.0.1:PORT/callback&state=S&challenge=C
 *        → Discord → GET /auth/discord/callback → back to the app with ?code=…&state=S
 *   POST /auth/token   { code, verifier, device }  → { token, user }
 *   POST /auth/logout  (Bearer)
 *
 * Account (Bearer session token):
 *   GET    /me                       user + signed-in devices
 *   DELETE /sessions/:id             sign a device out
 *   GET    /vault  PUT /vault        the wrapped data key (opaque to us)
 *   POST   /sync/push  GET /sync/pull?since=N
 *   POST   /data/erase  { kinds }    erase synced memories/notes/profile (keep the account)
 *   GET    /export                   everything we hold, as JSON
 *   DELETE /account                  erase the account and all its data
 *
 * Phone control (the phone page signs in the same way, redirecting to /phone):
 *   GET  /phone                       the phone page
 *   POST /phone/messages  { dir, iv, ct }        relay one encrypted message
 *   GET  /phone/messages?dir=to_pc|to_phone&since=N
 *   GET  /phone/status                when the PC last checked in
 *
 * Memories are encrypted on the user's devices before they're sent. This
 * service never sees the key, so it can't read them.
 */

import { phonePage } from "./phone";

export interface Env {
  DB: D1Database;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  /** Extra browser origins allowed to call the API (future web version). */
  WEB_ORIGINS?: string;
}

const DAY = 86_400_000;
const SESSION_DAYS = 180;
const PENDING_TTL = 10 * 60_000;
const CODE_TTL = 2 * 60_000;
export const LIMITS = {
  pushItems: 500,
  pullItems: 500,
  itemBytes: 96 * 1024,
  vaultBytes: 8 * 1024,
  userBytes: 50 * 1024 * 1024,
  sessionsPerUser: 20,
  /** Phone control */
  phoneMessage: 24 * 1024,
  phoneScreen: 900 * 1024,
  phoneKeep: 300,
  phoneScreensKeep: 2,
  phonePerMinute: 60,
  phoneTtl: DAY,
};
const KINDS = new Set(["memory", "note", "profile"]);

// ---------------------------------------------------------------------------
// helpers

const enc = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

/** Only loopback redirects (the desktop app), this service's own phone page, or a configured web origin. */
export function redirectAllowed(redirect: string, env: Env, self?: string): boolean {
  let u: URL;
  try {
    u = new URL(redirect);
  } catch {
    return false;
  }
  if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port !== "") return true;
  if (self && u.origin === self && u.pathname === "/phone" && !u.search && !u.hash) return true;
  return webOrigins(env).includes(u.origin);
}

function webOrigins(env: Env): string[] {
  return (env.WEB_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^https:\/\//.test(s));
}

function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  if (!origin || !webOrigins(env).includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });

const fail = (status: number, error: string, extra: Record<string, string> = {}) => json({ error }, status, extra);

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>
<style>body{font:15px system-ui,sans-serif;background:#0d0f12;color:#e6e8eb;display:grid;place-items:center;height:100vh;margin:0}main{max-width:420px;padding:24px;text-align:center}h1{font-weight:500;font-size:20px}p{color:#9aa1a9}</style>
<main><h1>${title}</h1><p>${body}</p></main>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function body<T>(req: Request, max = 2 * 1024 * 1024): Promise<T | null> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > max) return null;
  const text = await req.text();
  if (text.length > max) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

interface User {
  id: string;
  discord_id: string;
  name: string;
  avatar: string | null;
  created_at: number;
}

const publicUser = (u: User) => ({
  id: u.id,
  name: u.name,
  avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.discord_id}/${u.avatar}.png?size=128` : null,
  created_at: u.created_at,
});

async function authed(req: Request, env: Env): Promise<{ user: User; tokenHash: string } | null> {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(h);
  if (!m) return null;
  const tokenHash = await sha256(m[1]);
  const now = Date.now();
  const row = await env.DB.prepare(
    "SELECT u.*, s.last_used FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?"
  )
    .bind(tokenHash, now)
    .first<User & { last_used: number }>();
  if (!row) return null;
  // Sliding expiry, written at most hourly.
  if (now - row.last_used > 3_600_000) {
    await env.DB.prepare("UPDATE sessions SET last_used = ?, expires_at = ? WHERE token_hash = ?")
      .bind(now, now + SESSION_DAYS * DAY, tokenHash)
      .run();
  }
  return { user: row, tokenHash };
}

// ---------------------------------------------------------------------------
// sign-in

async function startDiscord(url: URL, env: Env): Promise<Response> {
  const redirect = url.searchParams.get("redirect") ?? "";
  const appState = url.searchParams.get("state") ?? "";
  const challenge = url.searchParams.get("challenge") ?? "";
  if (!redirectAllowed(redirect, env, url.origin)) return page("Can't sign in", "This sign-in link didn't come from the BEV app.", 400);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(appState) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return page("Can't sign in", "This sign-in link is incomplete. Start again from BEV.", 400);
  }
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) return page("Sign-in isn't set up", "The BEV accounts service is missing its Discord app details.", 503);
  const id = randomToken(24);
  await env.DB.prepare("INSERT INTO pending_logins (id, redirect, app_state, challenge, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, redirect, appState, challenge, Date.now())
    .run();
  const to = new URL("https://discord.com/oauth2/authorize");
  to.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  to.searchParams.set("response_type", "code");
  to.searchParams.set("scope", "identify");
  to.searchParams.set("redirect_uri", `${url.origin}/auth/discord/callback`);
  to.searchParams.set("state", id);
  to.searchParams.set("prompt", "none");
  return Response.redirect(to.toString(), 302);
}

async function discordCallback(url: URL, env: Env, fetcher: typeof fetch): Promise<Response> {
  const id = url.searchParams.get("state") ?? "";
  const pending = await env.DB.prepare("SELECT * FROM pending_logins WHERE id = ?")
    .bind(id)
    .first<{ id: string; redirect: string; app_state: string; challenge: string; created_at: number }>();
  if (!pending || Date.now() - pending.created_at > PENDING_TTL) {
    return page("Sign-in expired", "That took a little too long. Go back to BEV and press Sign in again.", 400);
  }
  await env.DB.prepare("DELETE FROM pending_logins WHERE id = ?").bind(id).run();
  const back = new URL(pending.redirect);
  back.searchParams.set("state", pending.app_state);
  const code = url.searchParams.get("code");
  if (!code) {
    back.searchParams.set("error", url.searchParams.get("error") === "access_denied" ? "cancelled" : "discord_error");
    return Response.redirect(back.toString(), 302);
  }

  // Exchange Discord's code for its access token, then ask who this is.
  const tok = await fetcher("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${url.origin}/auth/discord/callback`,
    }),
  });
  if (!tok.ok) {
    back.searchParams.set("error", "discord_error");
    return Response.redirect(back.toString(), 302);
  }
  const { access_token } = (await tok.json()) as { access_token?: string };
  const me = await fetcher("https://discord.com/api/users/@me", { headers: { authorization: `Bearer ${access_token}` } });
  if (!me.ok) {
    back.searchParams.set("error", "discord_error");
    return Response.redirect(back.toString(), 302);
  }
  const d = (await me.json()) as { id: string; username: string; global_name?: string | null; avatar?: string | null };
  if (!/^\d{5,25}$/.test(d.id ?? "")) {
    back.searchParams.set("error", "discord_error");
    return Response.redirect(back.toString(), 302);
  }
  const name = (d.global_name || d.username || "BEV user").slice(0, 64);
  const existing = await env.DB.prepare("SELECT id FROM users WHERE discord_id = ?").bind(d.id).first<{ id: string }>();
  const userId = existing?.id ?? crypto.randomUUID();
  if (existing) {
    await env.DB.prepare("UPDATE users SET name = ?, avatar = ? WHERE id = ?").bind(name, d.avatar ?? null, userId).run();
  } else {
    await env.DB.prepare("INSERT INTO users (id, discord_id, name, avatar, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(userId, d.id, name, d.avatar ?? null, Date.now())
      .run();
  }

  const loginCode = randomToken(32);
  await env.DB.prepare("INSERT INTO login_codes (code_hash, user_id, challenge, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(loginCode), userId, pending.challenge, Date.now())
    .run();
  back.searchParams.set("code", loginCode);
  return Response.redirect(back.toString(), 302);
}

async function issueToken(req: Request, env: Env): Promise<Response> {
  const b = await body<{ code?: string; verifier?: string; device?: string }>(req, 4096);
  if (!b?.code || !b.verifier) return fail(400, "missing code or verifier");
  const codeHash = await sha256(b.code);
  const row = await env.DB.prepare("SELECT * FROM login_codes WHERE code_hash = ?")
    .bind(codeHash)
    .first<{ user_id: string; challenge: string; created_at: number }>();
  // One use only, whatever happens next.
  await env.DB.prepare("DELETE FROM login_codes WHERE code_hash = ?").bind(codeHash).run();
  if (!row || Date.now() - row.created_at > CODE_TTL) return fail(400, "that sign-in code has expired; sign in again");
  if ((await sha256(b.verifier)) !== row.challenge) return fail(400, "sign-in check failed; sign in again");

  // Keep the device list tidy: drop the oldest beyond the cap.
  await env.DB.prepare(
    `DELETE FROM sessions WHERE user_id = ?1 AND token_hash NOT IN
       (SELECT token_hash FROM sessions WHERE user_id = ?1 ORDER BY last_used DESC LIMIT ?2)`
  )
    .bind(row.user_id, LIMITS.sessionsPerUser - 1)
    .run();
  const token = randomToken(32);
  const now = Date.now();
  const device = (b.device ?? "BEV").replace(/[^\p{L}\p{N} ._()'-]/gu, "").slice(0, 60) || "BEV";
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, device, created_at, last_used, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256(token), row.user_id, device, now, now, now + SESSION_DAYS * DAY)
    .run();
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(row.user_id).first<User>();
  return json({ token, user: user ? publicUser(user) : null });
}

// ---------------------------------------------------------------------------
// account data

interface PushItem {
  id: string;
  kind: string;
  deleted?: boolean;
  iv?: string;
  ct?: string;
}

async function push(req: Request, env: Env, user: User): Promise<Response> {
  const b = await body<{ items?: PushItem[] }>(req, LIMITS.pushItems * (LIMITS.itemBytes + 256));
  const items = b?.items;
  if (!Array.isArray(items)) return fail(400, "expected { items: [...] }");
  if (items.length > LIMITS.pushItems) return fail(413, `at most ${LIMITS.pushItems} items per push`);
  for (const it of items) {
    if (typeof it.id !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(it.id)) return fail(400, "bad item id");
    if (!KINDS.has(it.kind)) return fail(400, `unknown kind "${String(it.kind)}"`);
    if (!it.deleted && (typeof it.iv !== "string" || typeof it.ct !== "string" || !it.iv || !it.ct)) return fail(400, "item missing ciphertext");
    if ((it.ct?.length ?? 0) > LIMITS.itemBytes) return fail(413, "an item is too large");
  }
  const used = await env.DB.prepare("SELECT COALESCE(SUM(LENGTH(ct)), 0) AS n FROM items WHERE user_id = ?").bind(user.id).first<{ n: number }>();
  const adding = items.reduce((n, it) => n + (it.deleted ? 0 : (it.ct?.length ?? 0)), 0);
  if ((used?.n ?? 0) + adding > LIMITS.userBytes) return fail(413, "your BEV storage is full");

  const now = Date.now();
  let seq = (await env.DB.prepare("SELECT seq FROM counters WHERE user_id = ?").bind(user.id).first<{ seq: number }>())?.seq ?? 0;
  const stmts: D1PreparedStatement[] = [];
  for (const it of items) {
    seq++;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO items (user_id, id, kind, seq, deleted, iv, ct, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET kind = excluded.kind, seq = excluded.seq, deleted = excluded.deleted,
           iv = excluded.iv, ct = excluded.ct, updated_at = excluded.updated_at`
      ).bind(user.id, it.id, it.kind, seq, it.deleted ? 1 : 0, it.deleted ? "" : it.iv, it.deleted ? "" : it.ct, now)
    );
  }
  stmts.push(
    env.DB.prepare("INSERT INTO counters (user_id, seq) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET seq = excluded.seq").bind(user.id, seq)
  );
  if (env.DB.batch) await env.DB.batch(stmts);
  else for (const s of stmts) await s.run();
  return json({ cursor: seq, accepted: items.length });
}

async function pull(url: URL, env: Env, user: User): Promise<Response> {
  const since = Math.max(0, Math.floor(Number(url.searchParams.get("since") ?? 0)) || 0);
  const rows = await env.DB.prepare(
    "SELECT id, kind, seq, deleted, iv, ct FROM items WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?"
  )
    .bind(user.id, since, LIMITS.pullItems + 1)
    .all<{ id: string; kind: string; seq: number; deleted: number; iv: string; ct: string }>();
  const list = rows.results.slice(0, LIMITS.pullItems);
  const cursor = list.length ? list[list.length - 1].seq : since;
  return json({
    items: list.map((r) => ({ id: r.id, kind: r.kind, deleted: r.deleted === 1, ...(r.deleted ? {} : { iv: r.iv, ct: r.ct }) })),
    cursor,
    more: rows.results.length > LIMITS.pullItems,
  });
}

async function handle(req: Request, env: Env, fetcher: typeof fetch): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const c = cors(req, env);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: c });

  if (req.method === "GET" && path === "/") return json({ service: "bev-accounts", ok: true }, 200, c);
  if (req.method === "GET" && path === "/phone") return phonePage();
  if (req.method === "GET" && path === "/auth/discord") return startDiscord(url, env);
  if (req.method === "GET" && path === "/auth/discord/callback") return discordCallback(url, env, fetcher);
  if (req.method === "POST" && path === "/auth/token") {
    const r = await issueToken(req, env);
    Object.entries(c).forEach(([k, v]) => r.headers.set(k, v));
    return r;
  }

  const who = await authed(req, env);
  if (!who) return fail(401, "not signed in", c);
  const { user, tokenHash } = who;

  if (req.method === "POST" && path === "/auth/logout") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return json({ ok: true }, 200, c);
  }
  if (req.method === "GET" && path === "/me") {
    const s = await env.DB.prepare("SELECT token_hash, device, created_at, last_used FROM sessions WHERE user_id = ? ORDER BY last_used DESC")
      .bind(user.id)
      .all<{ token_hash: string; device: string; created_at: number; last_used: number }>();
    return json(
      {
        user: publicUser(user),
        devices: s.results.map((d) => ({ id: d.token_hash.slice(0, 16), device: d.device, created_at: d.created_at, last_used: d.last_used, current: d.token_hash === tokenHash })),
      },
      200,
      c
    );
  }
  const signOut = /^\/sessions\/([A-Za-z0-9_-]{16})$/.exec(path);
  if (req.method === "DELETE" && signOut) {
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?").bind(user.id, signOut[1]).run();
    return json({ ok: true }, 200, c);
  }
  if (req.method === "GET" && path === "/vault") {
    const v = await env.DB.prepare("SELECT data, updated_at FROM vaults WHERE user_id = ?").bind(user.id).first<{ data: string; updated_at: number }>();
    return v ? json({ vault: JSON.parse(v.data), updated_at: v.updated_at }, 200, c) : fail(404, "no vault yet", c);
  }
  if (req.method === "PUT" && path === "/vault") {
    const b = await body<{ vault?: unknown; replace?: boolean }>(req, LIMITS.vaultBytes + 256);
    const data = b?.vault !== undefined ? JSON.stringify(b.vault) : "";
    if (!data || data.length > LIMITS.vaultBytes || typeof b?.vault !== "object") return fail(400, "expected { vault: {...} }", c);
    const exists = await env.DB.prepare("SELECT 1 AS x FROM vaults WHERE user_id = ?").bind(user.id).first();
    // Creating twice would orphan every encrypted item: only replace on purpose
    // (a passphrase change re-wraps the same key).
    if (exists && !b?.replace) return fail(409, "this account already has a vault", c);
    await env.DB.prepare("INSERT INTO vaults (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
      .bind(user.id, data, Date.now())
      .run();
    return json({ ok: true }, 200, c);
  }
  if (req.method === "POST" && path === "/sync/push") {
    const r = await push(req, env, user);
    Object.entries(c).forEach(([k, v]) => r.headers.set(k, v));
    return r;
  }
  if (req.method === "GET" && path === "/sync/pull") {
    const r = await pull(url, env, user);
    Object.entries(c).forEach(([k, v]) => r.headers.set(k, v));
    return r;
  }
  if (req.method === "POST" && path === "/data/erase") {
    // Erased records become deletion markers, so every device removes its
    // copy on its next sync; their content is gone from the server at once.
    const b = await body<{ kinds?: string[] }>(req, 1024);
    const kinds = (b?.kinds ?? ["memory", "note", "profile"]).filter((k) => KINDS.has(k));
    if (!kinds.length) return fail(400, "nothing to erase", c);
    const rows = await env.DB.prepare(`SELECT id FROM items WHERE user_id = ? AND deleted = 0 AND kind IN (${kinds.map(() => "?").join(",")})`)
      .bind(user.id, ...kinds)
      .all<{ id: string }>();
    let seq = (await env.DB.prepare("SELECT seq FROM counters WHERE user_id = ?").bind(user.id).first<{ seq: number }>())?.seq ?? 0;
    const now = Date.now();
    const stmts = rows.results.map((r) => env.DB.prepare("UPDATE items SET deleted = 1, iv = '', ct = '', seq = ?, updated_at = ? WHERE user_id = ? AND id = ?").bind(++seq, now, user.id, r.id));
    stmts.push(env.DB.prepare("INSERT INTO counters (user_id, seq) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET seq = excluded.seq").bind(user.id, seq));
    if (env.DB.batch) await env.DB.batch(stmts);
    else for (const s of stmts) await s.run();
    return json({ ok: true, erased: rows.results.length }, 200, c);
  }
  if (path === "/phone/messages" || path === "/phone/status") {
    const r = await phoneApi(req, url, path, env, user);
    Object.entries(c).forEach(([k, v]) => r.headers.set(k, v));
    return r;
  }
  if (req.method === "GET" && path === "/export") {
    const v = await env.DB.prepare("SELECT data FROM vaults WHERE user_id = ?").bind(user.id).first<{ data: string }>();
    const items = await env.DB.prepare("SELECT id, kind, deleted, iv, ct, updated_at FROM items WHERE user_id = ? ORDER BY seq").bind(user.id).all();
    const phone = await env.DB.prepare("SELECT id, dir, iv, ct, created_at FROM phone_messages WHERE user_id = ? ORDER BY id").bind(user.id).all();
    return json({ user: publicUser(user), vault: v ? JSON.parse(v.data) : null, items: items.results, phone_messages: phone.results }, 200, c);
  }
  if (req.method === "DELETE" && path === "/account") {
    const stmts = ["items", "counters", "vaults", "sessions", "login_codes", "phone_messages", "phone_presence"].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(user.id));
    stmts.push(env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id));
    if (env.DB.batch) await env.DB.batch(stmts);
    else for (const s of stmts) await s.run();
    return json({ ok: true, deleted: true }, 200, c);
  }
  return fail(404, "not found", c);
}

export async function cleanup(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM pending_logins WHERE created_at < ?").bind(now - PENDING_TTL).run();
  await env.DB.prepare("DELETE FROM login_codes WHERE created_at < ?").bind(now - CODE_TTL).run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  await env.DB.prepare("DELETE FROM phone_messages WHERE created_at < ?").bind(now - LIMITS.phoneTtl).run();
}

// ---------------------------------------------------------------------------
// phone control: a relay for ciphertext between the user's phone and PC

const DIRS = new Set(["to_pc", "to_phone"]);

async function phoneApi(req: Request, url: URL, path: string, env: Env, user: User): Promise<Response> {
  const now = Date.now();
  if (req.method === "GET" && path === "/phone/status") {
    const p = await env.DB.prepare("SELECT last_seen FROM phone_presence WHERE user_id = ?").bind(user.id).first<{ last_seen: number }>();
    return json({ pc_last_seen: p?.last_seen ?? null, now });
  }
  if (req.method === "GET" && path === "/phone/messages") {
    const dir = url.searchParams.get("dir") ?? "";
    if (!DIRS.has(dir)) return fail(400, "dir must be to_pc or to_phone");
    // The PC listening is what makes it "online" on the phone.
    if (dir === "to_pc") {
      await env.DB.prepare("INSERT INTO phone_presence (user_id, last_seen) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_seen = excluded.last_seen")
        .bind(user.id, now)
        .run();
    }
    const since = Math.floor(Number(url.searchParams.get("since") ?? 0)) || 0;
    const latest = (await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM phone_messages WHERE user_id = ? AND dir = ?").bind(user.id, dir).first<{ n: number }>())?.n ?? 0;
    if (since < 0) return json({ messages: [], latest });
    const rows = await env.DB.prepare("SELECT id, iv, ct, created_at FROM phone_messages WHERE user_id = ? AND dir = ? AND id > ? ORDER BY id LIMIT 100")
      .bind(user.id, dir, since)
      .all<{ id: number; iv: string; ct: string; created_at: number }>();
    return json({ messages: rows.results, latest });
  }
  if (req.method === "POST" && path === "/phone/messages") {
    const b = await body<{ dir?: string; iv?: string; ct?: string }>(req, LIMITS.phoneScreen + 1024);
    if (!b || !DIRS.has(b.dir ?? "")) return fail(400, "dir must be to_pc or to_phone");
    if (typeof b.iv !== "string" || !/^[A-Za-z0-9+/=]{12,32}$/.test(b.iv) || typeof b.ct !== "string" || !/^[A-Za-z0-9+/=]+$/.test(b.ct)) return fail(400, "expected encrypted { iv, ct }");
    const big = b.ct.length > LIMITS.phoneMessage;
    if (b.ct.length > LIMITS.phoneScreen || (big && b.dir !== "to_phone")) return fail(413, "message too large");
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM phone_messages WHERE user_id = ? AND created_at > ?").bind(user.id, now - 60_000).first<{ n: number }>();
    if ((recent?.n ?? 0) >= LIMITS.phonePerMinute) return fail(429, "too many messages; wait a moment");
    const r = await env.DB.prepare("INSERT INTO phone_messages (user_id, dir, iv, ct, big, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(user.id, b.dir, b.iv, b.ct, big ? 1 : 0, now)
      .run();
    // Keep it small: the newest few screenshots and a few hundred messages.
    if (big) {
      await env.DB.prepare(
        `DELETE FROM phone_messages WHERE user_id = ?1 AND big = 1 AND id NOT IN
           (SELECT id FROM phone_messages WHERE user_id = ?1 AND big = 1 ORDER BY id DESC LIMIT ?2)`
      )
        .bind(user.id, LIMITS.phoneScreensKeep)
        .run();
    }
    await env.DB.prepare(
      `DELETE FROM phone_messages WHERE user_id = ?1 AND id NOT IN
         (SELECT id FROM phone_messages WHERE user_id = ?1 ORDER BY id DESC LIMIT ?2)`
    )
      .bind(user.id, LIMITS.phoneKeep)
      .run();
    return json({ ok: true, id: (r as { meta?: { last_row_id?: number } }).meta?.last_row_id ?? null });
  }
  return fail(405, "method not allowed");
}

/** Exported for tests: the request handler with an injectable fetch (Discord). */
export function app(fetcher: typeof fetch = fetch) {
  return (req: Request, env: Env) =>
    handle(req, env, fetcher).catch((e) => {
      console.error("bev-accounts error", e instanceof Error ? e.message : e);
      return fail(500, "something went wrong");
    });
}

export default {
  fetch: (req: Request, env: Env) => app()(req, env),
  scheduled: async (_e: ScheduledController, env: Env) => cleanup(env),
};
