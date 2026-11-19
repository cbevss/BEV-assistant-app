/**
 * Phone control encryption, shared with the phone page (accounts/src/phone.ts):
 * AES-GCM with a key derived (HKDF, "bev-phone-v1") from the account's data
 * key, bound to the direction and the account (AAD), so the relay can't read,
 * alter, swap direction or move messages between accounts.
 */
import { fromB64, toB64 } from "./crypto";

const te = new TextEncoder();
const td = new TextDecoder();
export type PhoneDir = "to_pc" | "to_phone";

export async function phoneKey(dek: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", dek, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(new ArrayBuffer(0)), info: te.encode("bev-phone-v1") }, base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

const aad = (dir: PhoneDir, userId: string) => te.encode(`bev-phone:${dir}:${userId}`);

export async function sealPhone(key: CryptoKey, dir: PhoneDir, userId: string, payload: unknown): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(dir, userId) }, key, te.encode(JSON.stringify(payload)));
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function openPhone<T>(key: CryptoKey, dir: PhoneDir, userId: string, iv: string, ct: string): Promise<T> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv), additionalData: aad(dir, userId) }, key, fromB64(ct));
  return JSON.parse(td.decode(pt)) as T;
}

/** What the phone sends. */
export type FromPhone =
  | { type: "ask"; id: string; t: number; text: string }
  | { type: "approve"; id: string; t: number; re: string; allow: boolean }
  | { type: "screen"; id: string; t: number };

const MAX_AGE = 10 * 60_000;

/**
 * Pure: is this a well-formed, fresh message we haven't handled? Old or
 * repeated messages are dropped, so a replayed one does nothing.
 */
export function acceptFromPhone(p: unknown, now: number, seen: ReadonlySet<string>): FromPhone | null {
  if (!p || typeof p !== "object") return null;
  const m = p as Record<string, unknown>;
  if (typeof m.id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(m.id) || seen.has(m.id)) return null;
  if (typeof m.t !== "number" || m.t > now + 60_000 || now - m.t > MAX_AGE) return null;
  if (m.type === "ask" && typeof m.text === "string" && m.text.trim() && m.text.length <= 4000) return { type: "ask", id: m.id, t: m.t, text: m.text.trim() };
  if (m.type === "approve" && typeof m.re === "string" && typeof m.allow === "boolean") return { type: "approve", id: m.id, t: m.t, re: m.re, allow: m.allow };
  if (m.type === "screen") return { type: "screen", id: m.id, t: m.t };
  return null;
}
