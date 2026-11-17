/** HTTP for connectors, through BEV's native side (allow-listed hosts only). */
import { native } from "@/lib/native";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiOptions {
  method?: string;
  /** Sent as "Authorization: Bearer …" unless authHeader says otherwise. */
  token?: string;
  headers?: Record<string, string>;
  /** Objects are sent as JSON; strings as-is. */
  body?: unknown;
  form?: Record<string, string>;
}

export async function apiRaw(url: string, o: ApiOptions = {}) {
  const headers: Record<string, string> = { Accept: "application/json", ...(o.headers ?? {}) };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  let body: string | undefined;
  if (o.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(o.form).toString();
  } else if (o.body !== undefined) {
    if (typeof o.body === "string") body = o.body;
    else {
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
      body = JSON.stringify(o.body);
    }
  }
  return native.integrationFetch(url, o.method ?? (body ? "POST" : "GET"), Object.entries(headers), body);
}

/** Parsed JSON (or null for an empty body); throws ApiError on HTTP errors. */
export async function api<T = unknown>(url: string, o: ApiOptions = {}): Promise<T> {
  const r = await apiRaw(url, o);
  let data: unknown = null;
  if (r.body.trim()) {
    try {
      data = JSON.parse(r.body);
    } catch {
      data = r.body;
    }
  }
  if (r.status >= 400) throw new ApiError(errorText(r.status, data), r.status);
  return data as T;
}

export function errorText(status: number, data: unknown): string {
  if (typeof data === "string") return data.trim() ? `${statusWord(status)}: ${data.slice(0, 200)}` : statusWord(status);
  const d = data as { message?: string; error?: string | { message?: string }; error_description?: string } | null;
  const msg = d?.error_description ?? (typeof d?.error === "string" ? d.error : d?.error?.message) ?? d?.message ?? "";
  const what = statusWord(status);
  return msg ? `${what}: ${msg}` : what;
}

const statusWord = (status: number) =>
  status === 401 ? "not signed in or the token expired" : status === 403 ? "not allowed" : status === 404 ? "not found" : status === 429 ? "too many requests, try again shortly" : `error ${status}`;
