/**
 * Client for BEV Cloud, the always-on half of BEV (Telegram, task tracking,
 * urgent calls). The address is in settings; the key in Windows Credential
 * Manager as "bev_cloud_key".
 */
import { fetch } from "@tauri-apps/plugin-http";
import { native } from "./native";
import { useSettings } from "@/state/settings";

export const CLOUD_KEY_SECRET = "bev_cloud_key";

export interface CloudStatus {
  ok: boolean;
  telegramLinked: boolean;
  calls: boolean;
  timezone: string;
}

export class CloudNotConnected extends Error {
  constructor() {
    super("BEV Cloud isn't connected. Set it up in Integrations → BEV Cloud.");
  }
}

export function normaliseCloudUrl(input: string): string {
  const s = input.trim().replace(/\/+$/, "");
  if (!s) return "";
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  const u = new URL(withScheme);
  if (u.protocol !== "https:") throw new Error("BEV Cloud's address must start with https://");
  return u.origin;
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}, override?: { url: string; key: string }): Promise<T> {
  const url = override?.url ?? useSettings.getState().settings.bevCloudUrl;
  const key = override?.key ?? (await native.getSecret(CLOUD_KEY_SECRET).catch(() => null));
  if (!url || !key) throw new CloudNotConnected();
  const res = await fetch(`${url}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 401) throw new Error("BEV Cloud rejected the key. Check it in Integrations → BEV Cloud.");
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok || data.error) throw new Error(data.error ?? `BEV Cloud answered ${res.status}`);
  return data;
}

export const bevCloud = {
  status: (override?: { url: string; key: string }) => call<CloudStatus>("/api/status", {}, override),
  pairingCode: (override?: { url: string; key: string }) =>
    call<{ linked: boolean; code?: string }>("/api/pairing-code", {}, override),
  listTasks: async (all = false) =>
    (await call<{ tasks: Array<{ id: number; summary: string }> }>(`/api/tasks${all ? "?all=1" : ""}`)).tasks,
  addTask: async (args: Record<string, unknown>) => (await call<{ result: string }>("/api/tasks", { method: "POST", body: args })).result,
  updateTask: async (id: number, args: Record<string, unknown>) =>
    (await call<{ result: string }>(`/api/tasks/${id}`, { method: "PATCH", body: args })).result,
  deleteTask: async (id: number) => (await call<{ result: string }>(`/api/tasks/${id}`, { method: "DELETE" })).result,
  report: async (text: string, urgent = false) => (await call<{ result: string }>("/api/report", { method: "POST", body: { text, urgent } })).result,
};
