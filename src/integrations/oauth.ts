/**
 * OAuth sign-in for desktop apps (RFC 8252): PKCE, a one-shot listener on
 * 127.0.0.1, the user's own browser. Tokens go to the OS keyring.
 */
import { native } from "@/lib/native";
import { api } from "./http";

export interface OAuthConfig {
  id: "spotify" | "google";
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  /** Google's desktop clients have a (non-confidential) secret. */
  clientSecret?: string;
  scopes: string[];
  extraAuthParams?: Record<string, string>;
  /** Services that need the exact redirect URI registered get a fixed port. */
  fixedPort?: number;
}

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
}

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export function randomString(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64url(a);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

const secretName = (id: string) => `oauth_${id}`;

async function saveTokens(id: string, t: { access_token: string; refresh_token?: string; expires_in?: number }, keepRefresh?: string) {
  const tokens: Tokens = { access_token: t.access_token, refresh_token: t.refresh_token ?? keepRefresh, expires_at: Date.now() + ((t.expires_in ?? 3600) - 60) * 1000 };
  await native.storeSecret(secretName(id), JSON.stringify(tokens));
}

export async function signIn(c: OAuthConfig): Promise<void> {
  if (!c.clientId.trim()) throw new Error("add the client ID first");
  const port = await native.oauthListen(c.fixedPort);
  const redirect = `http://127.0.0.1:${port}/callback`;
  const verifier = randomString(48);
  const state = randomString(16);
  const params = new URLSearchParams({
    client_id: c.clientId,
    response_type: "code",
    redirect_uri: redirect,
    code_challenge_method: "S256",
    code_challenge: await pkceChallenge(verifier),
    state,
    scope: c.scopes.join(" "),
    ...(c.extraAuthParams ?? {}),
  });
  const { open } = await import("@tauri-apps/plugin-shell");
  await open(`${c.authUrl}?${params}`);
  const q = new URLSearchParams(await native.oauthWait(port, 300));
  if (q.get("error")) throw new Error(`sign-in was cancelled (${q.get("error")})`);
  if (q.get("state") !== state) throw new Error("sign-in answer didn't match (state mismatch); try again");
  const code = q.get("code");
  if (!code) throw new Error("no sign-in code came back");
  const t = await api<{ access_token: string; refresh_token?: string; expires_in?: number }>(c.tokenUrl, {
    form: { grant_type: "authorization_code", code, redirect_uri: redirect, client_id: c.clientId, code_verifier: verifier, ...(c.clientSecret ? { client_secret: c.clientSecret } : {}) },
  });
  await saveTokens(c.id, t);
}

export async function signOut(id: string) {
  await native.deleteSecret(secretName(id));
}

export async function isSignedIn(id: string): Promise<boolean> {
  return !!(await native.getSecret(secretName(id)).catch(() => null));
}

/** A valid access token, refreshing it if needed. */
export async function accessToken(c: OAuthConfig): Promise<string> {
  const raw = await native.getSecret(secretName(c.id));
  if (!raw) throw new Error(`not signed in to ${c.id === "google" ? "Google" : "Spotify"}: sign in from Integrations`);
  const t = JSON.parse(raw) as Tokens;
  if (Date.now() < t.expires_at) return t.access_token;
  if (!t.refresh_token) throw new Error("the sign-in expired: sign in again from Integrations");
  const r = await api<{ access_token: string; refresh_token?: string; expires_in?: number }>(c.tokenUrl, {
    form: { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: c.clientId, ...(c.clientSecret ? { client_secret: c.clientSecret } : {}) },
  });
  await saveTokens(c.id, r, t.refresh_token);
  return r.access_token;
}
