import builtInUrl from "./models/hey_bev.onnx?url";
import { loadWakeModels, removeWakeModel, fromBase64, toBase64, type StoredWakeModel } from "./model-store";

/** The "hey BEV" model that ships with BEV, so nobody has to train one. */
export const BUILT_IN_PHRASE = "hey BEV";

let builtIn: Promise<Uint8Array> | null = null;

export function builtInModel(): Promise<Uint8Array> {
  return (builtIn ??= fetch(builtInUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`built-in wake model missing (${r.status})`);
      return r.arrayBuffer();
    })
    .then((b) => new Uint8Array(b))
    .catch((e) => {
      builtIn = null; // let a later attempt retry
      throw e;
    }));
}

/**
 * The user's own models. A stored copy of the built-in model (people who
 * loaded the same hey_bev.onnx before it shipped) is dropped, so it isn't
 * listed or run twice.
 */
export async function customWakeModels(): Promise<StoredWakeModel[]> {
  let list = await loadWakeModels();
  const ref = await builtInModel().then(toBase64).catch(() => null);
  if (ref) {
    for (const m of list.filter((x) => x.base64 === ref)) list = await removeWakeModel(m.name);
  }
  return list;
}

/** Every model the on-device engine should listen with. */
export async function activeWakeModels(useBuiltIn: boolean): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  if (useBuiltIn) out.push(await builtInModel());
  for (const m of await customWakeModels()) out.push(fromBase64(m.base64));
  return out;
}

/** Back to the shipped setup: built-in "hey BEV" only. */
export async function revertWakeModels(): Promise<void> {
  for (const m of await loadWakeModels()) await removeWakeModel(m.name);
}
