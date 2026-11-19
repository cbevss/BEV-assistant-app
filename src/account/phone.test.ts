import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn(async () => {}) }));
import { createVault, newRecoveryKey } from "./crypto";
import { phoneKey, sealPhone, openPhone, acceptFromPhone } from "./phoneCrypto";
import { feedItem, changedSince } from "./phone";

/** The phone page's own encryption code, taken from the page the service serves. */
function pageCrypto(userId: string) {
  const src = readFileSync(new URL("../../accounts/src/phone.ts", import.meta.url), "utf8");
  const script = src.slice(src.indexOf('"use strict";'), src.indexOf("</script>"));
  const helpers = script.slice(0, script.indexOf("// ---- tiny IndexedDB"));
  const enc = script.slice(script.indexOf("// ---- encryption"), script.indexOf("function sendToPc"));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function("userId", `var key=null;${helpers}${enc}return {unlockVault:unlockVault,phoneKey:phoneKey,seal:seal,openMsg:openMsg,setKey:function(k){key=k;}};`)(userId) as {
    unlockVault: (v: unknown, s: string) => Promise<Uint8Array>;
    phoneKey: (dek: Uint8Array) => Promise<CryptoKey>;
    seal: (o: unknown) => Promise<{ iv: string; ct: string }>;
    openMsg: (m: { iv: string; ct: string }) => Promise<unknown>;
    setKey: (k: CryptoKey) => void;
  };
}

describe("phone encryption", () => {
  it("the phone page and the PC understand each other, and nobody else", async () => {
    const recovery = newRecoveryKey();
    const { vault, dek } = await createVault("correct horse battery", recovery, { passphrase: 1000, recovery: 1000 });
    const page = pageCrypto("user-1");
    // The phone unlocks with the passphrase or the recovery key.
    const pageDek = await page.unlockVault(vault, "correct horse battery");
    expect([...pageDek]).toEqual([...dek]);
    expect([...(await page.unlockVault(vault, recovery.toLowerCase()))]).toEqual([...dek]);
    await expect(page.unlockVault(vault, "wrong passphrase")).rejects.toBeTruthy();
    page.setKey(await page.phoneKey(pageDek));
    const pc = await phoneKey(dek);

    // PC → phone
    const down = await sealPhone(pc, "to_phone", "user-1", { type: "feed", items: [{ id: "a", text: "hi" }] });
    expect(await page.openMsg(down)).toEqual({ type: "feed", items: [{ id: "a", text: "hi" }] });
    // phone → PC
    const up = await page.seal({ type: "ask", id: "abcdefgh12", t: 1, text: "pause the music" });
    expect(await openPhone(pc, "to_pc", "user-1", up.iv, up.ct)).toEqual({ type: "ask", id: "abcdefgh12", t: 1, text: "pause the music" });
    // Bound to direction and account: a relay can't bounce or move messages.
    await expect(openPhone(pc, "to_phone", "user-1", up.iv, up.ct)).rejects.toBeTruthy();
    await expect(openPhone(pc, "to_pc", "user-2", up.iv, up.ct)).rejects.toBeTruthy();
    await expect(pageCrypto("user-2").openMsg(down)).rejects.toBeTruthy();
  });

  it("drops stale, repeated or malformed messages from the phone", () => {
    const now = 1_000_000_000;
    const ask = { type: "ask", id: "abcdefgh12", t: now - 1000, text: " hi " };
    expect(acceptFromPhone(ask, now, new Set())).toEqual({ type: "ask", id: "abcdefgh12", t: now - 1000, text: "hi" });
    expect(acceptFromPhone(ask, now, new Set(["abcdefgh12"]))).toBeNull();
    expect(acceptFromPhone({ ...ask, t: now - 11 * 60_000 }, now, new Set())).toBeNull();
    expect(acceptFromPhone({ ...ask, t: now + 5 * 60_000 }, now, new Set())).toBeNull();
    expect(acceptFromPhone({ ...ask, text: "   " }, now, new Set())).toBeNull();
    expect(acceptFromPhone({ ...ask, id: "x" }, now, new Set())).toBeNull();
    expect(acceptFromPhone({ type: "approve", id: "abcdefgh13", t: now, re: "r1", allow: "yes" }, now, new Set())).toBeNull();
    expect(acceptFromPhone({ type: "approve", id: "abcdefgh13", t: now, re: "r1", allow: true }, now, new Set())).toMatchObject({ type: "approve", allow: true });
    expect(acceptFromPhone({ type: "screen", id: "abcdefgh14", t: now }, now, new Set())).toMatchObject({ type: "screen" });
    expect(acceptFromPhone({ type: "run_shell", id: "abcdefgh15", t: now }, now, new Set())).toBeNull();
    expect(acceptFromPhone(null, now, new Set())).toBeNull();
  });
});

describe("phone feed", () => {
  it("turns chat messages into feed items and only resends changes", () => {
    const msgs = [
      { id: "1", role: "user" as const, content: "pause music", at: 1, source: "phone" as const },
      { id: "2", role: "tool" as const, content: "pressed play/pause\nmore", toolName: "media_control", ok: true, at: 2 },
    ];
    expect(feedItem(msgs[0])).toEqual({ id: "1", role: "user", text: "pause music", at: 1, source: "phone" });
    expect(feedItem(msgs[1])).toMatchObject({ id: "2", role: "tool", label: "Controlled media", text: "pressed play/pause", ok: true });
    const sent = new Map([["1", "pause music|undefined"]]);
    expect(changedSince(msgs, sent).map((m) => m.id)).toEqual(["2"]);
    expect(changedSince([{ ...msgs[0], content: "pause music now" }], sent)).toHaveLength(1);
  });
});
