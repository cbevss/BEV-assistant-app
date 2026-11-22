/**
 * Your bank card, for BEV to autofill checkout forms.
 *
 * - Stored only on this PC (card.json), never synced or sent anywhere, and
 *   never shown to the AI: BEV only ever sees "•••• 1234".
 * - Encrypted with AES-256-GCM under a key derived from your secret password
 *   (PBKDF2-SHA256, 600,000 rounds, random salt). Without the password the
 *   file is unreadable; BEV doesn't keep the password.
 * - Every autofill asks for the password in a pop-up. Unlocked details live in
 *   memory for two minutes (to fill the number, expiry and so on), then are
 *   wiped. Five wrong passwords lock it for five minutes.
 */
import { create } from "zustand";
import { load, type Store } from "@tauri-apps/plugin-store";

export interface CardDetails {
  number: string;
  name: string;
  /** "MM/YY" */
  expiry: string;
  /** Optional; leave empty to type it yourself each time. */
  cvc: string;
}

export interface SealedCard {
  v: 1;
  salt: string;
  iv: string;
  data: string;
  last4: string;
  brand: string;
}

const ROUNDS = 600_000;
const UNLOCK_MS = 2 * 60_000;
const MAX_TRIES = 5;
const LOCKOUT_MS = 5 * 60_000;
export const MIN_PASSWORD = 6;

const te = new TextEncoder();
const td = new TextDecoder();
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ROUNDS },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export const digitsOnly = (s: string) => s.replace(/\D/g, "");

/** Luhn check: catches most typos in a card number. */
export function luhnOk(number: string): boolean {
  const d = digitsOnly(number);
  if (d.length < 12 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = +d[d.length - 1 - i];
    if (i % 2) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

export function cardBrand(number: string): string {
  const d = digitsOnly(number);
  if (/^4/.test(d)) return "Visa";
  if (/^(5[1-5]|2[2-7])/.test(d)) return "Mastercard";
  if (/^3[47]/.test(d)) return "Amex";
  if (/^6(011|5)/.test(d)) return "Discover";
  return "Card";
}

/** Problems with the details, or [] if they look right. */
export function validateCard(c: CardDetails): string[] {
  const out: string[] = [];
  if (!luhnOk(c.number)) out.push("That card number doesn't look right.");
  const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(c.expiry.trim());
  if (!m || +m[1] < 1 || +m[1] > 12) out.push("Enter the expiry as MM/YY.");
  if (c.cvc && !/^\d{3,4}$/.test(c.cvc.trim())) out.push("The security code is 3 or 4 digits.");
  return out;
}

export async function sealCard(c: CardDetails, password: string): Promise<SealedCard> {
  if (password.length < MIN_PASSWORD) throw new Error(`Use a secret password of at least ${MIN_PASSWORD} characters.`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const clean: CardDetails = { number: digitsOnly(c.number), name: c.name.trim(), expiry: c.expiry.replace(/\s/g, ""), cvc: c.cvc.trim() };
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(clean)));
  return { v: 1, salt: b64(salt), iv: b64(iv), data: b64(data), last4: clean.number.slice(-4), brand: cardBrand(clean.number) };
}

/** Decrypt, or throw "wrong password". */
export async function openCard(s: SealedCard, password: string): Promise<CardDetails> {
  const key = await deriveKey(password, unb64(s.salt));
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv) }, key, unb64(s.data));
    return JSON.parse(td.decode(plain)) as CardDetails;
  } catch {
    throw new Error("Wrong password.");
  }
}

// --- storage ---------------------------------------------------------------

let kv: Store | null = null;
const store = async () => (kv ??= await load("card.json", { autoSave: true }));

export async function loadSealed(): Promise<SealedCard | null> {
  return ((await (await store()).get<SealedCard>("card")) ?? null) as SealedCard | null;
}
export async function saveCard(c: CardDetails, password: string): Promise<SealedCard> {
  const sealed = await sealCard(c, password);
  await (await store()).set("card", sealed);
  lock();
  return sealed;
}
export async function removeCard(): Promise<void> {
  await (await store()).delete("card");
  lock();
}

// --- unlocking -------------------------------------------------------------

let unlocked: { card: CardDetails; until: number } | null = null;
let wipeTimer: ReturnType<typeof setTimeout> | undefined;
let tries = 0;
let lockedUntil = 0;

export function lock() {
  unlocked = null;
  clearTimeout(wipeTimer);
}

/** Try a password. Counts wrong guesses and locks out after too many. */
export async function unlockWith(password: string, now = Date.now()): Promise<CardDetails> {
  if (now < lockedUntil) throw new Error(`Too many wrong passwords. Try again in ${Math.ceil((lockedUntil - now) / 60_000)} min.`);
  const sealed = await loadSealed();
  if (!sealed) throw new Error("No card saved.");
  try {
    const card = await openCard(sealed, password);
    tries = 0;
    unlocked = { card, until: now + UNLOCK_MS };
    clearTimeout(wipeTimer);
    wipeTimer = setTimeout(lock, UNLOCK_MS);
    return card;
  } catch (e) {
    tries++;
    if (tries >= MAX_TRIES) {
      tries = 0;
      lockedUntil = now + LOCKOUT_MS;
      throw new Error("Too many wrong passwords. Locked for 5 minutes.");
    }
    throw e;
  }
}

export function unlockedCard(now = Date.now()): CardDetails | null {
  return unlocked && now < unlocked.until ? unlocked.card : null;
}

// --- the password pop-up -----------------------------------------------------

interface CardPrompt {
  /** What BEV wants to do, shown in the pop-up. */
  reason: string;
  resolve: (ok: boolean) => void;
}
export const useCardPrompt = create<{ prompt: CardPrompt | null }>(() => ({ prompt: null }));

/** Show the password pop-up; resolves true once the card is unlocked, false if cancelled. */
export function askToUnlock(reason: string): Promise<boolean> {
  if (unlockedCard()) return Promise.resolve(true);
  const prev = useCardPrompt.getState().prompt;
  prev?.resolve(false);
  return new Promise((resolve) => useCardPrompt.setState({ prompt: { reason, resolve } }));
}

export function answerPrompt(ok: boolean) {
  const p = useCardPrompt.getState().prompt;
  useCardPrompt.setState({ prompt: null });
  p?.resolve(ok);
}

/** Turn the expiry into the shape a form wants. */
export function expiryAs(expiry: string, part: "full" | "month" | "year" | "year4"): string {
  const [mm = "", yy = ""] = expiry.split("/");
  if (part === "month") return mm;
  if (part === "year") return yy;
  if (part === "year4") return `20${yy}`;
  return `${mm}/${yy}`;
}
