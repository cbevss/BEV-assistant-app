/**
 * End-to-end encryption for BEV's synced memories.
 *
 * - Each account has one random 256-bit data key. It never leaves the user's
 *   devices unwrapped: the server only stores it wrapped (AES-GCM) by a key
 *   derived from the user's passphrase, and separately by their recovery key.
 * - Records are AES-GCM encrypted with a key derived from the data key, bound
 *   to their kind and id (AAD) so the server can't swap them around.
 * - Record ids are HMACs of the local name, so the server doesn't learn memory
 *   names either.
 *
 * Standard WebCrypto only (works in the app, a browser and Node for tests).
 */

const te = new TextEncoder();
const td = new TextDecoder();

export const PASSPHRASE_ITERATIONS = 600_000;
export const RECOVERY_ITERATIONS = 100_000;
export const MIN_PASSPHRASE = 10;

export function toB64(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const random = (n: number) => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));

// --- recovery key ----------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 160 random bits as 32 Crockford base32 characters in groups of four. */
export function newRecoveryKey(): string {
  const bytes = random(20);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join("-");
}

/** Forgive spaces, dashes, lower case and the usual look-alikes (O/0, I/L/1). */
export function normaliseRecoveryKey(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
}

export function looksLikeRecoveryKey(input: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{32}$/.test(normaliseRecoveryKey(input));
}

// --- wrapping the data key -------------------------------------------------

export interface Wrapped {
  salt: string;
  iv: string;
  ct: string;
  iterations: number;
}

export interface Vault {
  v: 1;
  kdf: "PBKDF2-SHA256";
  passphrase: Wrapped;
  recovery: Wrapped;
}

async function kek(secret: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", te.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function wrap(dek: Uint8Array<ArrayBuffer>, secret: string, iterations: number): Promise<Wrapped> {
  const salt = random(16);
  const iv = random(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode("bev-vault-v1") }, await kek(secret, salt, iterations), dek);
  return { salt: toB64(salt), iv: toB64(iv), ct: toB64(ct), iterations };
}

async function unwrap(w: Wrapped, secret: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await kek(secret, fromB64(w.salt), w.iterations);
  try {
    const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(w.iv), additionalData: te.encode("bev-vault-v1") }, key, fromB64(w.ct));
    return new Uint8Array(raw);
  } catch {
    throw new Error("wrong passphrase or recovery key");
  }
}

/** A new data key, wrapped both ways, for a brand-new account. */
export async function createVault(
  passphrase: string,
  recoveryKey: string,
  iterations = { passphrase: PASSPHRASE_ITERATIONS, recovery: RECOVERY_ITERATIONS }
): Promise<{ vault: Vault; dek: Uint8Array<ArrayBuffer> }> {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`use at least ${MIN_PASSPHRASE} characters`);
  const dek = random(32);
  const vault: Vault = {
    v: 1,
    kdf: "PBKDF2-SHA256",
    passphrase: await wrap(dek, passphrase, iterations.passphrase),
    recovery: await wrap(dek, normaliseRecoveryKey(recoveryKey), iterations.recovery),
  };
  return { vault, dek };
}

/** Unlock with the passphrase or the recovery key (whichever was typed). */
export async function unlockVault(vault: Vault, secret: string): Promise<Uint8Array<ArrayBuffer>> {
  if (looksLikeRecoveryKey(secret)) {
    try {
      return await unwrap(vault.recovery, normaliseRecoveryKey(secret));
    } catch {
      /* maybe it's a passphrase that happens to look like a key */
    }
  }
  return unwrap(vault.passphrase, secret);
}

/** A new passphrase for the same data key (everything stays readable). */
export async function rewrapPassphrase(vault: Vault, dek: Uint8Array<ArrayBuffer>, passphrase: string, iterations = PASSPHRASE_ITERATIONS): Promise<Vault> {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`use at least ${MIN_PASSPHRASE} characters`);
  return { ...vault, passphrase: await wrap(dek, passphrase, iterations) };
}

// --- records ---------------------------------------------------------------

export interface RecordKeys {
  enc: CryptoKey;
  id: CryptoKey;
}

/** Separate keys for encrypting records and naming them, from the data key. */
export async function recordKeys(dek: Uint8Array<ArrayBuffer>): Promise<RecordKeys> {
  const base = await crypto.subtle.importKey("raw", dek, "HKDF", false, ["deriveKey"]);
  const salt = new Uint8Array(new ArrayBuffer(0));
  const enc = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: te.encode("bev-records-enc") }, base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const id = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: te.encode("bev-records-id") }, base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, [
    "sign",
  ]);
  return { enc, id };
}

/** Opaque, stable id for a record: the same on every device, meaningless to the server. */
export async function recordId(keys: RecordKeys, kind: string, localName: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", keys.id, te.encode(`${kind}\u0000${localName}`)));
  return toB64(mac.subarray(0, 24)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sealRecord(keys: RecordKeys, kind: string, id: string, payload: unknown): Promise<{ iv: string; ct: string }> {
  const iv = random(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(`${kind}:${id}`) }, keys.enc, te.encode(JSON.stringify(payload)));
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function openRecord<T>(keys: RecordKeys, kind: string, id: string, iv: string, ct: string): Promise<T> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv), additionalData: te.encode(`${kind}:${id}`) }, keys.enc, fromB64(ct));
  return JSON.parse(td.decode(pt)) as T;
}

/** Fingerprint of a record's content, kept locally to spot what changed. */
export async function fingerprint(payload: unknown): Promise<string> {
  return toB64(await crypto.subtle.digest("SHA-256", te.encode(JSON.stringify(payload)))).slice(0, 22);
}
