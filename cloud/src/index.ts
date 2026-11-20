/**
 * BEV Cloud entry point.
 *   POST /tg                 Telegram webhook (secret header checked)
 *   POST /phone/tool/:name   phone agent tool calls (key header checked)
 *   POST /admin/setup        connect Telegram + phone (Bearer ADMIN_KEY)
 *   POST /admin/test-call    ring the user (Bearer ADMIN_KEY)
 *   /api/*                   desktop BEV (Bearer ADMIN_KEY)
 *   cron (every minute)      run due tasks
 */
import type { Env } from "./env";
import { callsConfigured } from "./env";
import { Store } from "./db";
import { Brain } from "./brain";
import { Runner } from "./runner";
import { Telegram, pairingCode, webhookSecret, type TgMessage } from "./telegram";
import { handlePhoneTool, placeCall, setupPhone } from "./phone";
import { TaskTools, describeTask } from "./tools";
import { transcribe, speak } from "./voice";
import { report } from "./report";

const HELP = `I'm BEV. Tell me (text or voice note) anything you want tracked, for example:
• "Remind me at 6 to ring the garage"
• "Watch this page and tell me if it drops under £400: <link>"
• "Every morning at 8, give me a briefing"
• "Check the BBC every hour for news about the train strikes"
Urgent things ring your phone (if calls are set up); everything else comes here.
/tasks  what I'm tracking   /reports  recent updates   /clear  fresh chat`;

async function authorised(req: Request, env: Env): Promise<boolean> {
  const h = req.headers.get("authorization") ?? "";
  return Boolean(env.ADMIN_KEY) && env.ADMIN_KEY.length >= 24 && h === `Bearer ${env.ADMIN_KEY}`;
}

