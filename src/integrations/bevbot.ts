/**
 * BEV bot (owner link): this app controls the BEV Discord bot, for the bot's
 * owner only. The owner DMs the bot "link", pastes the one-time code in
 * Integrations → BEV bot, and the bot hands this PC a device token (kept in
 * the OS keyring; the bot only stores its hash). Nobody else can get a code.
 *
 * Both ways:
 * - tools: every server's features and settings, the global switches, website
 *   buttons, posting, the bot's status, leaving a server;
 * - the bot tells BEV what happens (servers joining/leaving, errors), raised
 *   as notices and given to the daily briefing;
 * - the owner can DM the bot "pc <anything>" from anywhere: BEV runs it here
 *   and DMs back the answer. Anything that needs approval is declined (nobody
 *   is at the PC to OK it); phone control is for that.
 */
import type { RegisteredTool } from "@/ai/tools";
import { native } from "@/lib/native";
import { useSettings } from "@/state/settings";
import { useAssistant } from "@/state/assistant";
import { Orchestrator } from "@/ai/orchestrator";
import { makeAssistantProvider } from "@/ai/factory";
import { raise } from "@/proactive/notices";
import { api } from "./http";
import { str, clip } from "./args";

export const BEVBOT_TOKEN = "bevbot_owner_token";
const CURSOR_KEY = "bev.bevbot.eventCursor";
const POLL_MS = 20_000;

export const botUrl = () => (useSettings.getState().settings.integrations.bevbot?.url ?? "").trim().replace(/\/+$/, "");

async function bot<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const base = botUrl();
  const token = await native.getSecret(BEVBOT_TOKEN);
  if (!base || !token) throw new Error("The BEV bot isn't linked: Integrations → BEV bot");
  return api<T>(`${base}${path}`, { token, body, method: method ?? (body === undefined ? "GET" : "POST") });
}

/** Pairs this PC with a code from the bot's DMs. */
export async function linkBot(url: string, code: string): Promise<string> {
  const base = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new Error("Give the bot's address, e.g. https://bev-bot.onrender.com");
  await native.integrationAllowOrigin(base);
  const r = await api<{ token: string; version: string }>(`${base}/api/owner/link`, { body: { code: code.trim(), device: "BEV assistant" } });
  await native.storeSecret(BEVBOT_TOKEN, r.token);
  return `Linked to BEV ${r.version}.`;
}

export async function unlinkBot() {
  await bot("/api/owner/unlink", {}).catch(() => {});
  await native.deleteSecret(BEVBOT_TOKEN).catch(() => {});
}

interface Overview {
  online: boolean;
  version: string;
  uptime_s: number;
  latency_ms: number | null;
  server_count: number;
  member_count: number;
  servers: Array<{ id: string; name: string; members: number }>;
  global_off: string[];
  recent_errors: Array<{ at: number; kind: string; message: string; area: string }>;
}

/** Pure; tested. */
export function describeOverview(o: Overview): string {
  const up = o.uptime_s >= 86400 ? `${Math.floor(o.uptime_s / 86400)}d` : `${Math.floor(o.uptime_s / 3600)}h`;
  const lines = [
    `BEV ${o.version}: ${o.online ? "online" : "OFFLINE"}, up ${up}${o.latency_ms ? `, ${o.latency_ms} ms` : ""}. ${o.server_count} servers, ${o.member_count.toLocaleString("en-GB")} members.`,
    `Servers (id): ${o.servers.slice(0, 40).map((s) => `${s.name} (${s.id}, ${s.members})`).join("; ")}${o.servers.length > 40 ? "; …" : ""}`,
  ];
  if (o.global_off.length) lines.push(`Switched off everywhere: ${o.global_off.join(", ")}`);
  if (o.recent_errors.length) lines.push(`Latest errors: ${o.recent_errors.map((e) => `${e.kind}: ${clip(e.message, 100)}`).join(" | ")}`);
  return lines.join("\n");
}

interface Setting {
  key: string;
  label?: string;
  name?: string;
  kind?: string;
  value?: unknown;
  options?: unknown[];
}
interface Feature {
  key: string;
  name: string;
  enabled: boolean;
  setup_ok: boolean;
  category: string;
  settings: Setting[];
}
interface Config {
  guild: { name: string };
  features: Feature[];
  channels: Array<{ id: string; name: string; type: string }>;
  roles: Array<{ id: string; name: string }>;
}

/** Pure; tested. One feature in detail, or every feature in a line each. */
export function describeConfig(c: Config, feature?: string): string {
  if (feature) {
    const f = c.features.find((x) => x.key === feature || x.name.toLowerCase() === feature.toLowerCase());
    if (!f) return `No feature "${feature}". Features: ${c.features.map((x) => x.key).join(", ")}`;
    const opts = (s: Setting) => (Array.isArray(s.options) && s.options.length ? ` options ${JSON.stringify(s.options).slice(0, 200)}` : "");
    return [
      `${c.guild.name} → ${f.name} (${f.key}): ${f.enabled ? "on" : "off"}${f.enabled && !f.setup_ok ? ", needs setting up" : ""}`,
      ...f.settings.map((s) => `- ${s.key} [${s.kind ?? "?"}] ${s.label ?? s.name ?? ""} = ${clip(JSON.stringify(s.value ?? null), 150)}${opts(s)}`),
      `Channels: ${c.channels.slice(0, 60).map((x) => `#${x.name}=${x.id}`).join(" ")}`,
      `Roles: ${c.roles.slice(0, 40).map((x) => `${x.name}=${x.id}`).join(" ")}`,
    ].join("\n");
  }
  return `${c.guild.name}:\n${c.features.map((f) => `${f.enabled ? "●" : "○"} ${f.key} (${f.name})`).join("\n")}`;
}

