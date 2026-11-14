import { load, Store } from "@tauri-apps/plugin-store";

/**
 * The user's trained wake-word model (.onnx), kept in its own store file so
 * the settings broadcast to the overlay stays small. Stored as base64.
 */
export interface StoredWakeModel {
  name: string;
  base64: string;
  addedAt: number;
}

let store: Store | null = null;
const getStore = async () => (store ??= await load("wakeword.json", { autoSave: true }));

export async function loadWakeModel(): Promise<StoredWakeModel | null> {
  try {
    return (await (await getStore()).get<StoredWakeModel>("model")) ?? null;
  } catch {
    return null;
  }
}

export async function saveWakeModel(m: StoredWakeModel): Promise<void> {
  await (await getStore()).set("model", m);
}

export async function clearWakeModel(): Promise<void> {
  await (await getStore()).delete("model");
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
