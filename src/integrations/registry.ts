/** Which connector tools BEV offers right now, from Integrations settings. */
import type { RegisteredTool } from "@/ai/tools";
import { useSettings, type McpServerConfig } from "@/state/settings";
import { homeAssistantTools } from "./homeassistant";
import { githubTools } from "./github";
import { discordTools } from "./discord";
import { spotifyTools } from "./spotify";
import { googleTools } from "./google";
import { McpClient, mcpTools } from "./mcp";

const clients = new Map<string, McpClient>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
export function onMcpChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function mcpClient(id: string): McpClient | undefined {
  return clients.get(id);
}

export async function connectMcp(cfg: McpServerConfig): Promise<number> {
  clients.get(cfg.id)?.disconnect();
  const c = new McpClient(cfg);
  clients.set(cfg.id, c);
  changed();
  try {
    return (await c.connect()).length;
  } finally {
    changed();
  }
}

export function disconnectMcp(id: string) {
  clients.get(id)?.disconnect();
  clients.delete(id);
  changed();
}

/** Connect every enabled MCP server (at start-up). */
export async function startIntegrations() {
  for (const cfg of useSettings.getState().settings.integrations?.mcp ?? []) {
    if (cfg.enabled) connectMcp(cfg).catch(() => {});
  }
}

export function connectorTools(): Record<string, RegisteredTool> {
  const i = useSettings.getState().settings.integrations;
  if (!i) return {};
  return {
    ...(i.homeassistant.enabled && i.homeassistant.url ? homeAssistantTools() : {}),
    ...(i.github.enabled ? githubTools() : {}),
    ...(i.discord?.enabled ? discordTools() : {}),
    ...(i.spotify.enabled && i.spotify.clientId ? spotifyTools() : {}),
    ...(i.google.enabled && i.google.clientId ? googleTools() : {}),
    ...Object.assign({}, ...i.mcp.filter((m) => m.enabled).map((m) => (clients.get(m.id) ? mcpTools(clients.get(m.id)!) : {}))),
  };
}
