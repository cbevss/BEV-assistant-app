/**
 * MCP (Model Context Protocol) client: lets BEV use tools from MCP servers the
 * user adds, either local programs (stdio) or remote URLs (Streamable HTTP).
 * Their tools are offered to the AI as mcp_<server>_<tool>. Results are
 * treated as outside content, and by default each action asks first.
 */
import type { RegisteredTool } from "@/ai/tools";
import { native } from "@/lib/native";
import type { McpServerConfig } from "@/state/settings";
import { apiRaw, errorText } from "./http";
import { clip } from "./args";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export type McpStatus = { state: "off" } | { state: "connecting" } | { state: "ready"; tools: McpTool[] } | { state: "error"; message: string };

const PROTOCOL = "2025-06-18";
export const mcpSecret = (id: string) => `mcp_${id}_token`;

/** "My Server!" → "my_server" (tool names must match ^[a-zA-Z0-9_-]{1,64}$). */
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20) || "server";
export const toolKey = (server: string, tool: string) => `mcp_${slug(server)}_${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);

/** Parse a Streamable-HTTP reply: plain JSON, or SSE whose data lines carry JSON. Pure; tested. */
export function parseRpcBody(body: string, contentType: string, id: number): unknown {
  if (contentType.includes("text/event-stream")) {
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (msg.id === id) return msg;
      } catch {
        /* skip */
      }
    }
    throw new Error("the server's reply had no answer");
  }
  return JSON.parse(body);
}

/** Text of a tools/call result. Pure; tested. */
export function resultText(r: { content?: Array<{ type: string; text?: string; resource?: { text?: string; uri?: string } }>; isError?: boolean; structuredContent?: unknown }): string {
  const parts = (r.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : c.type === "resource" ? c.resource?.text ?? c.resource?.uri ?? "" : `[${c.type} not shown]`));
  let text = parts.filter(Boolean).join("\n");
  if (!text && r.structuredContent !== undefined) text = JSON.stringify(r.structuredContent);
  return r.isError ? `error: ${text || "the tool failed"}` : text || "(no output)";
}

export class McpClient {
  private nextId = 1;
  private session: string | null = null;
  status: McpStatus = { state: "off" };

  constructor(readonly cfg: McpServerConfig) {}

  private async rpc(method: string, params?: unknown, notify = false): Promise<unknown> {
    const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    const id = notify ? undefined : this.nextId++;
    if (id !== undefined) msg.id = id;
    if (this.cfg.transport === "stdio") {
      const reply = await native.mcpSend(this.cfg.id, JSON.stringify(msg), method === "tools/call" ? 300 : 60);
      if (notify) return null;
      const r = JSON.parse(reply ?? "null");
      if (r?.error) throw new Error(r.error.message ?? "the server returned an error");
      return r?.result;
    }
    const token = await native.getSecret(mcpSecret(this.cfg.id)).catch(() => null);
    const headers: Record<string, string> = { Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL };
    if (this.session) headers["Mcp-Session-Id"] = this.session;
    const res = await apiRaw(this.cfg.url ?? "", { body: msg, headers, token: token ?? undefined, method: "POST" });
    const sid = res.headers.find(([k]) => k === "mcp-session-id")?.[1];
    if (sid) this.session = sid;
    if (res.status >= 400) throw new Error(errorText(res.status, res.body));
    if (notify || id === undefined) return null;
    const r = parseRpcBody(res.body, res.content_type, id) as { result?: unknown; error?: { message?: string } };
    if (r.error) throw new Error(r.error.message ?? "the server returned an error");
    return r.result;
  }

  async connect(): Promise<McpTool[]> {
    this.status = { state: "connecting" };
    try {
      if (this.cfg.transport === "stdio") {
        if (!this.cfg.command) throw new Error("no command set");
        await native.mcpSpawn(this.cfg.id, this.cfg.command, this.cfg.args ?? []);
      } else if (!this.cfg.url) throw new Error("no URL set");
      await this.rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "BEV", version: "1" } });
      await this.rpc("notifications/initialized", undefined, true);
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const r = (await this.rpc("tools/list", cursor ? { cursor } : {})) as { tools?: McpTool[]; nextCursor?: string };
        tools.push(...(r?.tools ?? []));
        if (!r?.nextCursor) break;
        cursor = r.nextCursor;
      }
      this.status = { state: "ready", tools };
      return tools;
    } catch (e) {
      this.status = { state: "error", message: e instanceof Error ? e.message : String(e) };
      if (this.cfg.transport === "stdio") native.mcpKill(this.cfg.id).catch(() => {});
      throw e;
    }
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const r = (await this.rpc("tools/call", { name, arguments: args })) as Parameters<typeof resultText>[0];
    return clip(resultText(r ?? {}), 8000);
  }

  disconnect() {
    if (this.cfg.transport === "stdio") native.mcpKill(this.cfg.id).catch(() => {});
    this.status = { state: "off" };
    this.session = null;
  }
}

/** Turn a connected server's tools into BEV tools. */
export function mcpTools(client: McpClient): Record<string, RegisteredTool> {
  if (client.status.state !== "ready") return {};
  const out: Record<string, RegisteredTool> = {};
  for (const t of client.status.tools) {
    const key = toolKey(client.cfg.name, t.name);
    const readOnly = t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true;
    out[key] = {
      spec: {
        name: key,
        description: clip(`[${client.cfg.name}] ${t.description ?? t.annotations?.title ?? t.name}`, 1000),
        parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        sensitive: client.cfg.confirmActions && !readOnly,
      },
      untrustedOutput: true,
      timeoutMs: 300_000,
      run: (args) => client.call(t.name, args),
    };
  }
  return out;
}
