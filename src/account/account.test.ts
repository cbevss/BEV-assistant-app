import { describe, expect, it } from "vitest";
import {
  createVault,
  looksLikeRecoveryKey,
  newRecoveryKey,
  normaliseRecoveryKey,
  openRecord,
  recordId,
  recordKeys,
  rewrapPassphrase,
  sealRecord,
  unlockVault,
} from "./crypto";
import { emptyState, syncOnce, type LocalData, type Remote, type RemoteItem, type SyncState } from "./sync";

const FAST = { passphrase: 1000, recovery: 1000 };

describe("recovery key", () => {
  it("is 32 characters in groups of four and forgives typos people make", () => {
    const k = newRecoveryKey();
    expect(k).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(newRecoveryKey()).not.toBe(k);
    expect(normaliseRecoveryKey(k.toLowerCase().replace(/-/g, " "))).toBe(k.replace(/-/g, ""));
    expect(normaliseRecoveryKey("o0il")).toBe("0011");
    expect(looksLikeRecoveryKey(k)).toBe(true);
    expect(looksLikeRecoveryKey("my long passphrase")).toBe(false);
  });
});

describe("vault", () => {
  it("unlocks with the passphrase or the recovery key, and nothing else", async () => {
    const rk = newRecoveryKey();
    const { vault, dek } = await createVault("correct horse battery", rk, FAST);
    expect(JSON.stringify(vault)).not.toContain("correct horse");
    expect(await unlockVault(vault, "correct horse battery")).toEqual(dek);
    expect(await unlockVault(vault, rk.toLowerCase())).toEqual(dek);
    await expect(unlockVault(vault, "wrong passphrase!!")).rejects.toThrow(/wrong passphrase/);
  });

  it("refuses short passphrases and keeps the same key when the passphrase changes", async () => {
    await expect(createVault("short", newRecoveryKey(), FAST)).rejects.toThrow(/at least/);
    const rk = newRecoveryKey();
    const { vault, dek } = await createVault("first passphrase", rk, FAST);
    const next = await rewrapPassphrase(vault, dek, "second passphrase", 1000);
    expect(await unlockVault(next, "second passphrase")).toEqual(dek);
    await expect(unlockVault(next, "first passphrase")).rejects.toThrow();
    expect(await unlockVault(next, rk)).toEqual(dek);
  });
});

describe("records", () => {
  it("round-trips, and can't be read with another key or moved to another id", async () => {
    const { dek } = await createVault("a passphrase here", newRecoveryKey(), FAST);
    const keys = await recordKeys(dek);
    const id = await recordId(keys, "memory", "favourite_team");
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(id).not.toContain("favourite");
    expect(await recordId(keys, "memory", "favourite_team")).toBe(id);

    const sealed = await sealRecord(keys, "memory", id, { key: "favourite_team", value: "Arsenal" });
    expect(sealed.ct).not.toContain("Arsenal");
    expect(await openRecord(keys, "memory", id, sealed.iv, sealed.ct)).toEqual({ key: "favourite_team", value: "Arsenal" });

    const other = await recordKeys((await createVault("another passphrase", newRecoveryKey(), FAST)).dek);
    await expect(openRecord(other, "memory", id, sealed.iv, sealed.ct)).rejects.toThrow();
    await expect(openRecord(keys, "memory", "some-other-id-aaaa", sealed.iv, sealed.ct)).rejects.toThrow();
  });
});

// --- two devices through a fake server -------------------------------------

