/**
 * Two-way sync of BEV's memories, notes and profile with the accounts
 * service, end-to-end encrypted.
 *
 * Each pass: pull everything changed since our cursor and apply it, then push
 * what changed here since the last pass (spotted by fingerprints), including
 * deletions. When the same thing changed in two places between passes, the
 * version that reached the server first wins and the other device takes it.
 */
import { fingerprint, openRecord, recordId, sealRecord, type RecordKeys } from "./crypto";

export type Kind = "memory" | "note" | "profile";

export interface MemoryPayload {
  key: string;
  value: string;
  category: string;
}
export interface NotePayload {
  /** Stable id shared by every device (local note ids differ per device). */
  sid: string;
  title: string;
  body: string;
  source: string;
  tags: string;
}
export type ProfilePayload = Record<string, string>;

/** What sync needs from this device's data. */
export interface LocalData {
  memories(): Promise<Array<MemoryPayload & { localId: number }>>;
  putMemory(m: MemoryPayload): Promise<void>;
  deleteMemory(key: string): Promise<void>;
  notes(): Promise<Array<Omit<NotePayload, "sid"> & { localId: number }>>;
  /** Create (no id) or update a note; returns its local id. */
  putNote(n: Omit<NotePayload, "sid">, localId?: number): Promise<number>;
  deleteNote(localId: number): Promise<void>;
  profile(): Promise<ProfilePayload>;
  putProfile(p: ProfilePayload): Promise<void>;
}

export interface RemoteItem {
  id: string;
  kind: Kind;
  deleted?: boolean;
  iv?: string;
  ct?: string;
}

/** What sync needs from the server. */
export interface Remote {
  pull(since: number): Promise<{ items: RemoteItem[]; cursor: number; more: boolean }>;
  push(items: RemoteItem[]): Promise<{ cursor: number }>;
}

/** Remembered between passes (per account). */
export interface SyncState {
  userId: string;
  cursor: number;
  /** record id → fingerprint of what the server has */
  synced: Record<string, string>;
  /** record id → what it is here (memory key, or note sync id) */
  names: Record<string, { kind: Kind; name: string }>;
  /** note sync id → local note id */
  notes: Record<string, number>;
}

export const emptyState = (userId: string): SyncState => ({ userId, cursor: 0, synced: {}, names: {}, notes: {} });

export interface SyncResult {
  pulled: number;
  pushed: number;
  /** Records that couldn't be decrypted (another key, corruption): skipped. */
  unreadable: number;
}

const PUSH_BATCH = 200;
const newSyncId = () => crypto.randomUUID().replace(/-/g, "");

