import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
vi.mock("@/brain/memory", () => ({ saveNote: vi.fn(), deleteNote: vi.fn() }));
import { listTitle, parseItems, addItems, removeItems, formatItems } from "./lists";

describe("lists", () => {
  it("names lists consistently", () => {
    expect(listTitle("my shopping list")).toBe("Shopping list");
    expect(listTitle("Shopping")).toBe("Shopping list");
    expect(listTitle("")).toBe("To-do list");
  });
  it("reads any bullet style and writes dashes", () => {
    expect(parseItems("- milk\n* eggs\n1. bread\n[x] jam\n\n• tea")).toEqual(["milk", "eggs", "bread", "jam", "tea"]);
    expect(formatItems(["a", "b"])).toBe("- a\n- b");
  });
  it("adds without duplicates and removes by name", () => {
    expect(addItems(["Milk"], ["milk", "eggs", "Eggs", " "])).toEqual({ items: ["Milk", "eggs"], added: ["eggs"] });
    expect(removeItems(["semi-skimmed milk", "eggs", "bread"], ["milk", "jam"])).toEqual({ items: ["eggs", "bread"], removed: ["semi-skimmed milk"], notFound: ["jam"] });
    expect(removeItems(["white bread", "brown bread"], ["bread"]).notFound).toEqual(["bread"]);
  });
});