async function onTelegram(msg: TgMessage, env: Env, store: Store): Promise<void> {
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const chatId = String(msg.chat.id);
  const owner = await store.get("owner_chat");
  const text = msg.text?.trim() ?? "";

  if (!owner) {
    // Not paired yet: only the right one-time code links a chat.
    if (msg.chat.type === "private" && text === `/start ${await pairingCode(env)}`) {
      await store.set("owner_chat", chatId);
      await tg.setCommands().catch(() => {});
      await tg.send(chatId, `Linked. This chat is now BEV's line to you.\n\n${HELP}`);
    } else if (msg.chat.type === "private") {
      await tg.send(chatId, "Send /start followed by your pairing code to link this chat.");
    }
    return;
  }
  if (chatId !== owner) return; // private assistant: ignore everyone else

  const tools = new TaskTools(store, env.TIMEZONE);
  if (text === "/start" || text === "/help") return tg.send(chatId, HELP);
  if (text === "/tasks") return tg.send(chatId, await tools.run("list_tasks", {}));
  if (text === "/reports") return tg.send(chatId, await tools.run("recent_reports", { hours: 24 }));
  if (text === "/clear") {
    await store.clearMessages();
    return tg.send(chatId, "Fresh start. What's next?");
  }
  if (text === "/call") {
    const r = await placeCall(env, store, { headline: "This is a test call. You asked me to ring.", details: "Test call from Telegram." }, fetch, Date.now(), { ignoreGap: true });
    return tg.send(chatId, r.ok ? "📞 Calling you now." : `Couldn't call: ${r.status}.`);
  }

  let userText = text;
  const voice = msg.voice ?? msg.audio;
  if (!userText && voice) {
    await tg.typing(chatId);
    userText = await transcribe(env, await tg.download(voice.file_id)).catch(() => "");
    if (!userText) return tg.send(chatId, "Sorry, I couldn't make that voice note out. Try again or type it?");
  }
  if (!userText) return;

  await tg.typing(chatId);
  let reply: string;
  try {
    reply = await new Brain(env, store).reply(userText);
  } catch (e) {
    console.error("brain", e);
    reply = `Something went wrong on my side: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
  }
  await tg.send(chatId, reply);
  // Answer a voice note with a voice note.
  if (voice) {
    const audio = await speak(env, reply).catch(() => null);
    if (audio) await tg.sendVoice(chatId, audio).catch(() => {});
  }
}

async function api(req: Request, env: Env, store: Store, path: string): Promise<Response> {
  if (!(await authorised(req, env))) return new Response("unauthorised", { status: 401 });
  const tools = new TaskTools(store, env.TIMEZONE);
  const body = req.method === "GET" || req.method === "DELETE" ? {} : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
  const ok = (data: unknown) => Response.json(data);
  const fail = (e: unknown) => Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  try {
    if (path === "/api/status" && req.method === "GET") {
      return ok({
        ok: true,
        telegramLinked: Boolean(await store.get("owner_chat")),
        calls: callsConfigured(env) && Boolean(await store.get("el_agent_id")),
        timezone: env.TIMEZONE,
      });
    }
    if (path === "/api/pairing-code" && req.method === "GET") {
      if (await store.get("owner_chat")) return ok({ linked: true });
      return ok({ linked: false, code: await pairingCode(env) });
    }
    if (path === "/api/tasks" && req.method === "GET") {
      const list = await store.listTasks(new URL(req.url).searchParams.get("all") ? "all" : "active");
      return ok({ tasks: list.map((t) => ({ ...t, snapshot: undefined, summary: describeTask(t, env.TIMEZONE) })) });
    }
    if (path === "/api/tasks" && req.method === "POST") return ok({ result: await tools.run("add_task", body) });
    const m = /^\/api\/tasks\/(\d+)$/.exec(path);
    if (m && req.method === "PATCH") return ok({ result: await tools.run("update_task", { ...body, id: Number(m[1]) }) });
    if (m && req.method === "DELETE") return ok({ result: await tools.run("delete_task", { id: Number(m[1]) }) });
    if (path === "/api/pc-tasks" && req.method === "GET") {
      const list = (await store.listTasks()).filter((t) => t.runs_on === "pc");
      return ok({ tasks: list.map((t) => ({ id: t.id, kind: t.kind, title: t.title, instructions: t.instructions, repeat: t.repeat, urgent: t.urgent === 1 })) });
    }
    // The desktop app reports a PC-side result (a download finished, a game updated…).
    if (path === "/api/report" && req.method === "POST") {
      const text = String(body.text ?? "").trim();
      if (!text) throw new Error("text is required");
      const status = await report(env, store, {
        headline: String(body.headline ?? text).slice(0, 200),
        text,
        urgent: body.urgent === true,
        taskId: typeof body.taskId === "number" ? body.taskId : null,
      });
      return ok({ result: status });
    }
    return new Response("not found", { status: 404 });
  } catch (e) {
    return fail(e);
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const store = new Store(env.DB);

    if (url.pathname === "/tg" && req.method === "POST") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await webhookSecret(env))) {
        return new Response("forbidden", { status: 403 });
      }
      const update = (await req.json().catch(() => ({}))) as { message?: TgMessage };
      // Answer Telegram at once; the AI can take a while.
      if (update.message) ctx.waitUntil(onTelegram(update.message, env, store).catch((e) => console.error("telegram", e)));
      return new Response("ok");
    }

    const tool = /^\/phone\/tool\/([a-z_]+)$/.exec(url.pathname);
    if (tool && req.method === "POST") return handlePhoneTool(req, env, store, tool[1]);

    if (url.pathname === "/admin/setup" && req.method === "POST") {
      if (!(await authorised(req, env))) return new Response("unauthorised", { status: 401 });
      const base = url.origin;
      const lines: string[] = [];
      const tg = new Telegram((env.TELEGRAM_BOT_TOKEN ?? "").trim());
      try {
        await tg.setWebhook(`${base}/tg`, await webhookSecret(env));
        lines.push("Telegram: connected.");
      } catch (e) {
        // Telegram's reason (e.g. "Unauthorized" for a wrong token); never includes the token.
        const why = e instanceof Error ? e.message : String(e);
        lines.push(`Telegram: couldn't connect: ${why}${/unauthori[sz]ed|not found/i.test(why) ? ". The TELEGRAM_BOT_TOKEN secret looks wrong: copy the token from @BotFather again." : ""}`);
      }
      const owner = await store.get("owner_chat");
      // The pairing code is never printed here: setup output can end up in
      // public CI logs. The desktop app shows it (it has the admin key).
      lines.push(owner ? "Telegram chat: linked." : "Telegram chat: not linked yet. Get your pairing code in BEV → Integrations → BEV Cloud.");
      try {
        lines.push(await setupPhone(env, store, base));
      } catch (e) {
        lines.push(`Phone calls: setup failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return new Response(lines.join("\n") + "\n");
    }

    if (url.pathname === "/admin/test-call" && req.method === "POST") {
      if (!(await authorised(req, env))) return new Response("unauthorised", { status: 401 });
      const r = await placeCall(env, store, { headline: "This is a test call to check I can reach you.", details: "Test call." }, fetch, Date.now(), { ignoreGap: true });
      return Response.json(r);
    }

    if (url.pathname.startsWith("/api/")) return api(req, env, store, url.pathname);
    if (url.pathname === "/") return new Response("BEV Cloud is running.\n");
    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(new Runner(env, new Store(env.DB)).runDue().then(() => undefined));
  },
};
