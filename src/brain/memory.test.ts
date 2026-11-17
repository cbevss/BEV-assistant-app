import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({ rows: [] as Array<{ id: number; key: string; value: string; category: string; updated_at: number }>, conv: [] as Array<[string, string, string]>, next: 1 }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
vi.mock("@/lib/native", () => ({
  native: {
    memoryList: vi.fn(async () => store.rows.map((r) => ({ ...r }))),
    memoryUpsert: vi.fn(async (key: string, value: string, category?: string) => {
      const r = store.rows.find((x) => x.key === key);
      if (r) Object.assign(r, { value, category: category ?? r.category });
      else store.rows.push({ id: store.next++, key, value, category: category ?? "general", updated_at: 0 });
    }),
    memoryDelete: vi.fn(async (id: number) => {
      store.rows = store.rows.filter((r) => r.id !== id);
    }),
    embeddingsList: vi.fn(async () => []),
    setEmbedding: vi.fn(async () => {}),
    convAdd: vi.fn(async (s: string, role: string, text: string) => {
      store.conv.push([s, role, text]);
      return 1;
    }),
  },
}));
vi.mock("./embed", () => ({ embed: vi.fn(async () => { throw new Error("no model in tests"); }), quickEmbed: vi.fn(async () => null), preloadEmbedder: vi.fn() }));

import { remember, closestMemory, recordExchange, memoriesForPrompt } from "./memory";
import { useSettings } from "@/state/settings";

beforeEach(() => {
  store.rows = [];
  store.conv = [];
  store.next = 1;
  useSettings.setState((s) => ({ settings: { ...s.settings, keepHistory: true, semanticSearch: true } }));
});

describe("remember", () => {
  it("saves, then updates the same key and reports the old value", async () => {
    expect(await remember("main browser", "Chrome")).toEqual({ kind: "saved" });
    const r = await remember("Main Browser", "Firefox");
    expect(r).toMatchObject({ kind: "saved", previous: "Chrome" });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].value).toBe("Firefox");
  });

  it("spots duplicates", async () => {
    await remember("main browser", "Chrome");
    expect((await remember("main browser", "chrome")).kind).toBe("duplicate");
  });

  it("flags a likely contradiction instead of saving", async () => {
    await remember("browser", "Chrome");
    const r = await remember("default browser", "Firefox");
    expect(r.kind).toBe("conflict");
    expect(store.rows).toHaveLength(1);
  });

  it("replaces or keeps both when told", async () => {
    await remember("browser", "Chrome");
    await remember("default browser", "Firefox", { replaces: 1 });
    expect(store.rows.map((r) => `${r.key}=${r.value}`)).toEqual(["default browser=Firefox"]);
    await remember("work browser", "Edge", { distinct: true });
    expect(store.rows).toHaveLength(2);
  });

  it("closestMemory ignores unrelated keys", () => {
    const rows = [{ id: 1, key: "favourite food", value: "pasta", category: "", updated_at: 0 }];
    expect(closestMemory("favourite colour", rows)).toBeNull();
    expect(closestMemory("favourite food dish", rows)?.row.id).toBe(1);
  });
});

describe("history", () => {
  it("records both sides, never secrets, and nothing when off", async () => {
    await recordExchange("what's my router admin page", "It's 192.168.1.1.");
    expect(store.conv.map((c) => c[1])).toEqual(["user", "assistant"]);
    await recordExchange("card 4111 1111 1111 1111", "ok");
    expect(store.conv[2][2]).toMatch(/not saved/);
    useSettings.setState((s) => ({ settings: { ...s.settings, keepHistory: false } }));
    await recordExchange("hello", "hi");
    expect(store.conv).toHaveLength(4);
  });
});

describe("memoriesForPrompt", () => {
  it("includes everything when there are few, the relevant ones first when many", async () => {
    for (let i = 0; i < 5; i++) await remember(`thing ${i}`, `value ${i}`, { distinct: true });
    expect(await memoriesForPrompt("anything")).toHaveLength(5);
    for (let i = 0; i < 60; i++) store.rows.push({ id: 100 + i, key: `filler ${i}`, value: "x", category: "", updated_at: 0 });
    store.rows.push({ id: 999, key: "car", value: "VW Golf", category: "", updated_at: 0 });
    const picked = await memoriesForPrompt("what car do I drive");
    expect(picked).toHaveLength(40);
    expect(picked[0].id).toBe(999);
  });
});
