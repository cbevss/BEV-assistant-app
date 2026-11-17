/** Home Assistant: read and control the user's smart home over its REST API. */
import type { RegisteredTool } from "@/ai/tools";
import { native } from "@/lib/native";
import { useSettings } from "@/state/settings";
import { api } from "./http";
import { str, optStr, clip } from "./args";

export const HA_TOKEN = "homeassistant_token";

interface HaState {
  entity_id: string;
  state: string;
  attributes: { friendly_name?: string; unit_of_measurement?: string; [k: string]: unknown };
}

const base = () => useSettings.getState().settings.integrations.homeassistant.url.replace(/\/+$/, "");
async function token() {
  const t = await native.getSecret(HA_TOKEN);
  if (!t) throw new Error("Home Assistant isn't set up: add its address and a long-lived token in Integrations");
  return t;
}
const ha = async <T>(path: string, body?: unknown) => api<T>(`${base()}/api/${path}`, { token: await token(), body, method: body === undefined ? "GET" : "POST" });

export const describeState = (s: HaState) =>
  `${s.attributes.friendly_name ?? s.entity_id} (${s.entity_id}): ${s.state}${s.attributes.unit_of_measurement ? ` ${s.attributes.unit_of_measurement}` : ""}`;

/** Find entities by name/id words. Pure; tested. */
export function matchEntities(states: HaState[], query: string, limit = 40): HaState[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = states
    .map((s) => {
      const hay = `${s.entity_id} ${s.attributes.friendly_name ?? ""}`.toLowerCase().replace(/_/g, " ");
      return { s, score: words.length ? words.filter((w) => hay.includes(w)).length / words.length : 1 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  // If some match every word, show only those.
  const best = scored[0]?.score ?? 0;
  return scored.filter((x) => best < 1 || x.score === 1).slice(0, limit).map((x) => x.s);
}

/** Which HA service an action maps to for this entity. Pure; tested. */
export function serviceFor(entityId: string, action: string, value?: string): { domain: string; service: string; data: Record<string, unknown> } {
  const domain = entityId.split(".")[0];
  const data: Record<string, unknown> = { entity_id: entityId };
  const onOff = (svc: string) => ({ domain: ["scene", "script"].includes(domain) ? domain : domain, service: svc, data });
  switch (action) {
    case "on":
      return ["scene", "script", "automation"].includes(domain) ? { domain, service: domain === "automation" ? "trigger" : "turn_on", data } : onOff("turn_on");
    case "off":
      return onOff("turn_off");
    case "toggle":
      return onOff("toggle");
    case "open":
      return { domain, service: domain === "lock" ? "unlock" : "open_cover", data };
    case "close":
      return { domain, service: domain === "lock" ? "lock" : "close_cover", data };
    case "lock":
      return { domain: "lock", service: "lock", data };
    case "unlock":
      return { domain: "lock", service: "unlock", data };
    case "set": {
      if (value === undefined) throw new Error('"set" needs a value');
      const n = Number(value);
      if (domain === "climate") return { domain, service: "set_temperature", data: { ...data, temperature: n } };
      if (domain === "light") return { domain, service: "turn_on", data: { ...data, brightness_pct: n } };
      if (domain === "fan") return { domain, service: "set_percentage", data: { ...data, percentage: n } };
      if (domain === "media_player") return { domain, service: "volume_set", data: { ...data, volume_level: Math.max(0, Math.min(1, n / 100)) } };
      if (domain === "cover") return { domain, service: "set_cover_position", data: { ...data, position: n } };
      if (domain === "input_number" || domain === "number") return { domain, service: "set_value", data: { ...data, value: n } };
      if (domain === "input_select" || domain === "select") return { domain, service: "select_option", data: { ...data, option: value } };
      throw new Error(`BEV doesn't know how to set a value on ${domain}`);
    }
    default:
      throw new Error(`unknown action "${action}"`);
  }
}

/** Doors, locks, alarms and garage covers always ask first. */
export function haSensitive(entityId: string, action: string): boolean {
  const domain = entityId.split(".")[0];
  if (domain === "lock" || domain === "alarm_control_panel") return true;
  if (domain === "cover" && /garage|gate|door/i.test(entityId) && action !== "close") return true;
  return false;
}

export function homeAssistantTools(): Record<string, RegisteredTool> {
  return {
    home_find: {
      spec: {
        name: "home_find",
        description: "Find smart-home devices and sensors in Home Assistant by name (e.g. 'living room light', 'temperature'), with their current state.",
        parameters: { type: "object", properties: { query: { type: "string", description: "words to match; empty lists everything" } }, required: [] },
      },
      untrustedOutput: true,
      run: async (a) => {
        const states = await ha<HaState[]>("states");
        const hits = matchEntities(states, optStr(a.query) ?? "");
        return hits.length ? hits.map(describeState).join("\n") : "No matching devices.";
      },
    },
    home_control: {
      spec: {
        name: "home_control",
        description:
          "Control a Home Assistant device by entity_id (from home_find): on, off, toggle, open, close, lock, unlock, or set with a value (brightness %, temperature, volume %, position %, option). Report the new state it returns.",
        parameters: {
          type: "object",
          properties: {
            entity_id: { type: "string" },
            action: { type: "string", enum: ["on", "off", "toggle", "open", "close", "lock", "unlock", "set"] },
            value: { type: "string" },
          },
          required: ["entity_id", "action"],
        },
      },
      sensitiveFor: (a) => haSensitive(String(a.entity_id ?? ""), String(a.action ?? "")),
      run: async (a) => {
        const id = str(a.entity_id, "entity_id");
        const { domain, service, data } = serviceFor(id, str(a.action, "action"), optStr(a.value));
        await ha(`services/${domain}/${service}`, data);
        await new Promise((r) => setTimeout(r, 600));
        const now = await ha<HaState>(`states/${encodeURIComponent(id)}`).catch(() => null);
        return now ? `Done. Now: ${describeState(now)}` : `Sent ${domain}.${service}; couldn't read the new state back.`;
      },
    },
    home_history: {
      spec: {
        name: "home_history",
        description: "How a Home Assistant sensor or device changed over the last N hours (default 24).",
        parameters: { type: "object", properties: { entity_id: { type: "string" }, hours: { type: "number" } }, required: ["entity_id"] },
      },
      untrustedOutput: true,
      run: async (a) => {
        const id = str(a.entity_id, "entity_id");
        const hours = Math.min(168, Math.max(1, Number(a.hours) || 24));
        const since = new Date(Date.now() - hours * 3600_000).toISOString();
        const h = await ha<HaState[][]>(`history/period/${since}?filter_entity_id=${encodeURIComponent(id)}&minimal_response`);
        const rows = (h[0] ?? []) as Array<HaState & { last_changed?: string }>;
        if (!rows.length) return "No history for that.";
        return clip(rows.slice(-30).map((r) => `${r.last_changed ? new Date(r.last_changed).toLocaleString("en-GB") : ""}: ${r.state}`).join("\n"), 3000);
      },
    },
  };
}

export async function testHomeAssistant(): Promise<string> {
  const r = await ha<{ message?: string }>("");
  const n = (await ha<HaState[]>("states")).length;
  return `${r?.message ?? "Connected"}: ${n} entities.`;
}
