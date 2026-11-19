/**
 * The signed-in account: session, the data key kept on this PC, and sync.
 *
 * Status flow:
 *   off        accounts aren't switched on in this build (no service address)
 *   loading    reading what's saved on this PC
 *   signedOut  needs to sign in with Discord
 *   setup      signed in, first device: choose a passphrase, save the recovery key
 *   locked     signed in on a new device: unlock with passphrase or recovery key
 *   ready      everything works; sync runs in the background
 *
 * The app keeps working offline once a device is ready: the session and key
 * are on this PC, and sync catches up when the service is reachable again.
 */
import { create } from "zustand";
import { load, type Store } from "@tauri-apps/plugin-store";
import { native } from "@/lib/native";
import { useSettings } from "@/state/settings";
import { accountsEnabled } from "./config";
import { AccountError, api, signInWithDiscord, type AccountUser, type Device } from "./client";
import { createVault, fromB64, newRecoveryKey, recordKeys, rewrapPassphrase, toB64, unlockVault, type Vault } from "./crypto";
import { emptyState, syncOnce, type LocalData, type SyncState } from "./sync";

const SESSION = "bev_account_session";
const DATA_KEY = "bev_account_key";
const SYNC_EVERY_MS = 2 * 60_000;

export type AccountStatus = "off" | "loading" | "signedOut" | "setup" | "locked" | "ready";

interface AccountState {
  status: AccountStatus;
  user: AccountUser | null;
  devices: Device[];
  busy: boolean;
  error: string | null;
  lastSync: number | null;
  syncing: boolean;
  /** Shown once while setting up; never stored. */
  pendingRecoveryKey: string | null;
  init(): Promise<void>;
  signIn(): Promise<void>;
  startSetup(): void;
  finishSetup(passphrase: string): Promise<void>;
  unlock(secret: string): Promise<void>;
  syncNow(): Promise<void>;
  refreshDevices(): Promise<void>;
  signOutDevice(id: string): Promise<void>;
  changePassphrase(current: string, next: string): Promise<void>;
  signOut(): Promise<void>;
  deleteAccount(): Promise<void>;
  exportData(): Promise<string>;
}

let kv: Store | null = null;
const store = async () => (kv ??= await load("account.json", { autoSave: true }));
let timer: ReturnType<typeof setInterval> | null = null;
let syncRunning: Promise<void> | null = null;

const deviceName = () => "BEV on Windows";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** BEV's data on this PC, as sync sees it. */
export const localData: LocalData = {
  memories: async () => (await native.memoryList()).map((m) => ({ key: m.key, value: m.value, category: m.category, localId: m.id })),
  putMemory: (m) => native.memoryUpsert(m.key, m.value, m.category),
  deleteMemory: async (key) => {
    const row = (await native.memoryList()).find((m) => m.key === key);
    if (row) await native.memoryDelete(row.id);
  },
  notes: async () => (await native.notesList()).map((n) => ({ localId: n.id, title: n.title, body: n.body, source: n.source, tags: n.tags })),
  putNote: (n, localId) => native.noteSave({ id: localId, ...n }),
  deleteNote: (id) => native.noteDelete(id),
  // Who BEV is to you travels with your memories; devices, keys and app
  // permissions stay per PC.
  profile: async () => {
    const s = useSettings.getState().settings;
    return { addressAs: s.addressAs, personality: s.personality, customPersonality: s.customPersonality };
  },
  putProfile: async (p) => {
    const patch: Record<string, string> = {};
    for (const k of ["addressAs", "personality", "customPersonality"] as const) if (typeof p[k] === "string") patch[k] = p[k];
    await useSettings.getState().update(patch as never);
  },
};

async function token(): Promise<string | null> {
  return native.getSecret(SESSION).catch(() => null);
}

async function loadState(userId: string): Promise<SyncState> {
  const s = (await (await store()).get<SyncState>("sync")) ?? null;
  return s && s.userId === userId ? s : emptyState(userId);
}

async function saveState(s: SyncState) {
  await (await store()).set("sync", s);
}

/** Forget everything account-related on this PC (BEV's memories stay). */
async function forgetLocal() {
  await native.deleteSecret(SESSION).catch(() => {});
  await native.deleteSecret(DATA_KEY).catch(() => {});
  const s = await store();
  await s.delete("user");
  await s.delete("sync");
}

