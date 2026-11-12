import { create } from "zustand";
import { load, Store } from "@tauri-apps/plugin-store";
import type { Routine } from "./types";
import { builtInRoutines } from "./templates";

let store: Store | null = null;
const getStore = async () => (store ??= await load("routines.json", { autoSave: true }));

interface RoutineStore {
  routines: Routine[];
  loaded: boolean;
  init: () => Promise<void>;
  save: (r: Routine) => Promise<void>;
  remove: (id: string) => Promise<void>;
  markRun: (id: string) => Promise<void>;
}

async function persist(routines: Routine[]) {
  try {
    await (await getStore()).set("routines", routines);
  } catch {
    /* in-memory still applies (e.g. browser preview) */
  }
}

export const useRoutines = create<RoutineStore>((set, get) => ({
  routines: [],
  loaded: false,

  init: async () => {
    try {
      const saved = await (await getStore()).get<Routine[]>("routines");
      if (saved && saved.length) {
        set({ routines: saved, loaded: true });
        return;
      }
    } catch {
      /* fall through to defaults */
    }
    const defaults = builtInRoutines();
    set({ routines: defaults, loaded: true });
    await persist(defaults);
  },

  save: async (r) => {
    const exists = get().routines.some((x) => x.id === r.id);
    const routines = exists ? get().routines.map((x) => (x.id === r.id ? r : x)) : [...get().routines, r];
    set({ routines });
    await persist(routines);
  },

  remove: async (id) => {
    const routines = get().routines.filter((x) => x.id !== id);
    set({ routines });
    await persist(routines);
  },

  markRun: async (id) => {
    const routines = get().routines.map((x) => (x.id === id ? { ...x, lastRunAt: Date.now() } : x));
    set({ routines });
    await persist(routines);
  },
}));

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/^(hey |yo |ok |okay )?bev[,!.]?\s*/i, "")
    .replace(/^(please |can you |could you )?(activate |run |start |enable |do |go )?/i, "")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Direct voice match: if the utterance IS a routine trigger (allowing "BEV,",
 * "activate", "run", trailing punctuation), return it — no AI round-trip, so
 * routines fire instantly and work offline.
 */
export function matchRoutine(utterance: string, routines: Routine[]): Routine | null {
  const u = norm(utterance);
  if (!u) return null;
  for (const r of routines) {
    if (!r.enabled) continue;
    const names = [r.name, ...r.triggers].map(norm);
    if (names.includes(u)) return r;
  }
  return null;
}

export function findRoutineByName(name: string, routines: Routine[]): Routine | null {
  const n = norm(name);
  return (
    routines.find((r) => norm(r.name) === n || r.triggers.map(norm).includes(n)) ??
    routines.find((r) => norm(r.name).includes(n) || n.includes(norm(r.name))) ??
    null
  );
}
