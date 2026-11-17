/** Discord through the user's own bot: read channels it's in, post with approval. */
import type { RegisteredTool } from "@/ai/tools";
import { native } from "@/lib/native";
import { api } from "./http";
import { str, clip } from "./args";

export const DISCORD_TOKEN = "discord_bot_token";
const D = "https://discord.com/api/v10";

async function dc<T>(path: string, body?: unknown) {
  const token = await native.getSecret(DISCORD_TOKEN);
  if (!token) throw new Error("Discord isn't set up: add a bot token in Integrations");
  return api<T>(`${D}${path}`, { headers: { Authorization: `Bot ${token}` }, body, method: body === undefined ? "GET" : "POST" });
}
const snowflake = (v: unknown, name: string) => {
  const s = str(String(v ?? ""), name);
  if (!/^\d{5,25}$/.test(s)) throw new Error(`${name} must be a Discord id (from discord_channels)`);
  return s;
};

interface Channel {
  id: string;
  name: string;
  type: number;
}
interface Message {
  id: string;
  content: string;
  timestamp: string;
  author: { username: string; global_name?: string; bot?: boolean };
  attachments?: unknown[];
}

/** One line per message, oldest first. Pure; tested. */
export function formatMessages(ms: Message[]): string {
  return [...ms]
    .reverse()
    .map((m) => `${new Date(m.timestamp).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })} ${m.author.global_name ?? m.author.username}: ${clip(m.content || (m.attachments?.length ? "[attachment]" : ""), 400)}`)
    .join("\n");
}

export function discordTools(): Record<string, RegisteredTool> {
  return {
    discord_channels: {
      spec: { name: "discord_channels", description: "List the Discord servers and text channels BEV's bot can see, with ids.", parameters: { type: "object", properties: {}, required: [] } },
      untrustedOutput: true,
      run: async () => {
        const guilds = await dc<Array<{ id: string; name: string }>>("/users/@me/guilds");
        if (!guilds.length) return "The bot isn't in any server yet: invite it from the Discord developer portal.";
        const parts = await Promise.all(
          guilds.slice(0, 5).map(async (g) => {
            const ch = await dc<Channel[]>(`/guilds/${g.id}/channels`).catch(() => []);
            return `${g.name}: ${ch.filter((c) => c.type === 0 || c.type === 5).map((c) => `#${c.name} (${c.id})`).join(", ") || "no readable channels"}`;
          })
        );
        return parts.join("\n");
      },
    },
    discord_read: {
      spec: {
        name: "discord_read",
        description: "Read the latest messages in a Discord channel by id (from discord_channels).",
        parameters: { type: "object", properties: { channel_id: { type: "string" }, limit: { type: "number" } }, required: ["channel_id"] },
      },
      untrustedOutput: true,
      run: async (a) => {
        const n = Math.min(50, Math.max(1, Number(a.limit) || 20));
        const ms = await dc<Message[]>(`/channels/${snowflake(a.channel_id, "channel_id")}/messages?limit=${n}`);
        return ms.length ? formatMessages(ms) : "No messages.";
      },
    },
    discord_send: {
      spec: {
        name: "discord_send",
        description: "Post a message in a Discord channel as BEV's bot (the user confirms first).",
        parameters: { type: "object", properties: { channel_id: { type: "string" }, text: { type: "string" } }, required: ["channel_id", "text"] },
        sensitive: true,
      },
      run: async (a) => {
        const text = str(a.text, "text");
        if (text.length > 2000) throw new Error("Discord messages are limited to 2000 characters");
        await dc(`/channels/${snowflake(a.channel_id, "channel_id")}/messages`, { content: text, allowed_mentions: { parse: [] } });
        return "Posted.";
      },
    },
  };
}

export async function testDiscord(): Promise<string> {
  const me = await dc<{ username: string }>("/users/@me");
  const guilds = await dc<unknown[]>("/users/@me/guilds");
  return `Connected as ${me.username}, in ${guilds.length} server${guilds.length === 1 ? "" : "s"}.`;
}