export const useAccount = create<AccountState>((set, get) => {
  /** A 401 means this device was signed out elsewhere (or the account deleted). */
  const handle = async (e: unknown) => {
    if (e instanceof AccountError && e.status === 401) {
      await forgetLocal();
      stopTimer();
      set({ status: "signedOut", user: null, error: "You were signed out. Sign in again to keep syncing." });
      return;
    }
    set({ error: message(e) });
  };

  const startTimer = () => {
    stopTimer();
    timer = setInterval(() => void get().syncNow(), SYNC_EVERY_MS);
    void get().syncNow();
  };

  const vaultAndGo = async (t: string) => {
    const vault = await api.getVault(t);
    set({ status: vault ? "locked" : "setup" });
  };

  return {
    status: accountsEnabled() ? "loading" : "off",
    user: null,
    devices: [],
    busy: false,
    error: null,
    lastSync: null,
    syncing: false,
    pendingRecoveryKey: null,

    async init() {
      if (!accountsEnabled()) return set({ status: "off" });
      const t = await token();
      const user = (await (await store()).get<AccountUser>("user")) ?? null;
      if (!t || !user) return set({ status: "signedOut", user: null });
      set({ user });
      if (await native.getSecret(DATA_KEY).catch(() => null)) {
        set({ status: "ready" });
        startTimer();
        return;
      }
      try {
        await vaultAndGo(t);
      } catch (e) {
        // Offline with no key yet: can't unlock until we can reach the service.
        set({ status: "locked" });
        await handle(e);
      }
    },

    async signIn() {
      set({ busy: true, error: null });
      try {
        const { token: t, user } = await signInWithDiscord(deviceName());
        await native.storeSecret(SESSION, t);
        await (await store()).set("user", user);
        set({ user });
        await vaultAndGo(t);
      } catch (e) {
        set({ error: message(e) });
      } finally {
        set({ busy: false });
      }
    },

    startSetup() {
      set({ pendingRecoveryKey: newRecoveryKey(), error: null });
    },

    async finishSetup(passphrase) {
      const rk = get().pendingRecoveryKey;
      const t = await token();
      if (!rk || !t) return;
      set({ busy: true, error: null });
      try {
        const { vault, dek } = await createVault(passphrase, rk);
        await api.putVault(t, vault);
        await native.storeSecret(DATA_KEY, toB64(dek));
        set({ status: "ready", pendingRecoveryKey: null });
        startTimer();
      } catch (e) {
        if (e instanceof AccountError && e.status === 409) {
          // Another device set it up meanwhile: unlock with that one instead.
          set({ status: "locked", pendingRecoveryKey: null, error: "This account was already set up on another device. Unlock it with that passphrase." });
        } else await handle(e);
      } finally {
        set({ busy: false });
      }
    },

    async unlock(secret) {
      const t = await token();
      if (!t) return set({ status: "signedOut" });
      set({ busy: true, error: null });
      try {
        const vault = await api.getVault(t);
        if (!vault) return set({ status: "setup" });
        const dek = await unlockVault(vault, secret.trim());
        await native.storeSecret(DATA_KEY, toB64(dek));
        set({ status: "ready" });
        startTimer();
      } catch (e) {
        await handle(e);
      } finally {
        set({ busy: false });
      }
    },

    async syncNow() {
      if (get().status !== "ready") return;
      if (syncRunning) return syncRunning;
      syncRunning = (async () => {
        set({ syncing: true });
        try {
          const t = await token();
          const raw = await native.getSecret(DATA_KEY);
          const user = get().user;
          if (!t || !raw || !user) return;
          const keys = await recordKeys(fromB64(raw));
          const state = await loadState(user.id);
          await syncOnce(keys, localData, { pull: (since) => api.pull(t, since), push: (items) => api.push(t, items) }, state, saveState);
          set({ lastSync: Date.now(), error: null });
        } catch (e) {
          // Offline is normal: keep working and try again later.
          if (e instanceof AccountError && e.status === 0) set({ error: null });
          else await handle(e);
        } finally {
          set({ syncing: false });
          syncRunning = null;
        }
      })();
      return syncRunning;
    },

    async refreshDevices() {
      const t = await token();
      if (!t) return;
      try {
        const r = await api.me(t);
        await (await store()).set("user", r.user);
        set({ user: r.user, devices: r.devices });
      } catch (e) {
        await handle(e);
      }
    },

    async signOutDevice(id) {
      const t = await token();
      if (!t) return;
      try {
        await api.signOutDevice(t, id);
        await get().refreshDevices();
      } catch (e) {
        await handle(e);
      }
    },

    async changePassphrase(current, next) {
      const t = await token();
      if (!t) return;
      set({ busy: true, error: null });
      try {
        const vault = await api.getVault(t);
        if (!vault) throw new Error("no vault found");
        const dek = await unlockVault(vault, current);
        await api.putVault(t, await rewrapPassphrase(vault, dek, next), true);
      } catch (e) {
        await handle(e);
        throw e;
      } finally {
        set({ busy: false });
      }
    },

    async signOut() {
      const t = await token();
      if (t) await api.logout(t).catch(() => {});
      await forgetLocal();
      stopTimer();
      set({ status: "signedOut", user: null, devices: [], lastSync: null });
    },

    async deleteAccount() {
      const t = await token();
      if (!t) return;
      set({ busy: true });
      try {
        await api.deleteAccount(t);
        await forgetLocal();
        stopTimer();
        set({ status: "signedOut", user: null, devices: [], lastSync: null });
      } catch (e) {
        await handle(e);
      } finally {
        set({ busy: false });
      }
    },

    async exportData() {
      const t = await token();
      if (!t) throw new Error("not signed in");
      return JSON.stringify(await api.exportAll(t), null, 2);
    },
  };
});

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

export type { Vault };