const id = (v: unknown, name: string) => {
  const s = String(v ?? "").trim();
  if (!/^\d{5,25}$/.test(s)) throw new Error(`${name} must be a Discord id (from bev_bot_overview)`);
  return s;
};

export function bevBotTools(): Record<string, RegisteredTool> {
  return {
    bev_bot_overview: {
      spec: {
        name: "bev_bot_overview",
        description: "The user's own Discord bot, BEV: online status, version, uptime, every server it's in (with ids), features switched off everywhere, latest errors. Use first for anything about 'my bot' / 'the bev bot'.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      untrustedOutput: true,
      run: async () => describeOverview(await bot<Overview>("/api/owner/overview")),
    },
    bev_bot_server_config: {
      spec: {
        name: "bev_bot_server_config",
        description: "BEV bot's setup in one server: every feature on/off, or with feature, that feature's settings (keys, types, current values, options) plus the server's channels and roles with ids. Read before changing anything.",
        parameters: { type: "object", properties: { guild_id: { type: "string" }, feature: { type: "string", description: "feature key, e.g. leveling" } }, required: ["guild_id"] },
      },
      untrustedOutput: true,
      run: async (a) => describeConfig(await bot<Config>(`/api/owner/config?guild_id=${id(a.guild_id, "guild_id")}`), a.feature ? String(a.feature) : undefined),
    },
    bev_bot_configure: {
      spec: {
        name: "bev_bot_configure",
        description: "Change BEV bot in one server, like its website dashboard: switch features on/off ({features:{leveling:true}}) and/or set settings by key ({settings:{welcome_channel:'123…'}}). Everything is checked first; nothing is saved if any value is wrong. Switching a feature off deletes channels/roles BEV made for it unless its key is in keep.",
        parameters: {
          type: "object",
          properties: {
            guild_id: { type: "string" },
            features: { type: "object", description: "feature key → true/false" },
            settings: { type: "object", description: "setting key → value" },
            keep: { type: "array", items: { type: "string" }, description: "features switched off that keep what BEV made" },
          },
          required: ["guild_id"],
        },
        sensitive: true,
      },
      run: async (a) => {
        const r = await bot<{ notes: string[] }>("/api/owner/config", { guild_id: id(a.guild_id, "guild_id"), features: a.features ?? {}, settings: a.settings ?? {}, keep: a.keep ?? [] });
        return ["Saved.", ...r.notes].join("\n");
      },
    },
    bev_bot_global_feature: {
      spec: {
        name: "bev_bot_global_feature",
        description: "Owner kill switch for a BEV bot feature in EVERY server: mode on, off, or except (off everywhere except the guild ids in keep). Commands follow within a minute.",
        parameters: { type: "object", properties: { key: { type: "string" }, mode: { type: "string", enum: ["on", "off", "except"] }, keep: { type: "array", items: { type: "string" } } }, required: ["key", "mode"] },
        sensitive: true,
      },
      run: async (a) => {
        await bot("/api/owner/features", { key: str(a.key, "key"), mode: str(a.mode, "mode"), keep: a.keep ?? [] });
        return `${a.key} is now ${a.mode} across BEV.`;
      },
    },
    bev_bot_actions: {
      spec: {
        name: "bev_bot_actions",
        description: "List BEV bot's dashboard buttons available in a server (feature, action key, label): e.g. post the rules, send a designed message, reset XP.",
        parameters: { type: "object", properties: { guild_id: { type: "string" } }, required: ["guild_id"] },
      },
      run: async (a) => {
        const r = await bot<{ actions: Array<{ feature: string; key: string; label: string }> }>(`/api/owner/actions?guild_id=${id(a.guild_id, "guild_id")}`);
        return r.actions.map((x) => `${x.feature}/${x.key}: ${x.label}`).join("\n") || "No buttons here.";
      },
    },
    bev_bot_action: {
      spec: {
        name: "bev_bot_action",
        description: "Press one of BEV bot's dashboard buttons in a server (from bev_bot_actions), with any values it asks for.",
        parameters: { type: "object", properties: { guild_id: { type: "string" }, feature: { type: "string" }, action: { type: "string" }, values: { type: "object" } }, required: ["guild_id", "feature", "action"] },
        sensitive: true,
      },
      run: async (a) => {
        const r = await bot<{ note?: string }>("/api/owner/action", { guild_id: id(a.guild_id, "guild_id"), feature: str(a.feature, "feature"), action: str(a.action, "action"), values: a.values ?? {} });
        return r.note || "Done.";
      },
    },
    bev_bot_say: {
      spec: {
        name: "bev_bot_say",
        description: "Post a message as BEV bot in any channel of any of its servers (channel id from bev_bot_server_config). No pings.",
        parameters: { type: "object", properties: { channel_id: { type: "string" }, text: { type: "string" } }, required: ["channel_id", "text"] },
        sensitive: true,
      },
      run: async (a) => {
        const text = str(a.text, "text");
        if (text.length > 2000) throw new Error("Discord messages are limited to 2000 characters");
        const r = await bot<{ url: string }>("/api/owner/say", { channel_id: id(a.channel_id, "channel_id"), text });
        return `Posted: ${r.url}`;
      },
    },
    bev_bot_status: {
      spec: {
        name: "bev_bot_status",
        description: "Set BEV bot's custom status shown in member lists (stays until cleared). Empty text goes back to its rotating statuses.",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        sensitive: true,
      },
      run: async (a) => {
        const r = await bot<{ pinned: string | null }>("/api/owner/presence", { text: String(a.text ?? "") });
        return r.pinned ? `Status set: ${r.pinned}` : "Back to the rotating statuses.";
      },
    },
    bev_bot_leave_server: {
      spec: {
        name: "bev_bot_leave_server",
        description: "Make BEV bot leave a server for good (it has to be invited back).",
        parameters: { type: "object", properties: { guild_id: { type: "string" } }, required: ["guild_id"] },
        sensitive: true,
      },
      run: async (a) => `Left ${(await bot<{ left: string }>("/api/owner/leave", { guild_id: id(a.guild_id, "guild_id") })).left}.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Bot → PC: events become notices; "pc …" DMs run here.

interface BotEvent {
  id: number;
  kind: string;
  text: string;
}

/** Pure; tested. Errors are grouped; server changes and links each get a notice. */
export function noticeFor(e: BotEvent): { title: string; body: string; key: string } {
  const title = e.kind === "error" ? "BEV bot hit an error" : e.kind === "server" ? "BEV bot servers" : e.kind === "link" ? "BEV bot: new device linked" : "BEV bot";
  return { title, body: e.text, key: e.kind === "error" ? `bevbot:error:${e.text.slice(0, 60)}` : `bevbot:${e.id}` };
}

const recentEvents: string[] = [];
/** For the briefing: what the bot said since BEV started. */
export function botEventsForPrompt(): string {
  return recentEvents.length ? `The user's Discord bot (BEV) reported: ${recentEvents.slice(-8).join(" | ")}` : "";
}

let orch: Orchestrator | null = null;
async function runJob(text: string): Promise<string> {
  const s = useSettings.getState().settings;
  orch ??= new Orchestrator(
    makeAssistantProvider(s),
    {
      onState: () => {},
      onAssistantText: () => {},
      onToolResult: (name, ok, result) => useAssistant.getState().pushMessage({ role: "tool", content: result, toolName: name, ok }),
      // Nobody is at the PC to OK it, and a Discord DM is no place for approvals.
      requestApproval: async () => false,
    },
    { remote: true },
  );
  orch.setProvider(makeAssistantProvider(s));
  useAssistant.getState().pushMessage({ role: "user", content: `(from Discord) ${text}` });
  const reply = (await orch.send(text)) || "Done.";
  useAssistant.getState().pushMessage({ role: "assistant", content: reply });
  return reply;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let busy = false;
async function tick() {
  const i = useSettings.getState().settings.integrations.bevbot;
  if (i?.enabled && botUrl() && !busy) {
    busy = true;
    try {
      const after = Number(localStorage.getItem(CURSOR_KEY) ?? 0);
      const { events } = await bot<{ events: BotEvent[] }>(`/api/owner/events?after=${after}`);
      for (const e of events) {
        recentEvents.push(e.text);
        if (recentEvents.length > 30) recentEvents.shift();
        // The first time, only the latest few are worth a notice.
        if (after > 0 || e === events[events.length - 1]) {
          const n = noticeFor(e);
          await raise("task", n.title, n.body, { key: n.key, cooldownMs: 3600_000 });
        }
      }
      if (events.length) localStorage.setItem(CURSOR_KEY, String(events[events.length - 1].id));
      const { jobs } = await bot<{ jobs: Array<{ id: number; text: string }> }>("/api/owner/inbox");
      for (const j of jobs) {
        let reply: string;
        try {
          reply = await runJob(j.text);
        } catch (e) {
          reply = `Couldn't do that: ${e instanceof Error ? e.message : String(e)}`;
        }
        await bot("/api/owner/inbox/reply", { id: j.id, text: clip(reply, 5800) }).catch(() => {});
      }
    } catch {
      /* offline or unlinked: try again next time */
    } finally {
      busy = false;
    }
  }
  timer = setTimeout(() => void tick(), POLL_MS);
}

/** Start listening to the bot (does nothing until it's linked and switched on). */
export function startBevBotLink() {
  if (timer) return;
  timer = setTimeout(() => void tick(), 4000);
}
