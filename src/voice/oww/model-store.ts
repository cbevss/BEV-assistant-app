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

/**
 * All loaded wake-phrase models. Older versions kept a single model under
 * "model"; that one is moved into the list on first read.
 */
export async function loadWakeModels(): Promise<StoredWakeModel[]> {
  try {
    const st = await getStore();
    const list = (await st.get<StoredWakeModel[]>("models")) ?? [];
    const legacy = await st.get<StoredWakeModel>("model");
    if (legacy) {
      const merged = list.some((m) => m.name === legacy.name) ? list : [legacy, ...list];
      await st.set("models", merged);
      await st.delete("model");
      return merged;
    }
    return list;
  } catch {
    return [];
  }
}

/** Add a model; one with the same file name replaces the old copy. */
export async function addWakeModel(m: StoredWakeModel): Promise<StoredWakeModel[]> {
  const list = (await loadWakeModels()).filter((x) => x.name !== m.name);
  list.push(m);
  await (await getStore()).set("models", list);
  return list;
}

export async function removeWakeModel(name: string): Promise<StoredWakeModel[]> {
  const list = (await loadWakeModels()).filter((x) => x.name !== name);
  await (await getStore()).set("models", list);
  return list;
}

/** "yo_bev.onnx" → "yo BEV", for showing which phrases BEV answers to. */
export function phraseFromFile(name: string): string {
  const base = name.replace(/\.onnx$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return base.replace(/\bbev\b/gi, "BEV") || name;
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
