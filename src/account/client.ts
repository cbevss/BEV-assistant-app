/** Talking to the BEV accounts service. */
import { fetch } from "@tauri-apps/plugin-http";
import { native } from "@/lib/native";
import { pkceChallenge, randomString } from "@/integrations/oauth";
import { ACCOUNTS_URL } from "./config";
import type { Vault } from "./crypto";
import type { RemoteItem } from "./sync";

export interface AccountUser {
  id: string;
  name: string;
  avatar: string | null;
  created_at: number;
}

export interface Device {
  id: string;
  device: string;
  created_at: number;
  last_used: number;
  current: boolean;
}

export class AccountError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "AccountError";
  }
}

const base = () => ACCOUNTS_URL.replace(/\/+$/, "");

async function call<T>(path: string, token: string | null, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new AccountError("can't reach the BEV account service (offline?)", 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new AccountError((data as { error?: string } | null)?.error ?? `error ${res.status}`, res.status);
  return data as T;
}

/** Sign in with Discord in the user's browser; returns a session token. */
export async function signInWithDiscord(device: string): Promise<{ token: string; user: AccountUser }> {
  const port = await native.oauthListen();
  const redirect = `http://127.0.0.1:${port}/callback`;
  const verifier = randomString(48);
  const state = randomString(18);
  const q = new URLSearchParams({ redirect, state, challenge: await pkceChallenge(verifier) });
  const { open } = await import("@tauri-apps/plugin-shell");
  await open(`${base()}/auth/discord?${q}`);
  const back = new URLSearchParams(await native.oauthWait(port, 300));
  if (back.get("state") !== state) throw new Error("the sign-in answer didn't match; try again");
  const err = back.get("error");
  if (err) throw new Error(err === "cancelled" ? "sign-in was cancelled" : "Discord sign-in didn't work; try again");
  const code = back.get("code");
  if (!code) throw new Error("no sign-in code came back; try again");
  return call("/auth/token", null, { method: "POST", body: { code, verifier, device } });
}

export const api = {
  me: (t: string) => call<{ user: AccountUser; devices: Device[] }>("/me", t),
  logout: (t: string) => call("/auth/logout", t, { method: "POST" }),
  signOutDevice: (t: string, id: string) => call(`/sessions/${id}`, t, { method: "DELETE" }),
  getVault: async (t: string): Promise<Vault | null> => {
    try {
      return (await call<{ vault: Vault }>("/vault", t)).vault;
    } catch (e) {
      if (e instanceof AccountError && e.status === 404) return null;
      throw e;
    }
  },
  putVault: (t: string, vault: Vault, replace = false) => call("/vault", t, { method: "PUT", body: { vault, replace } }),
  pull: (t: string, since: number) => call<{ items: RemoteItem[]; cursor: number; more: boolean }>(`/sync/pull?since=${since}`, t),
  push: (t: string, items: RemoteItem[]) => call<{ cursor: number }>("/sync/push", t, { method: "POST", body: { items } }),
  exportAll: (t: string) => call<unknown>("/export", t),
  eraseSynced: (t: string, kinds?: string[]) => call<{ erased: number }>("/data/erase", t, { method: "POST", body: kinds ? { kinds } : {} }),
  deleteAccount: (t: string) => call("/account", t, { method: "DELETE" }),
  phoneSend: (t: string, dir: "to_pc" | "to_phone", iv: string, ct: string) => call<{ ok: boolean }>("/phone/messages", t, { method: "POST", body: { dir, iv, ct } }),
  phoneInbox: (t: string, since: number) =>
    call<{ messages: Array<{ id: number; iv: string; ct: string; created_at: number }>; latest: number; live_until?: number; live_display?: string }>(
      `/phone/messages?dir=to_pc&since=${since}`,
      t
    ),
  /** The newest live frame of the screen, for the phone watching it. */
  phoneFrame: (t: string, iv: string, ct: string) => call<{ ok: boolean; seq: number }>("/phone/frame", t, { method: "POST", body: { iv, ct } }),
};