export async function syncOnce(keys: RecordKeys, local: LocalData, remote: Remote, state: SyncState, save: (s: SyncState) => Promise<void>): Promise<SyncResult> {
  const result: SyncResult = { pulled: 0, pushed: 0, unreadable: 0 };

  // 1. Pull and apply.
  for (let guard = 0; guard < 1000; guard++) {
    const page = await remote.pull(state.cursor);
    for (const it of page.items) {
      try {
        await applyRemote(keys, local, state, it);
        result.pulled++;
      } catch {
        result.unreadable++;
      }
    }
    state.cursor = page.cursor;
    await save(state);
    if (!page.more) break;
  }

  // 2. Push local changes.
  const out: Array<{ item: RemoteItem; fp?: string }> = [];
  const seen = new Set<string>();

  for (const m of await local.memories()) {
    const payload: MemoryPayload = { key: m.key, value: m.value, category: m.category };
    const id = await recordId(keys, "memory", m.key);
    seen.add(id);
    state.names[id] = { kind: "memory", name: m.key };
    const fp = await fingerprint(payload);
    if (state.synced[id] !== fp) out.push({ item: { id, kind: "memory", ...(await sealRecord(keys, "memory", id, payload)) }, fp });
  }

  const byLocal = new Map(Object.entries(state.notes).map(([sid, lid]) => [lid, sid]));
  for (const n of await local.notes()) {
    let sid = byLocal.get(n.localId);
    if (!sid) {
      sid = newSyncId();
      state.notes[sid] = n.localId;
    }
    const payload: NotePayload = { sid, title: n.title, body: n.body, source: n.source, tags: n.tags };
    const id = await recordId(keys, "note", sid);
    seen.add(id);
    state.names[id] = { kind: "note", name: sid };
    const fp = await fingerprint(payload);
    if (state.synced[id] !== fp) out.push({ item: { id, kind: "note", ...(await sealRecord(keys, "note", id, payload)) }, fp });
  }

  const profile = await local.profile();
  const pid = await recordId(keys, "profile", "profile");
  seen.add(pid);
  state.names[pid] = { kind: "profile", name: "profile" };
  const pfp = await fingerprint(profile);
  if (state.synced[pid] !== pfp) out.push({ item: { id: pid, kind: "profile", ...(await sealRecord(keys, "profile", pid, profile)) }, fp: pfp });

  // Deleted here since the last pass.
  for (const [id, n] of Object.entries(state.names)) {
    if (!seen.has(id) && state.synced[id] !== undefined) out.push({ item: { id, kind: n.kind, deleted: true } });
  }

  for (let i = 0; i < out.length; i += PUSH_BATCH) {
    const batch = out.slice(i, i + PUSH_BATCH);
    await remote.push(batch.map((b) => b.item));
    for (const b of batch) {
      if (b.item.deleted) {
        delete state.synced[b.item.id];
        const n = state.names[b.item.id];
        if (n?.kind === "note") delete state.notes[n.name];
        delete state.names[b.item.id];
      } else if (b.fp) state.synced[b.item.id] = b.fp;
    }
    // Our own writes come back on the next pull and match our fingerprints,
    // so applying them again is harmless.
    result.pushed += batch.length;
    await save(state);
  }
  return result;
}

async function applyRemote(keys: RecordKeys, local: LocalData, state: SyncState, it: RemoteItem): Promise<void> {
  const known = state.names[it.id];
  if (it.deleted) {
    if (known?.kind === "memory") await local.deleteMemory(known.name);
    if (known?.kind === "note") {
      const lid = state.notes[known.name];
      if (lid !== undefined) await local.deleteNote(lid);
      delete state.notes[known.name];
    }
    delete state.synced[it.id];
    delete state.names[it.id];
    return;
  }
  if (!it.iv || !it.ct) return;
  if (it.kind === "memory") {
    const m = await openRecord<MemoryPayload>(keys, "memory", it.id, it.iv, it.ct);
    if ((await recordId(keys, "memory", m.key)) !== it.id) throw new Error("memory id mismatch");
    const fp = await fingerprint({ key: m.key, value: m.value, category: m.category });
    // Our own write coming back: nothing to do.
    if (state.synced[it.id] !== fp) await local.putMemory({ key: m.key, value: m.value, category: m.category });
    state.names[it.id] = { kind: "memory", name: m.key };
    state.synced[it.id] = fp;
  } else if (it.kind === "note") {
    const n = await openRecord<NotePayload>(keys, "note", it.id, it.iv, it.ct);
    // The note's id must match its sync id, or it isn't what it claims to be.
    if (!n.sid || (await recordId(keys, "note", n.sid)) !== it.id) throw new Error("note id mismatch");
    const fp = await fingerprint({ sid: n.sid, title: n.title, body: n.body, source: n.source, tags: n.tags });
    // Re-saving an unchanged note would throw away its search embedding.
    if (state.synced[it.id] !== fp || state.notes[n.sid] === undefined) {
      state.notes[n.sid] = await local.putNote({ title: n.title, body: n.body, source: n.source, tags: n.tags }, state.notes[n.sid]);
    }
    state.names[it.id] = { kind: "note", name: n.sid };
    state.synced[it.id] = fp;
  } else if (it.kind === "profile") {
    const p = await openRecord<ProfilePayload>(keys, "profile", it.id, it.iv, it.ct);
    if (state.synced[it.id] !== (await fingerprint(p))) await local.putProfile(p);
    state.names[it.id] = { kind: "profile", name: "profile" };
    state.synced[it.id] = await fingerprint(await local.profile());
  }
}