class FakeServer implements Remote {
  rows = new Map<string, RemoteItem & { seq: number }>();
  seq = 0;
  async pull(since: number) {
    const items = [...this.rows.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
    return { items: items.map(({ seq: _s, ...r }) => r), cursor: items.length ? items[items.length - 1].seq : since, more: false };
  }
  async push(items: RemoteItem[]) {
    for (const it of items) this.rows.set(it.id, { ...it, seq: ++this.seq });
    return { cursor: this.seq };
  }
}

class FakeDevice implements LocalData {
  mem = new Map<string, { value: string; category: string }>();
  noteRows = new Map<number, { title: string; body: string; source: string; tags: string }>();
  nextNote = 1;
  prof: Record<string, string> = { addressAs: "sir", personality: "casual", customPersonality: "" };
  noteWrites = 0;
  state: SyncState = emptyState("u1");
  async memories() {
    return [...this.mem].map(([key, v], i) => ({ key, ...v, localId: i }));
  }
  async putMemory(m: { key: string; value: string; category: string }) {
    this.mem.set(m.key, { value: m.value, category: m.category });
  }
  async deleteMemory(key: string) {
    this.mem.delete(key);
  }
  async notes() {
    return [...this.noteRows].map(([localId, n]) => ({ localId, ...n }));
  }
  async putNote(n: { title: string; body: string; source: string; tags: string }, localId?: number) {
    this.noteWrites++;
    const id = localId ?? this.nextNote++;
    this.noteRows.set(id, n);
    return id;
  }
  async deleteNote(id: number) {
    this.noteRows.delete(id);
  }
  async profile() {
    return { ...this.prof };
  }
  async putProfile(p: Record<string, string>) {
    this.prof = { ...p };
  }
}

async function setup() {
  const { dek } = await createVault("shared passphrase", newRecoveryKey(), FAST);
  const keys = await recordKeys(dek);
  const server = new FakeServer();
  const pc = new FakeDevice();
  const phone = new FakeDevice();
  phone.nextNote = 50; // local note ids differ between devices
  const sync = (d: FakeDevice) =>
    syncOnce(keys, d, server, d.state, async (s) => {
      d.state = s;
    });
  return { keys, server, pc, phone, sync };
}

describe("sync between devices", () => {
  it("moves memories, notes and the profile to a new device, encrypted on the way", async () => {
    const { server, pc, phone, sync } = await setup();
    pc.mem.set("favourite_team", { value: "Arsenal", category: "preferences" });
    await pc.putNote({ title: "Wi-Fi", body: "router in the hall", source: "user", tags: "" });
    pc.prof.addressAs = "boss";

    const first = await sync(pc);
    expect(first.pushed).toBe(3);
    expect(JSON.stringify([...server.rows.values()])).not.toMatch(/Arsenal|router|boss|favourite/);

    await sync(phone);
    expect(phone.mem.get("favourite_team")?.value).toBe("Arsenal");
    expect([...phone.noteRows.values()][0].title).toBe("Wi-Fi");
    expect([...phone.noteRows.keys()][0]).toBe(50);
    expect(phone.prof.addressAs).toBe("boss");
  });

  it("carries edits and deletions both ways without duplicating notes", async () => {
    const { pc, phone, sync, server } = await setup();
    pc.mem.set("car", { value: "Golf", category: "facts" });
    const pcNote = await pc.putNote({ title: "Plan", body: "v1", source: "user", tags: "" });
    await sync(pc);
    await sync(phone);

    // Edit on the phone, delete a memory on the phone.
    const phoneNote = [...phone.noteRows.keys()][0];
    phone.noteRows.set(phoneNote, { title: "Plan", body: "v2", source: "user", tags: "" });
    phone.mem.delete("car");
    await sync(phone);
    await sync(pc);
    expect(pc.noteRows.get(pcNote)?.body).toBe("v2");
    expect(pc.noteRows.size).toBe(1);
    expect(pc.mem.has("car")).toBe(false);

    // Delete the note on the PC: gone from the phone too.
    pc.noteRows.delete(pcNote);
    await sync(pc);
    await sync(phone);
    expect(phone.noteRows.size).toBe(0);
    // Server holds tombstones, not content.
    expect([...server.rows.values()].filter((r) => !r.deleted)).toHaveLength(1); // the profile
  });

  it("does nothing when nothing changed, and doesn't rewrite notes it already has", async () => {
    const { pc, sync } = await setup();
    await pc.putNote({ title: "Keep", body: "same", source: "user", tags: "" });
    await sync(pc);
    const writes = pc.noteWrites;
    const again = await sync(pc);
    expect(again.pushed).toBe(0);
    expect(pc.noteWrites).toBe(writes);
  });

  it("skips records it can't decrypt instead of failing the whole sync", async () => {
    const { server, phone, sync } = await setup();
    await server.push([{ id: "garbage-aaaaaaaaaaaa", kind: "memory", iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" }]);
    const r = await sync(phone);
    expect(r.unreadable).toBe(1);
    expect(phone.mem.size).toBe(0);
  });
});
